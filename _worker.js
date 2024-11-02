import { connect } from 'cloudflare:sockets';

// 常量定义
const WS_READY_STATE_OPEN = WebSocket.OPEN;
const WS_READY_STATE_CLOSING = WebSocket.CLOSING;
const UDP_COMMAND = 2;
const DNS_PORT = 53;

// 全局单例
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const connectionPool = new ConnectionPool();

export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';

        try {
            const isSocket = request.headers.get('Upgrade') === 'websocket';
            return isSocket
                ? handleWsRequest(request, userID, proxyIP)
                : handleHttpRequest(request, userID);
        } catch (err) {
            return handleError(err);
        }
    }
};

class ConnectionPool {
    constructor() {
        this.pool = new Map();
    }
    
    async getConnection(address, port) {
        const key = `${address}:${port}`;
        if (!this.pool.has(key)) {
            const socket = await connect({ hostname: address, port });
            this.pool.set(key, socket);
        }
        return this.pool.get(key);
    }
    
    closeConnection(address, port) {
        const key = `${address}:${port}`;
        if (this.pool.has(key)) {
            const socket = this.pool.get(key);
            socket.close();
            this.pool.delete(key);
        }
    }
}

const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/") {
        return new Response(JSON.stringify(request.cf, null, 4));
    }

    if (path === `/${userID}`) {
        const vlessConfig = getConfig(userID, request.headers.get("Host"));
        return new Response(vlessConfig, {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }

    return new Response("Not found", { status: 404 });
};

const handleWsRequest = async (request, userID, proxyIP) => {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWSStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;

    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }

            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;

            const resHeader = new Uint8Array([passVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);

            if (isUDP && port === DNS_PORT) {
                const { write } = await handleUdpRequest(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }

            await handleTcpRequest(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
        }
    });

    readableStream.pipeTo(writableStream).catch(handleError);
    return new Response(null, { status: 101, webSocket: client });
};

const createWSStream = (webSocket, earlyHeader) => {
    const controller = new AbortController();
    const { signal } = controller;
    
    return new ReadableStream({
        start(controller) {
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
                return;
            }
            
            if (earlyData) {
                controller.enqueue(earlyData);
            }

            const eventHandler = (event) => {
                switch(event.type) {
                    case 'message':
                        controller.enqueue(event.data);
                        break;
                    case 'close':
                        closeWebSocket(webSocket);
                        controller.close();
                        break;
                    case 'error':
                        controller.error(event);
                        break;
                }
            };

            ['message', 'close', 'error'].forEach(type => 
                webSocket.addEventListener(type, eventHandler, { signal })
            );
        },
        cancel() {
            controller.abort();
            closeWebSocket(webSocket);
        }
    });
};

// DNS 缓存客户端
const dnsClient = {
    endpoint: "https://1.1.1.1/dns-query",
    cache: new Map(),
    async query(queryPacket) {
        const key = new Uint8Array(queryPacket).toString();
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        const response = await fetch(this.endpoint, {
            method: "POST",
            headers: {
                accept: "application/dns-message",
                "content-type": "application/dns-message",
            },
            body: queryPacket,
        });

        const result = await response.arrayBuffer();
        this.cache.set(key, result);
        return result;
    }
};

// 其他辅助函数
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    try {
        await writer.write(chunk);
    } finally {
        writer.releaseLock();
    }
};

const handleTcpRequest = async (remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP) => {
    const tryConnect = async (addr) => {
        try {
            if (!remoteSocket.value || remoteSocket.value.closed) {
                remoteSocket.value = await connectionPool.getConnection(addr, port);
            }
            await writeToRemote(remoteSocket.value, clientData);
            return await forwardToData(remoteSocket.value, webSocket, resHeader);
        } catch (error) {
            return false;
        }
    };

    if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
        closeWebSocket(webSocket);
    }
};

const handleUdpRequest = async (webSocket, resHeader) => {
    let hasSent = false;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
                const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;

                const dnsQueryResult = await dnsClient.query(udpData);
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

                const combinedLength = hasSent
                    ? udpSizeBuffer.byteLength + udpSize
                    : resHeader.byteLength + udpSizeBuffer.byteLength + udpSize;

                const dataToSend = new Uint8Array(combinedLength);

                if (!hasSent) {
                    dataToSend.set(resHeader);
                    dataToSend.set(udpSizeBuffer, resHeader.byteLength);
                    dataToSend.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + udpSizeBuffer.byteLength);
                    hasSent = true;
                } else {
                    dataToSend.set(udpSizeBuffer);
                    dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
                }

                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    webSocket.send(dataToSend);
                }
            }
            controller.terminate();
        }
    });

    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
    let hasData = false;
    let hasSent = Boolean(resHeader);

    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error(new Error("WebSocket is closed."));
            }

            if (hasSent) {
                const combinedBuffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                combinedBuffer.set(resHeader);
                combinedBuffer.set(new Uint8Array(chunk), resHeader.byteLength);
                webSocket.send(combinedBuffer);
                hasSent = false;
            } else {
                webSocket.send(chunk);
            }
            hasData = true;
        },
    });

    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        closeWebSocket(webSocket);
    }

    return hasData;
};

const base64ToBuffer = (base64Str) => {
    try {
        if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
            return { earlyData: base64Str, error: null };
        }

        const binaryStr = atob(base64Str.replace(/[-_]/g, m => m === '-' ? '+' : '/'));
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};

const closeWebSocket = (webSocket) => {
    if (webSocket.readyState === WS_READY_STATE_OPEN || webSocket.readyState === WS_READY_STATE_CLOSING) {
        webSocket.close();
    }
};

const byteToHexTable = new Uint8Array(256).map((_, i) => 
    (i + 0x100).toString(16).substring(1)
).join('');

const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    const result = new Array(5);
    let pos = offset;
    
    for (let i = 0; i < 5; i++) {
        const len = segments[i];
        const hex = new Array(len);
        for (let j = 0; j < len; j++) {
            hex[j] = byteToHexTable[arr[pos++]];
        }
        result[i] = hex.join('');
    }
    
    return result.join('-').toLowerCase();
};

const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};

const handleError = (error) => {
    console.error(error);
    return new Response(error.message, { status: 500 });
};

// 工具函数
const getRandomValues = (length) => crypto.getRandomValues(new Uint8Array(length));
const align = (n) => (n + 3) & ~3;
