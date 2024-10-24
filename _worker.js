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
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));
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
            const { hasError, addressRemote, portRemote, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
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
            handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: clientSocket });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    try {
        await writer.write(chunk);
    } finally {
        writer.releaseLock();
    }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({ hostname: address, port });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP) => {
    const tryconnect = async(address, port) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
            return await forwardToData(tcpSocket, serverSocket, responseHeader);
        } catch (error) {
            return false;
        }
    };
    if (!await tryconnect(addressRemote, portRemote)) {
        if (!await tryconnect(proxyIP, portRemote)) {
            closeWebSocket(serverSocket);
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
        pull(controller) {},
        cancel(reason) {
            if (streamCancel) return;
            streamCancel = true;
            closeWebSocket(serverSocket);
        },
    });
    return stream;
};
const processWebSocketHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
    if (receivedID !== userID) return { hasError: true };
    const optLength = view.getUint8(17);
    const startIndex = 18 + optLength;
    const command = view.getUint8(startIndex);
    const isUDP = command === 2;
    const portRemote = view.getUint16(startIndex + 1);
    const version = new Uint8Array(buffer.slice(0, 1));
    const { addressRemote, rawDataIndex } = getAddressInfo(view, buffer, 18 + optLength + 3);
    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex,
        passVersion: version,
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
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
    let chunks = [];
    let vlessHeader = responseHeader;
    let hasData = false;
    const serverSocketOpen = () => serverSocket.readyState === WebSocket.OPEN;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    hasData = true;
                    if (!serverSocketOpen()) {
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
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F#vless+cfworker`;
};
