const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

let cachedUserID;
let cachedEncoder = new TextEncoder();
let cachedDecoder = new TextDecoder();

export default {
    async fetch(request, env, ctx) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';

        try {
            if (request.headers.get('Upgrade') === 'websocket') {
                return handleWebSocket(request, userID, proxyIP);
            }

            const url = new URL(request.url);
            
            const routes = new Map([
                ['/', () => new Response(JSON.stringify(request.cf), { 
                    status: 200,
                    headers: {'Content-Type': 'application/json'}
                })],
                [`/${userID}`, () => new Response(
                    getConfig(userID, request.headers.get('Host')), {
                    status: 200,
                    headers: {'Content-Type': 'text/plain;charset=utf-8'}
                })]
            ]);

            const handler = routes.get(url.pathname);
            return handler ? handler() : new Response('Not found', { status: 404 });

        } catch (err) {
            return new Response(err.stack, { status: 500 });
        }
    }
};

async function handleWebSocket(request, userID, proxyIP) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    server.accept();

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    
    const state = {
        remoteSocket: null,
        udpWrite: null,
        isDns: false
    };

    setupWebSocketStream(server, earlyHeader, state, userID, proxyIP);

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

function setupWebSocketStream(webSocket, earlyHeader, state, userID, proxyIP) {
    const stream = makeWebStream(webSocket, earlyHeader);
    
    stream.pipeTo(new WritableStream({
        async write(chunk) {
            if (state.isDns && state.udpWrite) {
                return state.udpWrite(chunk);
            }

            if (state.remoteSocket) {
                const writer = state.remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const header = processRessHeader(chunk, userID);
            if (header.hasError) return;

            if (header.isUDP) {
                if (header.portRemote === 53) {
                    state.isDns = true;
                    const { write } = await handleUDPOutBound(webSocket, new Uint8Array([header.ressVersion[0], 0]));
                    state.udpWrite = write;
                    state.udpWrite(chunk.slice(header.rawDataIndex));
                }
                return;
            }

            handleTCPOutBound(
                state,
                header.addressRemote,
                header.portRemote,
                chunk.slice(header.rawDataIndex),
                webSocket,
                new Uint8Array([header.ressVersion[0], 0]),
                proxyIP
            );
        }
    })).catch(() => closeWebSocket(webSocket));
}

function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (!isCancel) controller.enqueue(event.data);
            });

            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (!isCancel) controller.close();
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
        cancel() {
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
}

function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) {
        return { hasError: true };
    }

    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }

    const version = new Uint8Array(ressBuffer.slice(0, 1));
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    
    if (bufferUserID.some((byte, index) => byte !== cachedUserID[index])) {
        return { hasError: true };
    }

    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    const isUDP = command === 2;
    if (!isUDP && command !== 1) {
        return { hasError: true };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressType = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1))[0];
    
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
            addressValue = cachedDecoder.decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const ipv6 = [];
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
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
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: version,
        isUDP,
    };
}

async function handleTCPOutBound(state, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) {
    async function connectAndWrite(address, port) {
        if (!state.remoteSocket || state.remoteSocket.closed) {
            state.remoteSocket = connect({ hostname: address, port });
        }
        const writer = state.remoteSocket.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return state.remoteSocket;
    }

    try {
        const socket = await connectAndWrite(addressRemote, portRemote) || 
                      await connectAndWrite(proxyIP, portRemote);
        
        if (!socket) {
            closeWebSocket(webSocket);
            return;
        }

        let hasData = false;
        const transform = new TransformStream({
            transform(chunk, controller) {
                if (resHeader) {
                    const data = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    data.set(resHeader);
                    data.set(chunk, resHeader.byteLength);
                    controller.enqueue(data);
                    resHeader = null;
                } else {
                    controller.enqueue(chunk);
                }
            }
        });

        await socket.readable
            .pipeThrough(transform)
            .pipeTo(new WritableStream({
                write(chunk) {
                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        webSocket.send(chunk);
                        hasData = true;
                    }
                }
            }));

        return hasData;
    } catch {
        closeWebSocket(webSocket);
    }
}

async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partChunk = null;

    const transform = new TransformStream({
        transform(chunk, controller) {
            if (partChunk) {
                chunk = new Uint8Array([...partChunk, ...chunk]);
                partChunk = null;
            }

            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partChunk = chunk.slice(offset);
                    break;
                }

                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;

                if (chunk.byteLength < nextOffset) {
                    partChunk = chunk.slice(offset);
                    break;
                }

                controller.enqueue(chunk.slice(offset + 2, nextOffset));
                offset = nextOffset;
            }
        }
    });

    transform.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });

            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([
                (dnsQueryResult.byteLength >> 8) & 0xff, 
                dnsQueryResult.byteLength & 0xff
            ]);

            const payload = headerSent
                ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);

            headerSent = true;

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    }));

    const writer = transform.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

function base64ToBuffer(base64Str) {
    if (!base64Str) return { error: null };
    
    try {
        const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const arr = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            arr[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arr.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
