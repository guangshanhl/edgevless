import { connect } from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            const isWebSocket = request.headers.get('Upgrade') === 'websocket';
            return isWebSocket ? handleWs(request, userID, proxyIP) : handleHttp(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttp = (request, userID) => {
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
const handleWs = async (request, userID, proxyIP) => {
    const [client, websocket] = new WebSocketPair();
    websocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWSStream(websocket, earlyDataHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    const writableStream = new WritableStream({
        async write(chunk) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWSHeader(chunk, userID);
            if (hasError) return;
            const responseHeader = new Uint8Array([passVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            isDns = isUDP && port === 53;
            if (isDns) {
                const { write } = await handleUdp(websocket, responseHeader);
                udpWrite = write;
                udpWrite(rawClientData);
                return;
            }
            handleTcp(remoteSocket, address, port, rawClientData, websocket, responseHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({
            hostname: address,
            port,
            allowHalfOpen: true,
            secureTransport: "on"
        });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcp = async (remoteSocket, address, port, rawClientData, websocket, responseHeader, proxyIP) => {
    const tryConnect = async (addr) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, addr, port, rawClientData);
            return await forwardToData(tcpSocket, websocket, responseHeader);
        } catch (error) {
            return false;
        }
    };
    if (!(await tryConnect(address) || await tryConnect(proxyIP))) {
        closeWS(websocket);
    }
};
const createWSStream = (websocket, earlyDataHeader) => {
    const handleEvent = (event, controller) => {
        switch (event.type) {
            case 'message':
                controller.enqueue(event.data);
                break;
            case 'close':
                closeWS(websocket);
                controller.close();
                break;
            case 'error':
                controller.error(event);
                break;
        }
    };
    return new ReadableStream({
        start(controller) {
            const { earlyData, error } = base64ToBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
            ['message', 'close', 'error'].forEach(type =>
                websocket.addEventListener(type, event => handleEvent(event, controller))
            );
        },
        cancel() {
            closeWS(websocket);
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
const processWSHeader = (buffer, userID) => {
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
    const addressValue = addressType === 1
        ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
        : addressType === 2
            ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
            : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const forwardToData = async (remoteSocket, websocket, responseHeader) => {
    let hasData = false;
    let combinedBuffer = null;
    if (responseHeader) {
        combinedBuffer = new Uint8Array(responseHeader.byteLength);
        combinedBuffer.set(new Uint8Array(responseHeader));
    }
    if (websocket.readyState !== WebSocket.OPEN) {
        return hasData;
    }
    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (combinedBuffer) {
                combinedBuffer.set(new Uint8Array(chunk), combinedBuffer.byteLength);
                websocket.send(combinedBuffer);
                combinedBuffer = null;
            } else {
                websocket.send(chunk);
            }
            hasData = true;
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        closeWS(websocket);
    }
    return hasData;
};
const base64ToBuffer = (base64Str) => {
    try {
        if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
            return { earlyData: base64Str, error: null };
        }
        const binaryStr = atob(base64Str.replace(/[-_]/g, (match) => (match === '-' ? '+' : '/')));
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};
const closeWS = (websocket) => {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CLOSING) {
        websocket.close();
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
const dnsCache = new Map();
const getCachedDnsResponse = async (queryPacket) => {
    const cacheKey = new TextDecoder().decode(queryPacket);
    const cachedEntry = dnsCache.get(cacheKey);
    if (cachedEntry && cachedEntry.expires > Date.now()) {
        return cachedEntry.result;
    }
    const response = await fetchDns(queryPacket);
    dnsCache.set(cacheKey, { result: response, expires: Date.now() + 300000 });
    return response;
};
const fetchDns = async (queryPacket) => {
    const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
        },
        body: queryPacket,
    });
    return response.arrayBuffer();
};
const handleUdp = async (websocket, responseHeader) => {
    let headerSent = false;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
                const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;
                const dnsQueryResult = await getCachedDnsResponse(udpData);
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                const dataToSend = headerSent
                    ? new Uint8Array(udpSizeBuffer.byteLength + udpSize)
                    : new Uint8Array(responseHeader.byteLength + udpSizeBuffer.byteLength + udpSize);
                if (!headerSent) {
                    dataToSend.set(responseHeader);
                    headerSent = true;
                }
                dataToSend.set(udpSizeBuffer, headerSent ? 0 : responseHeader.byteLength);
                dataToSend.set(new Uint8Array(dnsQueryResult), dataToSend.length - udpSize);
                if (websocket.readyState === WebSocket.OPEN) {
                    websocket.send(dataToSend);
                }
            }
            controller.close();
        }
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
