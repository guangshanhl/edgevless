import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';

        try {
            const isWebSocket = request.headers.get('Upgrade') === 'websocket';
            return isWebSocket ? handleWsRequest(request, userID, proxyIP) : handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};

const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(JSON.stringify(request.cf, null, 4));

    if (url.pathname === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }

    return new Response("Not found", { status: 404 });
};

const handleWsRequest = async (request, userID, proxyIP) => {
    const [clientSocket, serverSocket] = new WebSocketPair();
    serverSocket.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, earlyDataHeader);
    const remoteSocket = { value: null };
    let udpStreamWrite = null;

    const writableStream = new WritableStream({
        async write(chunk) {
            const { isDns, udpStreamWriteFunc, remoteSocketValue, processedData } = await handleWebSocketData(
                chunk, userID, remoteSocket, serverSocket, proxyIP, udpStreamWrite
            );
            
            if (isDns) {
                udpStreamWrite = udpStreamWriteFunc;
                udpStreamWrite(processedData);
            } else if (remoteSocketValue) {
                await writeToRemote(remoteSocketValue, processedData);
            }
        }
    });

    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: clientSocket });
};

const handleWebSocketData = async (chunk, userID, remoteSocket, serverSocket, proxyIP, udpStreamWrite) => {
    const { hasError, address, port, rawDataIndex, isUDP } = processWebSocketHeader(chunk, userID);
    if (hasError) return { isDns: false };

    const rawClientData = chunk.slice(rawDataIndex);
    const isDns = isUDP && port === 53;

    if (isDns) {
        const { write } = await handleUdpRequest(serverSocket);
        return { isDns: true, udpStreamWriteFunc: write, processedData: rawClientData };
    }

    const remoteSocketValue = await connectAndWrite(remoteSocket, address, port, rawClientData, serverSocket, proxyIP);
    return { isDns: false, remoteSocketValue, processedData: rawClientData };
};

const connectAndWrite = async (remoteSocket, address, port, rawClientData, serverSocket, proxyIP) => {
    if (!await tryConnect(remoteSocket, address, port, rawClientData)) {
        if (!await tryConnect(remoteSocket, proxyIP, port, rawClientData)) {
            closeWebSocket(serverSocket);
        }
    }
    return remoteSocket.value;
};

const tryConnect = async (remoteSocket, address, port, rawClientData) => {
    try {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = await connect({ hostname: address, port });
        }
        await writeToRemote(remoteSocket.value, rawClientData);
        return true;
    } catch {
        return false;
    }
};

const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    let streamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            serverSocket.addEventListener("message", event => {
                if (!streamCancel) controller.enqueue(event.data);
            });
            serverSocket.addEventListener("close", () => {
                closeWebSocket(serverSocket);
                if (!streamCancel) controller.close();
            });
            serverSocket.addEventListener("error", err => controller.error(err));

            const { earlyData, error } = base64ToBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            if (!streamCancel) {
                streamCancel = true;
                closeWebSocket(serverSocket);
            }
        },
    });
    return stream;
};

const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    try {
        await writer.write(chunk);
    } finally {
        writer.releaseLock();
    }
};

const processWebSocketHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
    if (receivedID !== userID) return { hasError: true };

    const optLength = view.getUint8(17);
    const startIndex = 18 + optLength;
    const command = view.getUint8(startIndex);
    const isUDP = command === 2;
    const port = view.getUint16(startIndex + 1);
    const { address, rawDataIndex } = getAddressInfo(view, buffer, startIndex + 3);

    return { hasError: false, address, port, rawDataIndex, isUDP };
};

const getAddressInfo = (view, buffer, startIndex) => {
    const addressType = view.getUint8(startIndex);
    const addressLength = addressType === 2 ? view.getUint8(startIndex + 1) : (addressType === 1 ? 4 : 16);
    const addressValue = getAddressValue(view, buffer, startIndex, addressType, addressLength);

    return { address: addressValue, rawDataIndex: startIndex + addressLength };
};

const getAddressValue = (view, buffer, startIndex, addressType, addressLength) => {
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    if (addressType === 1) return Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
    if (addressType === 2) return new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
    return Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
};

const handleUdpRequest = async (serverSocket) => {
    let headerSent = false;

    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            const tasks = [];
            let index = 0;

            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;

                tasks.push(handleDNSRequest(udpData).then(response => {
                    const udpBuffer = new Uint8Array([response.byteLength >> 8, response.byteLength & 0xff, ...new Uint8Array(response)]);
                    if (!headerSent) {
                        serverSocket.send(new Uint8Array([...responseHeader, ...udpBuffer]));
                        headerSent = true;
                    } else {
                        serverSocket.send(udpBuffer);
                    }
                }));
            }

            await Promise.all(tasks);
        },
    });

    return { write: chunk => transformStream.writable.getWriter().write(chunk) };
};

const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};

const base64ToBuffer = (base64Str) => {
    try {
        const binaryStr = atob(replaceBase64Chars(base64Str));
        return { earlyData: Uint8Array.from(binaryStr, char => char.charCodeAt(0)).buffer, error: null };
    } catch (error) {
        return { error };
    }
};

const replaceBase64Chars = (str) => str.replace(/[-_]/g, match => (match === '-' ? '+' : '/'));

const getConfig = (userID, host) => `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F#vless+cfworker`;

const stringify = (arr, offset = 0) => [4, 2, 2, 2, 6].map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
