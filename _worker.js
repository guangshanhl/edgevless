import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
    async fetch(request, env, ctx) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';

        try {
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader && upgradeHeader === 'websocket') {
                return await handleWebSocketRequest(request, userID, proxyIP);
            }

            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`: {
                    const config = getConfig(userID, request.headers.get('Host'));
                    return new Response(config, {
                        status: 200,
                        headers: { "Content-Type": "text/plain;charset=utf-8" },
                    });
                }
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

async function handleWebSocketRequest(request, userID, proxyIP) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);

    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;

    readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const { hasError, portRemote, addressRemote, rawDataIndex, ressVersion, isUDP } = processRessHeader(chunk, userID);
            if (hasError) return;
			const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isUDP && portRemote === 53) {
                isDns = true;
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }

            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
    })).catch(() => closeWebSocket(webSocket));

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    const connectAndWrite = async (address, port) => {
        remoteSocket.value = connect({ hostname: address, port });
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    };

    const tryConnect = async (address, port) => {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    };

    if (!(await tryConnect(addressRemote, portRemote)) && !(await tryConnect(proxyIP, portRemote))) {
        closeWebSocket(webSocket);
    }
}

function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;

    const stream = new ReadableStream({
        start(controller) {
            const handleMessage = (event) => {
                if (!isCancel) controller.enqueue(event.data);
            };

            const handleClose = () => {
                if (!isCancel) {
                    controller.close();
                    closeWebSocket(webSocket);
                }
            };

            const handleError = (err) => {
                controller.error(err);
                closeWebSocket(webSocket);
            };

            webSocket.addEventListener('message', handleMessage);
            webSocket.addEventListener('close', handleClose);
            webSocket.addEventListener('error', handleError);

            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            if (!isCancel) {
                isCancel = true;
                closeWebSocket(webSocket);
            }
        }
    });

    return stream;
}

function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(ressBuffer.slice(0, 1));
    const cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) return { hasError: true };

    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    const addressIndex = portIndex + 2;
    const addressType = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1))[0];
    const addressValueIndex = addressIndex + 1;

    let addressValue = '';
    switch (addressType) {
        case 1:
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 4)).join('.');
            break;
        case 2:
            const addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex + 1, addressValueIndex + 1 + addressLength));
            break;
        case 3:
            const ipv6 = [];
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + 16));
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
        portRemote,
        rawDataIndex: addressValueIndex + (addressType === 2 ? addressLength + 1 : addressType === 1 ? 4 : 16),
        ressVersion: version,
        isUDP,
    };
}

async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                controller.error('WebSocket is closed');
            }
            const bufferToSend = resHeader
                ? new Uint8Array([...resHeader, ...new Uint8Array(chunk)])
                : chunk;

            webSocket.send(bufferToSend);
            resHeader = null;
            hasData = true;
        },
    })).catch(() => closeWebSocket(webSocket));
    return hasData;
}

function base64ToBuffer(base64Str) {
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const arrayBuffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}

async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;
                if (chunk.byteLength < nextOffset) break;

                const udpData = chunk.slice(offset + 2, nextOffset);
                offset = nextOffset;
                controller.enqueue(udpData);
            }
        }
    });

    const writer = transformStream.writable.getWriter();
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            const payload = headerSent
                ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
            headerSent = true;
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    }));

    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
