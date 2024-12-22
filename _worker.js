import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP; 
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader && upgradeHeader === 'websocket') {
                return await ressOverWSHandler(request);
            }                       
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`: {
                    const config = getConfig(userID, request.headers.get('Host'));
                    return new Response(config, {
                        status: 200,
                        headers: {
                            "Content-Type": "text/plain;charset=utf-8"
                        },
                    });
                }
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function ressOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const {
                hasError,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);
            address = addressRemote;
            if (hasError) {
                return;
            }          
            if (isUDP) {
                if (portRemote !== 53) {
                    return;
                }
                isDns = true;
            }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        remoteSocket.value = connect({ hostname: address, port });
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    if (!(await tryConnect(addressRemote, portRemote)) && !(await tryConnect(proxyIP, portRemote))) {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    const handleMessage = (event, controller) => {
        if (!isCancel) {
            controller.enqueue(event.data);
        }
    };
    const handleClose = (controller) => {
        if (!isCancel) {
            controller.close();
            closeWebSocket(webSocket);
        }
    };
    const handleError = (err, controller) => {
        controller.error(err);
        closeWebSocket(webSocket);
    };
    const stream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => handleMessage(event, controller));
            webSocket.addEventListener('close', () => handleClose(controller));
            webSocket.addEventListener('error', (err) => handleError(err, controller));
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel(reason) {
            if (!isCancel) {
                isCancel = true;
                closeWebSocket(webSocket);
            }
        }
    });
    return stream;
}
let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) {
        return { hasError: true };
    }
    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = ressBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('WebSocket is closed');
            }
            let bufferToSend;
            if (resHeader) {
                const resHeaderArray = new Uint8Array(resHeader);
                bufferToSend = new Uint8Array(resHeaderArray.byteLength + chunk.byteLength);
                bufferToSend.set(resHeader, 0);
                bufferToSend.set(chunk, resHeaderArray.byteLength);
                resHeader = null;
            } else {
                bufferToSend = chunk;
            }
            webSocket.send(bufferToSend);
            hasData = true;
        },
    })).catch((error) => {
        closeWebSocket(webSocket);
    });
    return hasData;
}
function base64ToBuffer(base64Str) {
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const length = binaryStr.length;
        const arrayBuffer = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}
function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partChunk = null;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partChunk) {
                chunk = new Uint8Array([...partChunk, ...chunk]);
                partChunk = null;
            }
            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partChunk = chunk.slice(offset);
                    break;
                }
                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;
                if (chunk.byteLength < nextOffset) {
                    partChunk = chunk.slice(offset);
                    break;
                }
                const udpData = chunk.slice(offset + 2, nextOffset);
                offset = nextOffset;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            const payload = headerSent
                ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
            headerSent = true;
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    }));
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
