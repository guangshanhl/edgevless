import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
const BUFFER_SIZE = 65536;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const webSocketCache = new Map();
export default {
    async fetch(request, env, ctx) {
        userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;
        try {
            if (request.headers.get('Upgrade') === 'websocket') {
                return await webSocketHandler(request);
            }
            const url = new URL(request.url);
            const handler = routeHandler(url.pathname, request, userID);
            return handler ? handler() : new Response('Not found', { status: 404 });
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
function routeHandler(pathname, request, userID) {
    const routes = new Map([
        ['/', () => rootRequest(request)],
        [`/${userID}`, () => userRequest(request, userID)]
    ]);
    return routes.get(pathname);
}
function rootRequest(request) {
    return new Response(JSON.stringify(request.cf), {
        headers: { 'Content-Type': 'application/json' }
    });
}
function userRequest(request, userID) {
    const config = getConfig(userID, request.headers.get('Host'));
    return new Response(config, {
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
}
async function getWebSocketConnection(remoteAddress, remotePort) {
    const key = `${remoteAddress}:${remotePort}`;
    if (webSocketCache.has(key)) {
        return webSocketCache.get(key);
    }
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    webSocketCache.set(key, server);
    return client;
}
async function webSocketHandler(request) {
    const webSocket = await getWebSocketConnection(remoteAddress, remotePort);
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeWebSocketStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) {
                const chunkArray = chunkData(chunk, BUFFER_SIZE);
                for (const subdata of chunkArray) {
                    udpWrite(subdata);
                }
                return;
            }
            if (remoteSocket.value) {
                await writeToSocket(remoteSocket.value, chunk);
                return;
            }
            const {
                hasError,
                portRemote = 8443,
                addressRemote = '',
                rawDataIndex,
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    return;
                }
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
        remoteSocket.value = connect({
            hostname: address,
            port: port,
            secureTransport: "on",
            allowHalfOpen: true
        });
        await writeToSocket(remoteSocket.value, clientData);
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    const connected = await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote);
    if (!connected) {
        closeWebSocket(webSocket);
    }
}
function makeWebSocketStream(webSocket, earlyHeader) {
    let isActive = true;
    const stream = new ReadableStream({
        start(controller) {
            const messageHandler = (event) => {
                if (!isActive) return;
                const message = event.data;
                if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
                    const chunkArray = chunkData(message, BUFFER_SIZE);
                    for (const chunk of chunkArray) {
                        controller.enqueue(chunk);
                    }
                } else {
                    controller.enqueue(message);
                }
            };
            const handleError = (error) => {
                if (!isActive) return;
                controller.error(error);
                isActive = false;
            };
            const handleClose = () => {
                if (!isActive) return;
                closeWebSocket(webSocket);
                controller.close();
                isActive = false;
            };
            webSocket.addEventListener('message', messageHandler);
            webSocket.addEventListener('close', handleClose);
            webSocket.addEventListener('error', handleError);
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (error) {
                    handleError(error);
                } else if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
            return () => {
                isActive = false;
                webSocket.removeEventListener('message', messageHandler);
                webSocket.removeEventListener('close', handleClose);
                webSocket.removeEventListener('error', handleError);
                closeWebSocket(webSocket);
            };
        },
        pull(controller) {
            return Promise.resolve();
        },
        cancel(reason) {
            isActive = false;
            closeWebSocket(webSocket);
        }
    }, {
        highWaterMark: BUFFER_SIZE,
        size(chunk) {
            return chunk.byteLength || 1;
        }
    });
    return stream;
}
let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new DataView(ressBuffer, 0, 1).getUint8(0);
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer, 1, 16);
    if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = new DataView(ressBuffer, 17, 1).getUint8(0);
    const command = new DataView(ressBuffer, 18 + optLength, 1).getUint8(0);
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer, portIndex, 2).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(ressBuffer, addressIndex, 1).getUint8(0);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer, addressValueIndex, addressLength).join('.');
            break;
        case 2:
            addressLength = new DataView(ressBuffer, addressValueIndex, 1).getUint8(0);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                new Uint8Array(ressBuffer, addressValueIndex, addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const ipv6Parts = new Uint16Array(ressBuffer, addressValueIndex, addressLength / 2);
            addressValue = Array.from(ipv6Parts, part => part.toString(16)).join(':');
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
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk, controller) {
                let chunkHeader;               
                if (resHeader) {
                    chunkHeader = mergeUint8Arrays(resHeader, chunk);
                    resHeader = null;
                } else {
                    chunkHeader = chunk;
                }
                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    const chunkArray = chunkData(chunkHeader, BUFFER_SIZE);
                    for (const subdata of chunkArray) {
                        webSocket.send(subdata);
                    }
                    hasData = true;
                }
            }
        }));
    } catch (error) {
        closeWebSocket(webSocket);
    }
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
async function writeToSocket(socket, data) {
    const writer = socket.writable.getWriter();
    try {
        const chunkArray = chunkData(data, BUFFER_SIZE);
        for (const chunk of chunkArray) {
            await writer.write(chunk);
        }
    } finally {
        writer.releaseLock();
    }
}
function chunkData(data, size) {
    const chunks = [];
    for (let offset = 0; offset < data.byteLength; offset += size) {
        chunks.push(new Uint8Array(data.slice(offset, offset + size)));
    }
    return chunks;
}
function mergeUint8Arrays(...arrays) {
    const totalLength = arrays.reduce((acc, val) => acc + val.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    arrays.forEach(arr => {
        result.set(arr, offset);
        offset += arr.byteLength;
    });
    return result;
}
function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partialChunk = null;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partialChunk) {
                chunk = mergeUint8Arrays(partialChunk, chunk);
                partialChunk = null;
            }
            processChunk(chunk, controller);
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/dns-message',
                    'Accept': 'application/dns-message'
                },
                body: chunk
            });
            const dnsQueryResult = await response.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([
                (dnsQueryResult.byteLength >> 8) & 0xff,
                dnsQueryResult.byteLength & 0xff
            ]);
            const payload = headerSent 
                ? mergeUint8Arrays(udpSizeBuffer, new Uint8Array(dnsQueryResult))
                : mergeUint8Arrays(resHeader, udpSizeBuffer, new Uint8Array(dnsQueryResult));
            headerSent = true;
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    })).catch(closeWebSocket(webSocket));
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            const chunkArray = chunkData(chunk, BUFFER_SIZE);
            for (const subdata of chunkArray) {
                writer.write(subdata);
            }
        }
    };
}
function processChunk(chunk, controller) {
    let offset = 0;
    while (offset < chunk.byteLength) {
        if (chunk.byteLength < offset + 2) {
            partialChunk = chunk.slice(offset);
            break;
        }
        const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset).getUint16(0);
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
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
