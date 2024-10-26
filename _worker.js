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
const handleWsRequest = async (request, userID) => {
    const [clientSocket, serverSocket] = new WebSocketPair();
    serverSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, earlyDataHeader, userID);
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
            if (hasError) {
                return;
            }
            responseHeader[0] = passVersion[0];
            responseHeader[1] = 0;
            const rawClientData = chunk.slice(rawDataIndex);
            isDns = isUDP && port === 53;
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
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
    const tryConnect = async (address, port) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
            return await forwardToData(tcpSocket, serverSocket, responseHeader);
        } catch (error) {
            console.error("TCP connection error:", error);
            return false;
        }
    };
    if (!await tryConnect(address, port)) {
        if (!await tryConnect(proxyIP, port)) {
            closeWebSocket(serverSocket);
        }
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
    let vlessHeader = responseHeader;
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    hasData = true;
                    if (vlessHeader) {
                        const combined = new Uint8Array(vlessHeader.length + chunk.length);
                        combined.set(vlessHeader, 0);
                        combined.set(new Uint8Array(chunk), vlessHeader.length);
                        sendToWebSocket(serverSocket, combined);
                        vlessHeader = null;
                    } else {
                        sendToWebSocket(serverSocket, chunk);
                    }
                },
                close() {
                    closeWebSocket(serverSocket);
                },
                abort(err) {
                    closeWebSocket(serverSocket);
                }
            })
        );
    } catch (error) {
        closeWebSocket(serverSocket);
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
const sendToWebSocket = (serverSocket, data) => {
    if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(data);
    } else {
        controller.error('serverSocket is closed');
    }
};
const closeWebSocket = (serverSocket) => {
    serverSocket.close();
};
const handleUdpRequest = async (serverSocket, responseHeader) => {
    let headerSent = false;
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const tasks = [];
            let index = 0;
            while (index < chunk.byteLength) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;
                tasks.push(
                    handleDNSRequest(udpData).then(response => {
                        const udpBuffer = new Uint8Array(2 + response.byteLength);
                        udpBuffer[0] = response.byteLength >> 8;
                        udpBuffer[1] = response.byteLength & 0xff;
                        udpBuffer.set(new Uint8Array(response), 2);
                        if (!headerSent) {
                            headerSent = true;
                            const combinedBuffer = new Uint8Array(responseHeader.byteLength + udpBuffer.byteLength);
                            combinedBuffer.set(responseHeader, 0);
                            combinedBuffer.set(udpBuffer, responseHeader.byteLength);
                            sendToWebSocket(serverSocket, combinedBuffer);
                        } else {
                            sendToWebSocket(serverSocket, udpBuffer);
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
