import { connect } from 'cloudflare:sockets';
const byteToHexTable = new Uint8Array(256).map((_, i) => (i + 256).toString(16).slice(1));
const wsCache = new Map();
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        
        const isWebSocket = request.headers.get('Upgrade') === 'websocket';
        return isWebSocket ? handleWsRequest(request, userID, proxyIP) : handleHttpRequest(request, userID);
    }
};
const handleHttpRequest = (request, userID) => {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));   
    if (path === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }
    return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
    let cachedSocket = wsCache.get(userID);
    if (cachedSocket?.readyState === WebSocket.OPEN) {
        return new Response(null, { status: 101, webSocket: cachedSocket.clientSocket });
    }
    const [clientSocket, serverSocket] = new WebSocketPair();
    serverSocket.accept();
    wsCache.set(userID, { clientSocket, serverSocket });
    serverSocket.addEventListener("close", () => wsCache.delete(userID));
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, earlyDataHeader);
    let remoteSocket = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    const responseHeader = new Uint8Array(2);
    const writableStream = new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocket.value) {
                return await writeToRemote(remoteSocket.value, chunk);
            }
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;
            responseHeader.set(passVersion, 0);
            const rawClientData = chunk.slice(rawDataIndex);
            isDns = isUDP && port === 53;
            if (isDns) {
                udpStreamWrite = (await handleUdpRequest(serverSocket, responseHeader)).write;
                return udpStreamWrite(rawClientData);
            }
            handleTcpRequest(remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: clientSocket });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value?.closed) {
        remoteSocket.value = await connect({ hostname: address, port });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
    const tryConnect = async (address, port) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
            return await forwardToData(tcpSocket, serverSocket, responseHeader);
        } catch {
            return false;
        }
    };
    if (!await tryConnect(address, port) && !await tryConnect(proxyIP, port)) {
        closeWebSocket(serverSocket);
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    const stream = new ReadableStream({
        start(controller) {
            serverSocket.addEventListener("message", (event) => {
                const message = event.data;
                controller.enqueue(message);
            });
            serverSocket.addEventListener("close", () => {
                closeWebSocket(serverSocket);
                controller.close();
            });
            serverSocket.addEventListener("error", (err) => {
                controller.error(err);
            });
            const { earlyData, error } = base64ToBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            closeWebSocket(serverSocket);
        },
    });
    return stream;
};
const processWebSocketHeader = (buffer, userID) => {
    const bytes = new Uint8Array(buffer);
    if (stringify(bytes.slice(1, 17)) !== userID) return { hasError: true };
    const optLength = bytes[17];
    const commandStartIndex = 18 + optLength;
    const command = bytes[commandStartIndex];
    const isUDP = command === 2;
    const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
    return { hasError: false, address, port, rawDataIndex, passVersion: bytes.slice(0, 1), isUDP };
};
const getAddressInfo = (bytes, startIndex) => {
    const addressType = bytes[startIndex];
    let addressLength;
    if (addressType === 2) {
        addressLength = bytes[startIndex + 1];
    } else if (addressType === 1) {
        addressLength = 4;
    } else {
        addressLength = 16;
    }
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = (addressType === 1)
        ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
        : (addressType === 2)
            ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
            : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return {
        address: addressValue,
        rawDataIndex: addressValueIndex + addressLength,
    };
};
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
    let chunks = [];
    let vlessHeader = responseHeader;
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    hasData = true;
                    if (serverSocket.readyState !== WebSocket.OPEN) {
                        controller.error('serverSocket is closed');
                        return;
                    }
                    if (vlessHeader) {
                        const combined = new Uint8Array(vlessHeader.length + chunk.length);
                        combined.set(vlessHeader, 0);
                        combined.set(new Uint8Array(chunk), vlessHeader.length);
                        serverSocket.send(combined);
                        vlessHeader = null;
                    } else {
                        serverSocket.send(chunk);
                    }
                }
            })
        );
    } catch (error) {
        closeWebSocket(serverSocket);
    }
    return hasData;
};
const base64_regex = /[-_]/g;
const replaceBase64Chars = (str) => str.replace(base64_regex, match => (match === '-' ? '+' : '/'));
const base64ToBuffer = (base64Str) => {
    try {
        const binaryStr = atob(replaceBase64Chars(base64Str));
        const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};
const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader) => {
    let headerSent = false;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            const tasks = [];
            while (index < chunk.byteLength) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
                tasks.push(
                    handleDNSRequest(udpData).then(response => {
                        const length = response.byteLength;
                        const udpBuffer = new Uint8Array(2 + length);
                        udpBuffer[0] = length >> 8;
                        udpBuffer[1] = length & 0xff;
                        udpBuffer.set(new Uint8Array(response), 2);
                        if (!headerSent) {
                            headerSent = true;
                            const combinedBuffer = new Uint8Array(responseHeader.byteLength + udpBuffer.byteLength);
                            combinedBuffer.set(new Uint8Array(responseHeader), 0);
                            combinedBuffer.set(udpBuffer, responseHeader.byteLength);
                            serverSocket.send(combinedBuffer);
                        } else {
                            serverSocket.send(udpBuffer);
                        }
                    })
                );
            }
            await Promise.all(tasks);
        },
    });
    return {
        write: (chunk) => transformStream.writable.getWriter().write(chunk)
    };
};
const handleDNSRequest = async (queryPacket) => {
    const dnsResponse = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: {
            'accept': 'application/dns-message',
            'content-type': 'application/dns-message',
        },
        body: queryPacket,
    });
    return dnsResponse.arrayBuffer();
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
