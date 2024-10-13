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
        value: null
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
                    isUDP
                } = processWebSocketHeader(chunk, userID);
                if (hasError)
                    return;
                responseHeader[0] = vlessVersion[0];
                responseHeader[1] = 0;
                const rawClientData = chunk.slice(rawDataIndex);
                isDns = isUDP && portRemote === 53;
                if (isDns) {
                    udpStreamWrite = await handleUdpRequest(serverSocket, responseHeader, rawClientData);
                } else {
                    handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP);
                }
            },
        }));
    return new Response(null, {
        status: 101,
        webSocket: clientSocket,
    });
};
const activeConnections = new Map(); // 存储活动连接
const MAX_IDLE_TIME = 30000; // 30秒的空闲超时时间

// 写入远程服务器的函数
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};

// 关闭连接的辅助函数
const closeConnection = async (socket) => {
    if (socket && !socket.closed) {
        await socket.close();
        console.log('Connection closed');
    }
};

// 检查空闲连接并关闭
const checkIdleConnections = () => {
    const now = Date.now();
    for (const [key, connection] of activeConnections.entries()) {
        if (connection.lastActivity && (now - connection.lastActivity > MAX_IDLE_TIME)) {
            closeConnection(connection.socket); // 关闭空闲连接
            activeConnections.delete(key); // 从活动连接中移除
        }
    }
};

// 定期检查空闲连接
setInterval(checkIdleConnections, 10000); // 每10秒检查一次

// 连接并写入数据的函数
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    const key = `${address}:${port}`;

    if (!remoteSocket.value || remoteSocket.value.closed) {
        if (activeConnections.has(key)) {
            remoteSocket.value = activeConnections.get(key).socket; // 重用已存在的连接
        } else {
            remoteSocket.value = await connect({ hostname: address, port });
            activeConnections.set(key, { socket: remoteSocket.value, lastActivity: Date.now() }); // 保存新连接和活动时间
        }
    }

    // 更新活动时间
    activeConnections.get(key).lastActivity = Date.now();

    // 发送数据
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};

// 处理 TCP 请求的函数
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP) => {
    try {
        const targetConnectionPromise = connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
        const proxyConnectionPromise = connectAndWrite(remoteSocket, proxyIP, portRemote, rawClientData);

        const tcpSocket = await Promise.race([targetConnectionPromise, proxyConnectionPromise]);
        await forwardToData(tcpSocket, serverSocket, responseHeader, async (retry) => {
            const fallbackSocket = await proxyConnectionPromise;
            await forwardToData(fallbackSocket, serverSocket, responseHeader);
        });

        // 关闭连接（如果不再需要）
        closeConnection(tcpSocket);
    } catch (error) {
        console.error('TCP Request Handling Error:', error);
        closeConnection(remoteSocket.value); // 出错时关闭连接
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    const eventListeners = new Map();
    const readableStream = new ReadableStream({
        start(controller) {
            const { earlyData, error } = base64ToBuffer(earlyDataHeader);
            if (error) return controller.error(error);
            if (earlyData) controller.enqueue(earlyData);
            const handleMessage = (event) => controller.enqueue(event.data);
            const handleClose = () => {
                controller.close();
                removeListeners();
            };  
            const handleError = (err) => {
                controller.error(err);
                removeListeners();
            };
            addListener('message', handleMessage);
            addListener('close', handleClose);
            addListener('error', handleError);
            function addListener(event, handler) {
                serverSocket.addEventListener(event, handler);
                eventListeners.set(event, handler);
            }
        },
        cancel() {
            removeListeners();
            closeWebSocket(serverSocket);
        }
    });
    function removeListeners() {
        eventListeners.forEach((handler, event) => {
            serverSocket.removeEventListener(event, handler);
        });
        eventListeners.clear();
    }

    return readableStream;
};
const processWebSocketHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
    if (receivedID !== userID)
        return {
            hasError: true
        };
    const optLength = view.getUint8(17);
    const startIndex = 18 + optLength;
    const command = view.getUint8(startIndex);
    const isUDP = command === 2;
    const portRemote = view.getUint16(startIndex + 1);
    const version = new Uint8Array(buffer.slice(0, 1));
    const {
        addressRemote,
        rawDataIndex
    } = getAddressInfo(view, buffer, 18 + optLength + 3);
    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex,
        vlessVersion: version,
        isUDP
    };
};
const getAddressInfo = (view, buffer, startIndex) => {
    const addressType = view.getUint8(startIndex);
    const addressLength = addressType === 2 ? view.getUint8(startIndex + 1) : (addressType === 1 ? 4 : 16);
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = addressType === 1
         ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
         : addressType === 2
         ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
         : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return {
        addressRemote: addressValue,
        rawDataIndex: addressValueIndex + addressLength
    };
};
const forwardToData = async(remoteSocket, serverSocket, responseHeader, retry) => {
    if (serverSocket.readyState !== WebSocket.OPEN) {
        closeWebSocket(serverSocket);
        return;
    }
    let hasData = false;
    const CHUNK_SIZE = 512 * 1024;
    let reusableBuffer = responseHeader
         ? new Uint8Array(responseHeader.length + CHUNK_SIZE)
         : new Uint8Array(CHUNK_SIZE);
    const writableStream = new WritableStream({
        async write(chunk) {
            hasData = true;
            let dataToSend;
            const chunkLength = chunk.byteLength;
            if (responseHeader) {
                reusableBuffer.set(responseHeader);
                reusableBuffer.set(new Uint8Array(chunk), responseHeader.length);
                dataToSend = reusableBuffer.subarray(0, responseHeader.length + chunkLength);
                responseHeader = null;
            } else {
                dataToSend = chunk;
            }
            for (let offset = 0; offset < dataToSend.byteLength; offset += CHUNK_SIZE) {
                const end = Math.min(offset + CHUNK_SIZE, dataToSend.byteLength);
                serverSocket.send(dataToSend.slice(offset, end));
            }
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        closeWebSocket(serverSocket);
    }
    if (!hasData && retry) {
        retry();
    }
};
const base64ToBuffer = (base64Str) => {
    try {
        const formattedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(formattedStr);
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return {
            earlyData: buffer.buffer,
            error: null
        };
    } catch (error) {
        return {
            error
        };
    }
};
const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};
const byteToHex = Array.from({
    length: 256
}, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    let result = '';
    segments.forEach((len, index) => {
        if (index > 0)
            result += '-';
        for (let i = 0; i < len; i++) {
            result += byteToHex[arr[offset++]];
        }
    });
    return result.toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader, rawClientData) => {
    const dnsCache = new Map();
    const BATCH_SIZE = 5;
    const CACHE_EXPIRY_TIME = 6 * 60 * 60 * 1000;
    const CLEANUP_INTERVAL = 30 * 60 * 1000;
    let index = 0;
    let batch = [];
    setInterval(cleanExpiredCache, CLEANUP_INTERVAL);
    if (!rawClientData || rawClientData.byteLength === 0) {
        return;
    }
    const udpPackets = new Uint8Array(new DataView(rawClientData.buffer).getUint16(0));
    const dnsFetch = async (chunks) => {
        const domain = new TextDecoder().decode(chunks[0]);
        const currentTime = Date.now();
        const cachedEntry = dnsCache.get(domain);
        if (cachedEntry && (currentTime - cachedEntry.timestamp) < cachedEntry.ttl) {
            return cachedEntry.data;
        }
        try {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message',
                },
                body: concatenateChunks(chunks),
            });
            const result = await response.arrayBuffer();
            dnsCache.set(domain, {
                data: result,
                timestamp: currentTime,
                ttl: CACHE_EXPIRY_TIME,
            });
            return result;
        } catch (error) {
            console.error('DNS Fetch error:', error);
            return null;
        }
    };
    const processBatch = async (controller) => {
        const dnsResults = await Promise.all(batch.map(dnsFetch));
        dnsResults.forEach((dnsResult) => {
            if (dnsResult) {
                index = processDnsResult(dnsResult, udpPackets, index);
            }
        });
        controller.enqueue(udpPackets.slice(0, index));
        index = 0;
        batch = [];
    };
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, offset, 2).getUint16(0);
                batch.push(chunk.slice(offset + 2, offset + 2 + udpPacketLength));
                if (batch.length >= BATCH_SIZE) {
                    await processBatch(controller);
                }
                offset += 2 + udpPacketLength;
            }
        },
        async flush(controller) {
            if (batch.length) {
                await processBatch(controller);
            }
        }
    });
    const writer = transformStream.writable.getWriter();
    await writer.write(rawClientData);
    writer.close();
    const finalMessage = await transformStream.readable.getReader().read();
    if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(finalMessage.value.buffer);
    }
    function cleanExpiredCache() {
        const currentTime = Date.now();
        dnsCache.forEach((value, key) => {
            if ((currentTime - value.timestamp) > value.ttl) {
                dnsCache.delete(key);
            }
        });
    }
};
const concatenateChunks = (chunks) => {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    });
    return result.buffer;
};
const processDnsResult = (dnsResult, udpPackets, index) => {
    const responseArray = new Uint8Array(dnsResult);
    let offset = 0;
    while (offset < responseArray.byteLength) {
        const responseLength = new DataView(responseArray.buffer, offset, 2).getUint16(0);
        udpPackets.set(responseArray.subarray(offset, offset + responseLength), index);
        index += responseLength;
        offset += responseLength;
    }
    return index;
};
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
