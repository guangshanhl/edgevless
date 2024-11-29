import { connect } from 'cloudflare:sockets';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env, ctx) {
        userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;   
        try {
            if(request.headers.get('Upgrade') === 'websocket') {
                return await handleWebSocket(request);
            }
            const url = new URL(request.url);
            const routes = new Map([
                ['/', () => new Response(JSON.stringify(request.cf))],
                [`/${userID}`, () => {
                    const config = getConfig(userID, request.headers.get('Host'));
                    return new Response(config, {
                        headers: {'Content-Type': 'text/plain;charset=utf-8'}
                    });
                }]
            ]);
            const handler = routes.get(url.pathname);
            return handler ? handler() : new Response('Not found', {status: 404});
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
async function handleWebSocket(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) {
                udpWrite(chunk);
                return;
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
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
            address = addressRemote;
            if (hasError) {
                return;
            }
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    return;
                }
            }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({ hostname: address, port });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    try {
        if (!(await tryConnect(addressRemote, portRemote)) && proxyIP && !(await tryConnect(proxyIP, portRemote))) {
            closeWebSocket(webSocket);
        }
    } catch (error) {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isActive = true;
    const handleEvent = (event, handler) => {
        if (!isActive) return;
        handler(event);
    };
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => handleEvent(event, (event) => {
                controller.enqueue(event.data);
            }));
            webSocket.addEventListener('close', () => handleEvent(null, () => {
                closeWebSocket(webSocket);
                controller.close();
                isActive = false;
            }));
            webSocket.addEventListener('error', (error) => handleEvent(error, (error) => {
                controller.error(error);
                isActive = false;
            }));
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (!error && earlyData) {
                    controller.enqueue(earlyData);
                }
            }
        },
        cancel() {
            isActive = false;
            closeWebSocket(webSocket);
        }
    });
}
let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) {
        return { hasError: true };
    }
    const optLength = ressBuffer[17];
    const command = ressBuffer[18 + optLength];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = (ressBuffer[portIndex] << 8) | ressBuffer[portIndex + 1];
    const addressIndex = portIndex + 2;
    const addressType = ressBuffer[addressIndex];
    let addressLength = 0;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = Array.from(new Uint8Array(ressBuffer.slice(addressIndex + 1, addressIndex + 1 + addressLength)))
                                .join('.');
            break;
        case 2:
            addressLength = ressBuffer[addressIndex + 1];
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressIndex + 2, addressIndex + 2 + addressLength));
            break;
        case 3:
            addressLength = 16;
            const ipv6Segments = [];
            for (let i = 0; i < 8; i++) {
                ipv6Segments.push(((ressBuffer[addressIndex + 1 + (i * 2)] << 8) | ressBuffer[addressIndex + 2 + (i * 2)]).toString(16));
            }
            addressValue = ipv6Segments.join(':');
            break;
        default:
            return { hasError: true };
    }
    if (!addressValue) {
        return { hasError: true };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressIndex + 1 + addressLength,
        ressVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                let bufferToSend;

                if (resHeader) {
                    bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    bufferToSend.set(new Uint8Array(resHeader), 0);
                    bufferToSend.set(new Uint8Array(chunk), resHeader.byteLength);
                    resHeader = null;
                } else {
                    bufferToSend = new Uint8Array(chunk);
                }

                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(bufferToSend.buffer);
                    hasData = true;
                }
            },
        }));
    } catch (error) {
        closeWebSocket(webSocket);
    }
    return hasData;
}
function base64ToBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const arrayBuffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
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
            if (chunk.byteLength < 2) return;
            const udpPacketLength = (chunk[0] << 8) | chunk[1];
            if (chunk.byteLength < 2 + udpPacketLength) return;
            const udpData = chunk.slice(2, 2 + udpPacketLength);
            controller.enqueue(udpData);
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                const response = await fetch('https://cloudflare-dns.com/dns-query', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/dns-message',
                        'Accept': 'application/dns-message'
                    },
                    body: chunk
                });
                if (!response.ok) {
                    throw new Error(`DNS query failed: ${response.status}`);
                }
                const dnsQueryResult = await response.arrayBuffer();
                const udpSizeBuffer = new Uint8Array([
                    (dnsQueryResult.byteLength >> 8) & 0xff,
                    dnsQueryResult.byteLength & 0xff
                ]);
                const payload = headerSent 
                    ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                    : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
                headerSent = true;
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(payload.buffer);
                }
            } catch (error) {
                closeWebSocket(webSocket);
                console.error('DNS UDP has error:', error);
            }
        }
    })).catch(() => {
        closeWebSocket(webSocket);
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
