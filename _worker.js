import { connect } from 'cloudflare:sockets';

const WS_STATES = {
    OPEN: WebSocket.OPEN,
    CLOSING: WebSocket.CLOSING
};

const DNS_HEADERS = {
    accept: "application/dns-message",
    "content-type": "application/dns-message"
};

const byteToHexTable = new Uint8Array(256).map((_, i) => 
    (i + 0x100).toString(16).slice(1)
);

export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        
        try {
            return request.headers.get('Upgrade') === 'websocket'
                ? await handleWsRequest(request, userID, proxyIP)
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

            if (isUDP && port === 53) {
                const { write } = await handleUdpRequest(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }

            handleTcpRequest(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
        }
    });

    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: client });
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
            remoteSocket.value = connect({ hostname: addr, port });
        }
        await writeToRemote(remoteSocket.value, clientData);
        return await forwardToData(remoteSocket.value, webSocket, resHeader);
    };

    if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
        closeWebSocket(webSocket);
    }
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

            const messageHandler = (event) => controller.enqueue(event.data);
            const closeHandler = () => {
                closeWebSocket(webSocket);
                controller.close();
            };
            const errorHandler = (event) => controller.error(event);

            webSocket.addEventListener('message', messageHandler, { signal });
            webSocket.addEventListener('close', closeHandler, { signal });
            webSocket.addEventListener('error', errorHandler, { signal });
        },
        cancel() {
            controller.abort();
            closeWebSocket(webSocket);
        }
    });
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
    const bytes = new Uint8Array(buffer);
    const receivedID = stringify(bytes.subarray(1, 17));
    
    if (receivedID !== userID) return new WebSocketHeader(true);

    const optLength = bytes[17];
    const commandStartIndex = 18 + optLength;
    const command = bytes[commandStartIndex];
    const isUDP = command === 2;
    const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);

    return new WebSocketHeader(false, address, port, rawDataIndex, bytes.subarray(0, 1), isUDP);
};

const getAddressInfo = (bytes, startIndex) => {
    const addressType = bytes[startIndex];
    const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    
    let addressValue;
    if (addressType === 1) {
        addressValue = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.');
    } else if (addressType === 2) {
        addressValue = new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength));
    } else {
        addressValue = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
            .map(b => b.toString(16).padStart(2, '0')).join(':');
    }

    return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
    let hasData = false;
    let hasSent = Boolean(resHeader);

    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WS_STATES.OPEN) {
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
        }
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

        const binaryStr = atob(base64Str.replace(/[-_]/g, match => match === '-' ? '+' : '/'));
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
    if (webSocket.readyState === WS_STATES.OPEN || webSocket.readyState === WS_STATES.CLOSING) {
        webSocket.close();
    }
};

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
    let hasSent = false;

    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
                const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;

                const dnsQueryResult = await handleDNSRequest(udpData);
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

                if (webSocket.readyState === WS_STATES.OPEN) {
                    webSocket.send(dataToSend);
                }
            }
            controller.terminate();
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const writer = transformStream.writable.getWriter();
            writer.write(chunk);
            writer.releaseLock();
        }
    }));

    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
};

const handleDNSRequest = async (queryPacket) => {
    const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: DNS_HEADERS,
        body: queryPacket
    });
    return response.arrayBuffer();
};

const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
