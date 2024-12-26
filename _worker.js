import { connect } from 'cloudflare:sockets';
let cachedUserID = null;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
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
    readableWebStream.pipeTo(new WritableStream({
        write: async (chunk) => {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                await writeToSocket(remoteSocket.value, chunk);
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
const writeToSocket = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const handleTCPOutBound = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) => {
    const connectAndWrite = async (address, port) => {
        remoteSocket.value = connect({
            hostname: address,
            port: port,
            secureTransport: "on",
            allowHalfOpen: true
        });
        await writeToSocket(remoteSocket.value, clientData);
        return remoteSocket.value;
    };
    const tryConnect = async (address, port) => {
        const tcpSocket = await connectAndWrite(address, port);
        if (tcpSocket) {
            return forwardToData(tcpSocket, webSocket, resHeader);
        }
        return false;
    };
    const connected = await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote);
    if (!connected) {
        closeWebSocket(webSocket);
    }
};
const createStreamHandler = (webSocket, earlyHeader) => {
    let isCancel = false;
    const stream = new ReadableStream({
        start: (controller) => {
            webSocket.addEventListener('message', (event) => {
                if (isCancel) return;
                controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (isCancel) return;
                controller.close();
            });
            webSocket.addEventListener('error', (err) => {
                controller.error(err);
            });
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel: () => {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
    return stream;
};
const processRessHeader = (ressBuffer, userID) => {
    if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new DataView(ressBuffer, 0, 1).getUint8(0);
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer, 1, 16);
    if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = new DataView(ressBuffer, 17, 1).getUint8(0);
    const command = new DataView(ressBuffer, 18 + optLength, 1).getUint8(0);
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer, portIndex, 2).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(ressBuffer, addressIndex, 1).getUint8(0);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer, addressValueIndex, addressLength).join('.');
            break;
        case 2:
            addressLength = new DataView(ressBuffer, addressValueIndex, 1).getUint8(0);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                new Uint8Array(ressBuffer, addressValueIndex, addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const ipv6Parts = new Uint16Array(ressBuffer, addressValueIndex, addressLength / 2);
            addressValue = Array.from(ipv6Parts, part => part.toString(16)).join(':');
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
        write: async (chunk, controller) => {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('WebSocket is closed');
            }
            let dataToSend;
            if (resHeader) {
                dataToSend = new Uint8Array(resHeader.length + chunk.length);
                dataToSend.set(resHeader, 0);
                dataToSend.set(chunk, resHeader.length);
                resHeader = null;
            } else {
                dataToSend = chunk;
            }
            webSocket.send(dataToSend);
            hasData = true;
        },
    })).catch(() => {
        closeWebSocket(webSocket);
    });
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
