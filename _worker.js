import { connect } from 'cloudflare:sockets';

export default {
    async fetch(request, env, ctx) {
        const { UUID: userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4', PROXYIP: proxyIP = '' } = env;
        if (request.headers.get('Upgrade') !== 'websocket') return handleHTTP(request, userID);
        try {
            return await vlessOverWSHandler(request, userID, proxyIP);
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

function handleHTTP(request, userID) {
    const { pathname } = new URL(request.url);
    const host = request.headers.get('Host');
    return pathname === '/' ?
        new Response(JSON.stringify(request.cf, null, 4), { status: 200 }) :
        pathname === `/${userID}` ?
        new Response(getVLESSConfig(userID, host), { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } }) :
        new Response('Not found', { status: 404 });
}

async function vlessOverWSHandler(request, userID, proxyIP) {
    const { 0: client, 1: webSocket } = new WebSocketPair();
    webSocket.accept();
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
    const remoteSocketWrapper = { value: null };
    let udpStreamWrite = null, isDns = false;
    const writableStream = new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const { hasError, portRemote, addressRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP && portRemote === 53) isDns = true;
            const vlessResponseHeader = new Uint8Array([vlessVersion, 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                udpStreamWrite = (await handleUDPOutBound(webSocket, vlessResponseHeader)).write;
                udpStreamWrite(rawClientData);
                return;
            }
            handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
        }
    });
    readableWebSocketStream.pipeTo(writableStream).catch(() => {});
    return new Response(null, { status: 101, webSocket: client });
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
    if (error) return new ReadableStream({ start: (controller) => controller.error(error) });
    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (!readableStreamCancel) controller.enqueue(event.data);
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) controller.close();
            });
            webSocketServer.addEventListener('error', (event) => {
                if (!readableStreamCancel) controller.error(event);
            });
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true };
    const view = new DataView(vlessBuffer);
    const userIDBuffer = new Uint8Array(vlessBuffer, 1, 16);
    if (view.getUint8(0) !== 0 || stringify(userIDBuffer) !== userID) return { hasError: true };
    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    if (![1, 2].includes(command)) return { hasError: true };
    const isUDP = command === 2;
    const portIndex = 18 + optLength + 1;
    const portRemote = view.getUint16(portIndex);
    const addressIndex = portIndex + 2;
    const addressType = view.getUint8(addressIndex);
    let addressLength, addressValueIndex, addressValue;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValueIndex = addressIndex + 1;
            addressValue = Array.from(new Uint8Array(vlessBuffer, addressValueIndex, addressLength)).join('.');
            break;
        case 2:
            addressLength = view.getUint8(addressIndex + 1);
            addressValueIndex = addressIndex + 2;
            addressValue = new TextDecoder().decode(new Uint8Array(vlessBuffer, addressValueIndex, addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValueIndex = addressIndex + 1;
            addressValue = Array.from(new Uint8Array(vlessBuffer, addressValueIndex, addressLength))
                .map(b => b.toString(16).padStart(2, '0')).join(':');
            break;
        default:
            return { hasError: true };
    }
    return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, vlessVersion: 0, isUDP };
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            let index = 0, chunkView = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
            while (index < chunkView.byteLength) {
                const udpPacketLength = chunkView.getUint16(index);
                const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
                index += 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                const response = await fetch('https://cloudflare-dns.com/dns-query', {
                    method: 'POST',
                    headers: { 'content-type': 'application/dns-message' },
                    body: chunk
                });
                const dnsQueryResult = await response.arrayBuffer();
                const udpSizeArray = new Uint8Array(2 + dnsQueryResult.byteLength);
                udpSizeArray.set(new Uint8Array([dnsQueryResult.byteLength >> 8, dnsQueryResult.byteLength & 0xff]), 0);
                udpSizeArray.set(new Uint8Array(dnsQueryResult), 2);
                const dataToSend = isVlessHeaderSent ? udpSizeArray : new Uint8Array([...vlessResponseHeader, ...udpSizeArray]);
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(dataToSend.buffer);
                    isVlessHeaderSent = true;
                }
            } catch {}
        }
    })).catch(() => {});
    return { write: chunk => transformStream.writable.getWriter().write(chunk) };
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) {
    const connectAndWrite = async (address, port) => {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    };
    const retry = async () => {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(() => {}).finally(() => safeCloseWebSocket(webSocket));
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
    };
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    let vlessHeader = vlessResponseHeader;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                hasIncomingData = true;
                if (webSocket.readyState !== WebSocket.OPEN) return;
                if (vlessHeader) {
                    const combinedBuffer = new Uint8Array([...vlessHeader, ...new Uint8Array(chunk)]);
                    webSocket.send(combinedBuffer.buffer);
                    vlessHeader = null;
                } else {
                    webSocket.send(chunk);
                }
            }
        }));
    } catch {}
    if (!hasIncomingData && retry) retry();
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        const adjustedBase64 = base64Str.replace(/[-_]/g, match => match === '-' ? '+' : '/');
        const binaryStr = atob(adjustedBase64);
        const len = binaryStr.length;
        const arrayBuffer = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function safeCloseWebSocket(socket) {
    if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) {
        socket.close();
    }
}

function stringify(arr, offset = 0) {
    const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
    return `${byteToHex[arr[offset]]}${byteToHex[arr[offset + 1]]}${byteToHex[arr[offset + 2]]}${byteToHex[arr[offset + 3]]}-${byteToHex[arr[offset + 4]]}${byteToHex[arr[offset + 5]]}-${byteToHex[arr[offset + 6]]}${byteToHex[arr[offset + 7]]}-${byteToHex[arr[offset + 8]]}${byteToHex[arr[offset + 9]]}-${byteToHex[arr[offset + 10]]}${byteToHex[arr[offset + 11]]}${byteToHex[arr[offset + 12]]}${byteToHex[arr[offset + 13]]}${byteToHex[arr[offset + 14]]}${byteToHex[arr[offset + 15]]}`.toLowerCase();
}

function getVLESSConfig(userID, hostName) {
    return `
################################################################
v2ray
---------------------------------------------------------------
vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
---------------------------------------------------------------
################################################################
`;
}
