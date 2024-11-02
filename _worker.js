import { connect } from 'cloudflare:sockets';
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
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const path = new URL(request.url).pathname;
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
    const PROTOCOLS = {
        WEBSOCKET: 'sec-websocket-protocol'
    };
    const { client, server } = initializeWebSocket();
    const { readableStream, writableStream } = await setupStreams(
        server, 
        request.headers.get(PROTOCOLS.WEBSOCKET) || '',
        userID,
        proxyIP
    );
    readableStream.pipeTo(writableStream);
    return createWebSocketResponse(client);
};
const initializeWebSocket = () => {
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);
    server.accept();
    return { client, server };
};
const setupStreams = async (webSocket, earlyHeader, userID, proxyIP) => {
    const socketState = {
        remoteSocket: { value: null },
        udpWrite: null
    };
    const readableStream = createWSStream(webSocket, earlyHeader);
    const writableStream = createWritableStream(webSocket, socketState, userID, proxyIP);
    return { readableStream, writableStream };
};
const createWritableStream = (webSocket, socketState, userID, proxyIP) => {
    return new WritableStream({
        async write(chunk, controller) {
            if (socketState.udpWrite) {
                return socketState.udpWrite(chunk);
            }
            if (socketState.remoteSocket.value) {
                await writeToRemote(socketState.remoteSocket.value, chunk);
                return;
            }
            await handleNewConnection(chunk, socketState, webSocket, userID, proxyIP);
        }
    });
};
const handleNewConnection = async (chunk, socketState, webSocket, userID, proxyIP) => {
    const headerInfo = processWebSocketHeader(chunk, userID);
    if (headerInfo.hasError) return;
    const { address, port, rawDataIndex, passVersion, isUDP } = headerInfo;
    const resHeader = new Uint8Array([passVersion[0], 0]);
    const clientData = chunk.slice(rawDataIndex);
    if (isUDP && port === 53) {
        const { write } = await handleUdpRequest(webSocket, resHeader);
        socketState.udpWrite = write;
        socketState.udpWrite(clientData);
        return;
    }
    await handleTcpRequest(socketState.remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
};
const createWebSocketResponse = (client) => {
    return new Response(null, {
        status: 101,
        webSocket: client
    });
};
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
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = await connect({ hostname: addr, port });
        }
        await writeToRemote(remoteSocket.value, clientData);
        return await forwardToData(remoteSocket.value, webSocket, resHeader);
    };
    if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
        closeWebSocket(webSocket);
    }
};
const createWSStream = (webSocket, earlyHeader) => {
    const EVENT_TYPES = {
        MESSAGE: 'message',
        CLOSE: 'close',
        ERROR: 'error'
    };
    const eventHandlers = {
        [EVENT_TYPES.MESSAGE]: (event, controller) => {
            controller.enqueue(event.data);
        },
        [EVENT_TYPES.CLOSE]: (_, controller) => {
            closeWebSocket(webSocket);
            controller.close();
        },
        [EVENT_TYPES.ERROR]: (event, controller) => {
            controller.error(event);
        }
    };
    return new ReadableStream({
        start(controller) {
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);               
                if (error) {
                    controller.error(error);
                    return;
                }             
                if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
            Object.entries(eventHandlers).forEach(([type, handler]) => {
                webSocket.addEventListener(type, event => handler(event, controller));
            });
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    });
};
const base64ToBuffer = (input) => {
    if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
        return { earlyData: input, error: null };
    }
    try {
        const normalizedBase64 = input.replace(/[-_]/g, m => m === '-' ? '+' : '/');
        const binaryString = atob(normalizedBase64);
        const buffer = new Uint8Array(binaryString.length);        
        for (let i = 0; i < binaryString.length; i++) {
            buffer[i] = binaryString.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error: new Error('Invalid base64 input') };
    }
};
class WebSocketHeader {
    constructor(hasError, address, port, rawDataIndex, passVersion, isUDP) {
        this.hasError = hasError;
        this.address = address;
        this.port = port;
        this.rawDataIndex = rawDataIndex;
        this.passVersion = passVersion;
        this.isUDP = isUDP;
    }
}
const processWebSocketHeader = (buffer, userID) => {
    if (!buffer || buffer.length < 18) {
        return new WebSocketHeader(true);
    }
    const bytes = new Uint8Array(buffer);
    const header = {
        version: bytes[0],
        uuid: bytes.subarray(1, 17),
        optLength: bytes[17]
    };
    const receivedID = stringify(header.uuid);
    if (receivedID !== userID) {
        return new WebSocketHeader(true);
    }
    const commandStartIndex = 18 + header.optLength;
    const commandData = {
        type: bytes[commandStartIndex],
        port: (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2]
    };
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
    return new WebSocketHeader(
        false,
        address,
        commandData.port,
        rawDataIndex,
        bytes.subarray(0, 1),
        commandData.type === 2
    );
};
const isValidBufferSize = (buffer, minSize) => {
    return buffer && buffer.length >= minSize;
};
const getAddressInfo = (bytes, startIndex) => {
    const addressTypes = {
        IPV4: 1,
        DOMAIN: 2,
        IPV6: 3
    };
    const addressType = bytes[startIndex];   
    switch (addressType) {
        case addressTypes.IPV4:
            return extractIPv4(bytes, startIndex);
        case addressTypes.DOMAIN:
            return extractDomain(bytes, startIndex);
        case addressTypes.IPV6:
            return extractIPv6(bytes, startIndex);
        default:
            throw new Error('Invalid address type');
    }
};
const extractIPv4 = (bytes, startIndex) => ({
    address: Array.from(bytes.subarray(startIndex + 1, startIndex + 5)).join('.'),
    rawDataIndex: startIndex + 5
});
const extractDomain = (bytes, startIndex) => {
    const length = bytes[startIndex + 1];
    const start = startIndex + 2;
    return {
        address: new TextDecoder().decode(bytes.subarray(start, start + length)),
        rawDataIndex: start + length
    };
};
const extractIPv6 = (bytes, startIndex) => ({
    address: Array.from(bytes.subarray(startIndex + 1, startIndex + 17))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(':'),
    rawDataIndex: startIndex + 17
});
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
    const WEBSOCKET_STATES = {
        OPEN: WebSocket.OPEN
    };   
    let hasData = false;
    let hasSent = Boolean(resHeader);
    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WEBSOCKET_STATES.OPEN) {
                controller.error(new Error("WebSocket connection lost"));
                return;
            }
            if (hasSent) {
                sendWithHeader(webSocket, chunk, resHeader);
                hasSent = false;
            } else {
                webSocket.send(chunk);
            }
            hasData = true;
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        handleForwardError(webSocket, error);
    }
    return hasData;
};
const sendWithHeader = (webSocket, chunk, resHeader) => {
    const combinedBuffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
    combinedBuffer.set(resHeader);
    combinedBuffer.set(new Uint8Array(chunk), resHeader.byteLength);
    webSocket.send(combinedBuffer);
};
const handleForwardError = (webSocket, error) => {
    closeWebSocket(webSocket);
};
const closeWebSocket = (webSocket) => {
    if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
        webSocket.close();
    }
};
const byteToHexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    const result = [];
    for (const len of segments) {
        let str = '';
        for (let i = 0; i < len; i++) {
            str += byteToHexTable[arr[offset++]];
        }
        result.push(str);
    }
    return result.join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, resHeader) => {
    const UDP_HEADER_SIZE = 2;
    let hasSent = false;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const processUdpPacket = async (offset, length) => {
                const udpData = chunk.subarray(offset + UDP_HEADER_SIZE, offset + UDP_HEADER_SIZE + length);
                const dnsQueryResult = await handleDNSRequest(udpData);
                return createResponsePacket(dnsQueryResult, hasSent);
            };
            let offset = 0;
            while (offset < chunk.byteLength) {
                const packetLength = new DataView(chunk.buffer, offset, UDP_HEADER_SIZE).getUint16(0);
                const responsePacket = await processUdpPacket(offset, packetLength);            
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(responsePacket);
                }
                hasSent = true;
                offset += UDP_HEADER_SIZE + packetLength;
            }
            controller.terminate();
        }
    });
    setupPipeline(transformStream);
    return createWriter(transformStream);
};
const createResponsePacket = (dnsQueryResult, hasSent) => {
    const udpSize = dnsQueryResult.byteLength;
    const sizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);   
    if (!hasSent) {
        const fullPacket = new Uint8Array(resHeader.byteLength + sizeBuffer.byteLength + udpSize);
        fullPacket.set(resHeader);
        fullPacket.set(sizeBuffer, resHeader.byteLength);
        fullPacket.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + sizeBuffer.byteLength);
        return fullPacket;
    }
    const packet = new Uint8Array(sizeBuffer.byteLength + udpSize);
    packet.set(sizeBuffer);
    packet.set(new Uint8Array(dnsQueryResult), sizeBuffer.byteLength);
    return packet;
};
const setupPipeline = (transformStream) => {
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const writer = transformStream.writable.getWriter();
            await writer.write(chunk);
            writer.releaseLock();
        }
    }));
};
const createWriter = (transformStream) => {
    const writer = transformStream.writable.getWriter();
    return {
        write: (chunk) => writer.write(chunk)
    };
};
const handleDNSRequest = async (queryPacket) => {
    const DNS_ENDPOINT = "https://1.1.1.1/dns-query";
    const response = await fetch(DNS_ENDPOINT, {
        method: "POST",
        headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
        },
        body: queryPacket,
    });
    return response.arrayBuffer();
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
