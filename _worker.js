import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
let cachedUserID;
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return await resOverWSHandler(request);
            }
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`: {
                    const config = getConfig(userID, request.headers.get('Host'));
                    return new Response(config, {
                        status: 200,
                        headers: { "Content-Type": "text/plain;charset=utf-8" },
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
async function resOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    await readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) return udpWrite(chunk);          
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
                resVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processResHeader(chunk, userID);
            if (hasError) return;
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    return;
                }
            }
            const resHeader = new Uint8Array([resVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        }
    })).catch(() => closeWebSocket(webSocket));
    return new Response(null, { status: 101, webSocket: client });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = await connect({ hostname: address, port });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    if (!await tryConnect(addressRemote, portRemote) && !await tryConnect(proxyIP, portRemote)) {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (isCancel) return;
                const message = event.data;
                controller.enqueue(message);
            });
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (isCancel) return;
                controller.close();
            });
            webSocket.addEventListener('error', (err) => {
                controller.error(err);
            });
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {
        },
        cancel(reason) {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
    return stream;
}
function processResHeader(resBuffer, userID) {
    if (resBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(resBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(resBuffer.slice(1, 17));
    if (bufferUserID.some((byte, index) => byte !== cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
    const command = new Uint8Array(resBuffer.slice(18 + optLength, 19 + optLength))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portRemote = new DataView(resBuffer.slice(18 + optLength + 1, 20 + optLength)).getUint16(0);
    const addressType = new Uint8Array(resBuffer.slice(20 + optLength, 21 + optLength))[0];
    let addressValue = '';
    let addressValueIndex = 21 + optLength;
    let addressLength = 0;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from(new DataView(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)), 
              (item, index) => item.getUint16(index * 2).toString(16)).join(':');
            break;
        default:
            return { hasError: true };
    }
    if (!addressValue) return { hasError: true };
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        resVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                controller.error('WebSocket is closed');
            }
            let bufferToSend;
            if (resHeader) {
                bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                bufferToSend.set(resHeader);
                bufferToSend.set(chunk, resHeader.byteLength);
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
    if (!base64Str) return { error: null };
    const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(normalizedStr);
    const length = binaryStr.length;
    const arrayBuffer = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
        arrayBuffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: arrayBuffer.buffer, error: null };
}
function closeWebSocket(socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const writer = new WritableStream({
        async write(chunk) {
            try {
                const dnsResponse = await queryDNS(chunk);
                if (dnsResponse && webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(queryDNSResponse(resHeader, dnsResponse, headerSent));
                    headerSent = true;
                }
            } catch (error) {
                closeWebSocket(webSocket);
            }
        }
    }).getWriter();
    return { write: chunk => writer.write(chunk).catch(console.error) };
}
async function queryDNS(dnsRequest) {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsRequest
    });
    return response.arrayBuffer();
}
function queryDNSResponse(resHeader, dnsResponse, headerSent) {
    const sizeBuffer = new Uint8Array([(dnsResponse.byteLength >> 8) & 0xff, dnsResponse.byteLength & 0xff]);
    const headerLength = headerSent ? 0 : resHeader.byteLength;
    const resPayload = new Uint8Array(headerLength + sizeBuffer.byteLength + dnsResponse.byteLength);
    if (!headerSent) resPayload.set(resHeader);
    resPayload.set(sizeBuffer, headerLength);
    resPayload.set(new Uint8Array(dnsResponse), headerLength + sizeBuffer.byteLength);
    return resPayload;
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
