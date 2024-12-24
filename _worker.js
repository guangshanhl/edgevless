import { connect } from 'cloudflare:sockets';
let cachedUserID;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const connections = new Map();
const getUpgradeHeader = (request) => request.headers.get('Upgrade');
export default {
    fetch: async (request, env, ctx) => {
        try {
            const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP ?? '';
            const upgradeHeader = getUpgradeHeader(request);
            if (upgradeHeader === 'websocket') {
                return await ressOverWSHandler(request, userID, proxyIP);
            }
            const url = new URL(request.url);
            const paths = {
                '/': () => new Response(JSON.stringify(request.cf), { status: 200 }),
                [`/${userID}`]: () => new Response(getConfig(userID, request.headers.get('Host')), {
                    status: 200,
                    headers: { "Content-Type": "text/plain;charset=utf-8" }
                })
            };
            const handler = paths[url.pathname] || (() => new Response('Not found', { status: 404 }));
            return handler();
        } catch (err) {
            console.error(err);
            return new Response(err.toString(), { status: 500 });
        }
    },
};
const ressOverWSHandler = async (request, userID, proxyIP) => {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = createStreamHandler(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    setInterval(() => {
        if (webSocket.readyState === WS_READY_STATE_OPEN) {
            webSocket.send(JSON.stringify({ type: 'keep-alive' }));
        }
    }, 30000);
    readableWebStream.pipeTo(new WritableStream({
        write: async (chunk) => {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                try {
                    await writer.write(chunk);
                } finally {
                    writer.releaseLock();
                }
                return;
            }
            const {
                hasError,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP) {
                if (portRemote !== 53) {
                    return;
                }
                isDns = true;
            }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP);
        },
    }));
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
};
const getConnection = async (address, port) => {
    const key = `${address}:${port}`;
    if (connections.has(key)) {
        return connections.get(key);
    }
    const newConnection = connect({ hostname: address, port });
    connections.set(key, newConnection);
    return newConnection;
};
const handleTCPOutBound = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) => {
    const connectAndWrite = async (address, port) => {
        remoteSocket.value = await getConnection(address, port);
        const writer = remoteSocket.value.writable.getWriter();
        try {
            await writer.write(clientData);
        } finally {
            writer.releaseLock();
        }
        return remoteSocket.value;
    };
    const tryConnect = async (address, port) => {
        const tcpSocket = await connectAndWrite(address, port);
        if (tcpSocket) return forwardToData(tcpSocket, webSocket, resHeader);
        return false;
    };
    const connected = await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote);
    if (!connected) closeWebSocket(webSocket);
};
const createStreamHandler = (webSocket, earlyHeader) => {
    let isCancel = false;
    const stream = new ReadableStream({
        start: (controller) => {
            webSocket.addEventListener('message', (event) => {
                if (!isCancel) controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                if (!isCancel) controller.close();
                closeWebSocket(webSocket);
            });
            webSocket.addEventListener('error', (err) => controller.error(err));
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel: () => {
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
    return stream;
};
const processRessHeader = (ressBuffer, userID) => {
    if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) return { hasError: true };
    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const commandMap = {
        1: false,
        2: true,
    };
    const isUDP = commandMap[command] ?? true;
    const portIndex = 18 + optLength + 1;
    const portBuffer = ressBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: version,
        isUDP,
    };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
	let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        write: async (chunk) => {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) return;
            webSocket.send(resHeader ? new Uint8Array([...resHeader, ...chunk]) : chunk);
            resHeader = null;
			hasData = true;
        },
    })).catch(() => closeWebSocket(webSocket));
	return hasData;
};
const base64ToBuffer = (base64Str) => {
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const length = binaryStr.length;
        const arrayBuffer = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};
const closeWebSocket = (socket) => {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
};
const handleUDPOutBound = async (webSocket, resHeader) => {
    let headerSent = false;
    const transformStream = new TransformStream({
        transform: (chunk, controller) => {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        },
    });
    transformStream.readable.pipeTo(new WritableStream({
        write: async (chunk) => {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array(2);
            new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength, false);
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                if (headerSent) {
                    const combinedArray = new Uint8Array(udpSizeBuffer.byteLength + dnsQueryResult.byteLength);
                    combinedArray.set(udpSizeBuffer, 0);
                    combinedArray.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
                    webSocket.send(combinedArray);
                } else {
                    const combinedArray = new Uint8Array(resHeader.byteLength + udpSizeBuffer.byteLength + dnsQueryResult.byteLength);
                    combinedArray.set(resHeader, 0);
                    combinedArray.set(udpSizeBuffer, resHeader.byteLength);
                    combinedArray.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + udpSizeBuffer.byteLength);
                    webSocket.send(combinedArray);
                    headerSent = true;
                }
            }
        }
    }));
    const writer = transformStream.writable.getWriter();
    return {
        write: (chunk) => {
            writer.write(chunk);
        }
    };
};
const getConfig = (userID, hostName) => {
    return `ress://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
};
