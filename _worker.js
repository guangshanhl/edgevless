import { connect } from 'cloudflare:sockets';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const STREAM_OPTS = {
    highWaterMark: 65535,
    size(chunk) {
        return chunk.byteLength;
    }
};
const createOptimizedTransform = (resHeader) => {
    let pendingChunks = [];
    let totalSize = 0;
    const BATCH_SIZE = 64 * 1024;  
    return new TransformStream({
        transform(chunk, controller) {
            if (resHeader) {
                const data = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                data.set(resHeader);
                data.set(chunk, resHeader.byteLength);
                controller.enqueue(data);
                resHeader = null;
            } else {
                pendingChunks.push(chunk);
                totalSize += chunk.byteLength;
                
                if (totalSize >= BATCH_SIZE) {
                    const combinedData = new Uint8Array(totalSize);
                    let offset = 0;
                    for (const chunk of pendingChunks) {
                        combinedData.set(chunk, offset);
                        offset += chunk.byteLength;
                    }
                    controller.enqueue(combinedData);
                    pendingChunks = [];
                    totalSize = 0;
                }
            }
        },
        flush(controller) {
            if (pendingChunks.length > 0) {
                const combinedData = new Uint8Array(totalSize);
                let offset = 0;
                for (const chunk of pendingChunks) {
                    combinedData.set(chunk, offset);
                    offset += chunk.byteLength;
                }
                controller.enqueue(combinedData);
            }
        }
    }, STREAM_OPTS);
};

let cachedUserID;
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            
            if (request.headers.get('Upgrade') === 'websocket') {
                return await handleWebSocket(request);
            }
            
            const url = new URL(request.url);
            const routes = new Map([
                ['/', () => new Response(JSON.stringify(request.cf), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Cache-Control': 'public, max-age=1800'
                    }
                })],
                [`/${userID}`, () => new Response(
                    getConfig(userID, request.headers.get('Host')), {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/plain;charset=utf-8',
                        'Cache-Control': 'private, no-cache'
                    }
                })]
            ]);

            const handler = routes.get(url.pathname);
            return handler ? handler() : new Response('Not found', { status: 404 });
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    }
};

async function handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const state = {
        remoteSocket: null,
        udpWrite: null,
        isDns: false,
        chunks: []
    };

    setupWebSocketStream(server, request.headers.get('sec-websocket-protocol') || '', state);

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

function setupWebSocketStream(webSocket, earlyHeader, state) {
    const stream = makeOptimizedWebStream(webSocket, earlyHeader);
    
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

            if (header.isUDP && header.portRemote === 53) {
                state.isDns = true;
                const { write } = await handleOptimizedUDPOutBound(webSocket, header.ressVersion);
                state.udpWrite = write;
                state.udpWrite(chunk.slice(header.rawDataIndex));
                return;
            }

            handleOptimizedTCPOutBound(state, header, chunk, webSocket);
        }
    }, STREAM_OPTS)).catch(() => closeWebSocket(webSocket));
}

function makeOptimizedWebStream(webSocket, earlyHeader) {
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => controller.enqueue(event.data));
            webSocket.addEventListener('close', () => {
                controller.close();
                closeWebSocket(webSocket);
            });
            webSocket.addEventListener('error', err => controller.error(err));

            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    }, STREAM_OPTS);
}

async function handleOptimizedTCPOutBound(state, header, chunk, webSocket) {
    try {
        if (!state.remoteSocket || state.remoteSocket.closed) {
            state.remoteSocket = await connect({
                hostname: header.addressRemote,
                port: header.portRemote
            });
        }

        const writer = state.remoteSocket.writable.getWriter();
        await writer.write(chunk.slice(header.rawDataIndex));
        writer.releaseLock();

        const transform = createOptimizedTransform(new Uint8Array([header.ressVersion[0], 0]));
        
        await state.remoteSocket.readable
            .pipeThrough(transform)
            .pipeTo(new WritableStream({
                write(chunk) {
                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        webSocket.send(chunk);
                    }
                }
            }, STREAM_OPTS));

    } catch {
        closeWebSocket(webSocket);
    }
}
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
    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
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
    if (!addressValue) {
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
}
async function handleOptimizedUDPOutBound(webSocket, ressVersion) {
    let headerSent = false;
    const transform = new TransformStream({
        transform(chunk, controller) {
            const size = new DataView(new ArrayBuffer(2));
            size.setUint16(0, chunk.byteLength);
            controller.enqueue(new Uint8Array([...new Uint8Array(size.buffer), ...chunk]));
        }
    }, STREAM_OPTS);

    transform.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });

            const result = await resp.arrayBuffer();
            const payload = headerSent
                ? new Uint8Array(result)
                : new Uint8Array([ressVersion[0], 0, ...new Uint8Array(result)]);
            
            headerSent = true;

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    }, STREAM_OPTS));

    const writer = transform.writable.getWriter();
    return { write: chunk => writer.write(chunk) };
}

function base64ToBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
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
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
