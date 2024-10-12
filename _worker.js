import {
    connect
}
from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            const isWebSocket = request.headers.get('Upgrade') === 'websocket';
            if (isWebSocket) {
                return handleWsRequest(request, userID, proxyIP);
            }
            return handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/")
        return new Response(JSON.stringify(request.cf, null, 4));
    if (path === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            }
        });
    }
    return new Response("Not found", {
        status: 404
    });
};
const handleWsRequest = async(request, userID, proxyIP) => {
    const webSocketPair = new WebSocketPair();
    const clientSocket = webSocketPair[0];
    const serverSocket = webSocketPair[1];
    serverSocket.accept();
    const protocols = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, protocols);
    let remoteSocket = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;
    const responseHeader = new Uint8Array(2);
    readableStream.pipeTo(
        new WritableStream({
            async write(chunk) {
                if (isDns && udpStreamWrite) {
                    await udpStreamWrite(chunk);
                    return;
                }
                if (remoteSocket.value) {
                    await writeToRemote(remoteSocket.value, chunk);
                    return;
                }
                const {
                    hasError,
                    addressRemote,
                    portRemote,
                    rawDataIndex,
                    vlessVersion,
                    isUDP,
                } = processWebSocketHeader(chunk, userID);
                if (hasError)
                    return;
                responseHeader[0] = vlessVersion[0];
                responseHeader[1] = 0;
                const rawClientData = chunk.slice(rawDataIndex);
                if (isDns) {
                    udpStreamWrite = await handleUdpRequest(serverSocket, responseHeader, rawClientData);
                } else {
                    handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP);
                }
            },
        }), );
    return new Response(null, {
        status: 101,
        webSocket: clientSocket,
    });
};
const writeToRemote = async(socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async(remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({
            hostname: address,
            port,
        });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP) => {
    try {
        const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
        await forwardToData(tcpSocket, serverSocket, responseHeader, async() => {
            const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP, portRemote, rawClientData);
            await forwardToData(fallbackSocket, serverSocket, responseHeader);
        });
    } catch (error) {
        closeWebSocket(serverSocket);
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    const readableStream = new ReadableStream({
        start(controller) {
            const {
                earlyData,
                error
            } = base64ToBuffer(earlyDataHeader);
            if (error)
                return controller.error(error);
            if (earlyData)
                controller.enqueue(earlyData);
            const onMessage = (event) => controller.enqueue(event.data);
            const onClose = () => {
                controller.close();
                removeWebSocketListeners();
            };
            const onError = (error) => {
                controller.error(error);
                removeWebSocketListeners();
            };
            serverSocket.addEventListener('message', onMessage);
            serverSocket.addEventListener('close', onClose);
            serverSocket.addEventListener('error', onError);
            const cleanup = () => {
                removeWebSocketListeners();
                serverSocket.removeEventListener('message', onMessage);
                serverSocket.removeEventListener('close', onClose);
                serverSocket.removeEventListener('error', onError);
            };
            return cleanup;
        },
        cancel() {
            const cleanup = this.__cleanup;
            cleanup();
        }
    });
    const removeWebSocketListeners = (socket) => {
        eventListeners.forEach(({
                event,
                handler
            }) => {
            socket.removeEventListener(event, handler);
        });
        eventListeners.clear();
    };
    return readableStream;
};
const processWebSocketHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const receivedID = stringify(buffer.slice(1, 17));
    if (receivedID !== userID) {
        return {
            hasError: true,
        };
    }
    const optLength = view.getUint8(17);
    const startIndex = 18 + optLength;
    const command = view.getUint8(startIndex);
    const isUDP = command === 2;
    const portRemote = view.getUint16(startIndex + 1);
    const version = new Uint8Array(buffer.slice(0, 1));
    const {
        addressRemote,
        rawDataIndex
    } = getAddressInfo(view, buffer, startIndex + 3);
    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex,
        vlessVersion: version,
        isUDP,
    };
};
const getAddressInfo = (view, buffer, startIndex) => {
    const addressType = view.getUint8(startIndex);
    const addressLength = addressType === 2 ? view.getUint8(startIndex + 1) : (addressType === 1 ? 4 : 16);
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = addressType === 1
         ? Array.from(buffer.slice(addressValueIndex, addressValueIndex + 4)).join('.')
         : addressType === 2
         ? new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength))
         : Array.from(buffer.slice(addressValueIndex, addressValueIndex + 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return {
        addressRemote: addressValue,
        rawDataIndex: addressValueIndex + addressLength,
    };
};
const forwardToData = async(remoteSocket, serverSocket, responseHeader, retry) => {
    if (serverSocket.readyState !== WebSocket.OPEN) {
        closeWebSocket(serverSocket);
        return;
    }
    const CHUNK_SIZE = 512 * 1024;
    let remainingData = responseHeader ? responseHeader.length : 0;
    const buffer = new Uint8Array(CHUNK_SIZE);
    const sendChunk = (data, offset = 0, length = data.byteLength) => {
        for (let i = offset; i < length; i += CHUNK_SIZE) {
            const end = Math.min(i + CHUNK_SIZE, length);
            serverSocket.send(data.slice(i, end));
        }
    };
    try {
        for await(const chunk of remoteSocket.readable) {
            if (remainingData) {
                const remaining = Math.min(chunk.byteLength, remainingData);
                buffer.set(responseHeader, 0, remainingData);
                buffer.set(new Uint8Array(chunk), remainingData);
                sendChunk(buffer, 0, remaining + chunk.byteLength);
                remainingData -= remaining;
                responseHeader = null;
            } else {
                sendChunk(chunk);
            }
        }
    } catch (error) {
        closeWebSocket(serverSocket);
    }
    if (!remainingData && retry) {
        retry();
    }
};
const BASE64_REPLACE_REGEX = /[-_]/g;
const replaceBase64Chars = (str) =>
str.replace(BASE64_REPLACE_REGEX, match => (match === '-' ? '+' : '/'));
const base64ToBuffer = (base64Str) => {
    try {
        const binaryStr = atob(replaceBase64Chars(base64Str));
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return {
            earlyData: buffer.buffer,
            error: null,
        };
    } catch (error) {
        return {
            error,
        };
    }
};
const byteToHex = [...Array(256)].map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    const hex = arr.slice(offset).map(byte => byteToHex[byte]).join('');
    return segments.map(len => hex.slice(0, len)).join('-').toLowerCase();
};
const handleUdpRequest = async(serverSocket, responseHeader, rawClientData) => {
    const dnsCache = new Map();
    const BATCH_SIZE = 5;
    const MAX_CONCURRENT_REQUESTS = 5;
    const CACHE_EXPIRY_TIME = 1 * 60 * 60 * 1000;
    const processBatch = async(chunks) => {
        const requests = [];
        for (const chunk of chunks) {
            const domain = new TextDecoder().decode(chunk);
            const cachedEntry = dnsCache.get(domain);
            if (cachedEntry && Date.now() - cachedEntry.timestamp < CACHE_EXPIRY_TIME) {
                requests.push(cachedEntry.data);
                continue;
            }
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message'
                },
                body: concatenateChunks(chunk),
            });
            const dnsResult = await response.arrayBuffer();
            dnsCache.set(domain, {
                data: dnsResult,
                timestamp: Date.now()
            });
            requests.push(dnsResult);
        }
        const dnsResults = await Promise.all(requests.slice(MAX_CONCURRENT_REQUESTS));
        for (const dnsResult of dnsResults) {
            processDnsResult(dnsResult, rawClientData, 0);
        }
        if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(rawClientData.slice(0, index));
        }
        index = 0;
    };
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const chunks = [];
            let offset = 0;
            while (offset < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, offset, 2).getUint16(0);
                chunks.push(chunk.slice(offset + 2, offset + 2 + udpPacketLength));
                offset += 2 + udpPacketLength;
                if (chunks.length >= BATCH_SIZE) {
                    await processBatch(chunks);
                    chunks.length = 0;
                }
            }
            if (chunks.length) {
                await processBatch(chunks);
            }
        },
    });
    const writer = transformStream.writable.getWriter();
    await writer.write(rawClientData);
    writer.close();
};
const concatenateChunks = (chunks) => {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach(chunk => {
        result.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    });
    return result.buffer;
};
const processDnsResult = (dnsResult, rawClientData, offset) => {
    const responseArray = new Uint8Array(dnsResult);
    while (offset < responseArray.byteLength) {
        const responseLength = new DataView(responseArray.buffer, offset, 2).getUint16(0);
        rawClientData.set(responseArray.slice(offset, offset + responseLength), offset);
        offset += responseLength;
    }
};
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
