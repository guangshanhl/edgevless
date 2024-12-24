import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

let cachedUserID = null;

// Helper functions can be moved outside of the export for cleaner code
const getUpgradeHeader = (request) => request.headers.get('Upgrade');

export default {
    async fetch(request, env, ctx) {
        try {
            const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
            const proxyIP = env.PROXYIP ?? '';
            const upgradeHeader = getUpgradeHeader(request);

            if (upgradeHeader === 'websocket') {
                return await handleWebSocket(request, userID, proxyIP);
            }

            const url = new URL(request.url);
            switch(url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`:
                    return new Response(getConfig(userID, request.headers.get('Host')), {
                        status: 200,
                        headers: { "Content-Type": "text/plain;charset=utf-8" }
                    });
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};

async function handleWebSocket(request, userID, proxyIP) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';

    const readableWebStream = createStreamHandler(webSocket, earlyHeader);
    let remoteSocket = null;
    let udpWrite = null;
    let isDns = false;

    await readableWebStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket) {
                await remoteSocket.writable.write(chunk);
                return;
            }

            const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = processRessHeader(chunk, userID);
            if (hasError) return;

            if (isUDP) {
                if (portRemote !== 53) return;
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

            await handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP);
        }
    }));

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) {
    const connectAndWrite = async (address, port) => {
        remoteSocket = connect({ hostname: address, port });
        await remoteSocket.writable.write(clientData);
        return remoteSocket;
    };

    const tryConnect = async (address, port) => {
        const tcpSocket = await connectAndWrite(address, port);
        if (tcpSocket) {
            return forwardToData(tcpSocket, webSocket, resHeader);
        }
        return false;
    };

    if (!(await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote))) {
        closeWebSocket(webSocket);
    }
}

function createStreamHandler(webSocket, earlyHeader) {
    let isCancel = false;
    return new ReadableStream({
        start(controller) {
			const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }

            webSocket.addEventListener('message', (event) => {
                if (!isCancel) controller.enqueue(event.data);
            });
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (!isCancel) controller.close();
            });
            webSocket.addEventListener('error', (err) => controller.error(err));
        },
        cancel() {
            if (!isCancel) {
                isCancel = true;
                closeWebSocket(webSocket);
            }
        }
    });
}

function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };

    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }

    const view = new DataView(ressBuffer);
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    if (bufferUserID.some((byte, index) => byte !== cachedUserID[index])) return { hasError: true };

    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    const isUDP = command === 2;
    if (command !== 1 && !isUDP) return { hasError: false };

    const portIndex = 18 + optLength + 1;
    const portRemote = view.getUint16(portIndex);
    let addressIndex = portIndex + 2;
    const addressType = view.getUint8(addressIndex++);

    let addressValue = '', addressLength = 0;
    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + addressLength)).join('.');
            break;
        case 2: // Domain name
            addressLength = view.getUint8(addressIndex++);
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressIndex, addressIndex + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            addressValue = Array.from({ length: 8 }, (_, i) => view.getUint16(addressIndex + i * 2).toString(16)).join(':');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressIndex + addressLength,
        ressVersion: version,
        isUDP,
    };
}

async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        write(chunk) {
            if (webSocket.readyState !== WS_READY_STATE_OPEN) throw new Error('WebSocket is closed');

            let dataToSend = resHeader ? 
                new Uint8Array(resHeader.length + chunk.length).set([...resHeader, ...chunk]) :
                chunk;
            webSocket.send(dataToSend);
            hasData = true;
            resHeader = null;
        },
    })).catch(() => closeWebSocket(webSocket));
    return hasData;
}

function base64ToBuffer(base64Str) {
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        return { earlyData: new Uint8Array(binaryStr.length).map((_, i) => binaryStr.charCodeAt(i)), error: null };
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
            for (let index = 0; index < chunk.byteLength;) {
                const length = new DataView(chunk.buffer).getUint16(index);
                controller.enqueue(chunk.subarray(index + 2, index + 2 + length));
                index += 2 + length;
            }
        },
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
            });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array(2);
            new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength, false);

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                const combinedArray = headerSent ? 
                    new Uint8Array(udpSizeBuffer.length + dnsQueryResult.byteLength) :
                    new Uint8Array(resHeader.length + udpSizeBuffer.length + dnsQueryResult.byteLength);

                if (!headerSent) {
                    combinedArray.set(resHeader, 0);
                    headerSent = true;
                }
                combinedArray.set(udpSizeBuffer, combinedArray.byteOffset);
                combinedArray.set(new Uint8Array(dnsQueryResult), combinedArray.byteOffset + udpSizeBuffer.length);
                webSocket.send(combinedArray);
            }
        }
    }));

    const writer = transformStream.writable.getWriter();
    return {
        write: (chunk) => writer.write(chunk)
    };
}

function getConfig(userID, hostName) {
    return `ress://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
