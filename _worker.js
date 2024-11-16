import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;        
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf), { status: 200 });
                    case `/${userID}`: {
                        const config = getConfig(userID, request.headers.get('Host'));
                        return new Response(config, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            },
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function vlessOverWSHandler(request) {
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
                vlessVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processVlessHeader(chunk, userID);
            address = addressRemote;
            if (hasError) {
                return;
            }
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    return;
                }
            }
            const responseHeader = new Uint8Array([vlessVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, responseHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, responseHeader);
        },
        close() {},
        abort(reason) {},
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, responseHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({
                hostname: address,
                port: port
            });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, responseHeader);
    }
    try {
        if (!await tryConnect(addressRemote, portRemote)) {
            if (!await tryConnect(proxyIP, portRemote)) {
                closeWebSocket(webSocket);
            }
        }
    } catch (error) {
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
                console.error('WebSocket error:', err);
                controller.error(err);
            });
            const { earlyData, error } = base64ToArrayBuffer(earlyHeader);
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
let cachedUserIDBytes;
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserIDBytes) {
        cachedUserIDBytes = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(vlessBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserIDBytes[index]);
    if (hasError) {
        return { hasError: true };
    }
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }
    if (!addressValue) {
        return { hasError: true };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, responseHeader) {
    let hasData = false;
    let vlessHeader = responseHeader;
    await remoteSocket.readable.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                hasData = true;
                if (webSocket.readyState !== WebSocket.OPEN) {
                    controller.error('WebSocket is closed');
                }
                if (vlessHeader) {
                    const combinedBuffer = new Uint8Array(vlessHeader.byteLength + chunk.byteLength);
                    combinedBuffer.set(vlessHeader, 0);
                    combinedBuffer.set(chunk, vlessHeader.byteLength);
                    webSocket.send(combinedBuffer.buffer);
                    vlessHeader = null;
                } else {
                    webSocket.send(chunk.buffer);
                }
            },
            close() {
            },
            abort(reason) {
            }
        })
    ).catch((error) => {
        closeWebSocket(webSocket);
    });
    return hasData;
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
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
const WEBSOCKET_READY_STATE = {
    OPEN: 1,
    CLOSING: 2
};
function closeWebSocket(socket) {
    if (socket.readyState === WEBSOCKET_READY_STATE.OPEN || socket.readyState === WEBSOCKET_READY_STATE.CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, responseHeader) {
    let isHeaderSent = false;
    let partialChunk = null;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partialChunk) {
                chunk = new Uint8Array([...partialChunk, ...chunk]);
                partialChunk = null;
            }
            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partialChunk = chunk.slice(offset);
                    break;
                }
                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;
                if (chunk.byteLength < nextOffset) {
                    partialChunk = chunk.slice(offset);
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
            try {
                const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/dns-message' },
                    body: chunk
                });
                const dnsQueryResult = await resp.arrayBuffer();
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                const payload = isHeaderSent
                    ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                    : new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(payload.buffer);
                    isHeaderSent = true;
                }
            } catch (error) {
            }
        }
    })).catch((error) => {
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getVLESSConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
