import { connect } from 'cloudflare:sockets';
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
    const path = new URL(request.url).pathname;
    if (path === "/") {
        return new Response(JSON.stringify(request.cf, null, 4));
    }
    if (path === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            }
        });
    }
    return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
    const [clientSocket, serverSocket] = new WebSocketPair();
    serverSocket.accept();
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
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;
            responseHeader[0] = passVersion[0];
            responseHeader[1] = 0;
            const rawClientData = chunk.slice(rawDataIndex);
            isDns = isUDP && portRemote === 53;
            if (isDns) {
                const { write } = await handleUdpRequest(serverSocket, responseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
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
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({ hostname: address, port });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async(remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
    const tryconnect = async(address, port) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
            return await forwardToData(tcpSocket, serverSocket, responseHeader);
        } catch (error) {
            return false;
        }
    };
    if (!await tryconnect(address, port)) {
        if (!await tryconnect(proxyIP, port)) {
            if (serverSocket.readyState === WebSocket.OPEN) {
                closeWebSocket(serverSocket);
            }
        }
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    let streamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            serverSocket.addEventListener("message", (event) => {
                if (streamCancel) return;
                const message = event.data;
                controller.enqueue(message);
            });
            serverSocket.addEventListener("close", () => {
                closeWebSocket(serverSocket);
                if (streamCancel) return;
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
        cancel(reason) {
            if (streamCancel) return;
            streamCancel = true;
            closeWebSocket(serverSocket);
        },
    });
    return stream;
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
    const receivedID = stringify(bytes.slice(1, 17));
    if (receivedID !== userID) return new WebSocketHeader(true);
    const optLength = bytes[17];
    const commandStartIndex = 18 + optLength;
    const command = bytes[commandStartIndex];
    const isUDP = command === 2;
    const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
    return new WebSocketHeader(false, address, port, rawDataIndex, bytes.slice(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
    const addressType = bytes[startIndex];
    let addressLength;
    if (addressType === 1) {
        addressLength = 4;
    } else if (addressType === 2) {
        addressLength = bytes[startIndex + 1];
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
    let vlessHeader = responseHeader;
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) { 
                    if (serverSocket.readyState !== WebSocket.OPEN) {
                        controller.error('serverSocket is closed');
                        return;
                    }
                    hasData = true;
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
        if (serverSocket.readyState === WebSocket.OPEN) {
            closeWebSocket(serverSocket);
        }
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
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
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
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
