import { connect } from 'cloudflare:sockets';

const DEFAULT_USER_ID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

export default {
    async fetch(request, env, ctx) {
        const userID = env.UUID || DEFAULT_USER_ID;
        const proxyIP = env.PROXYIP || '';
        const upgradeHeader = request.headers.get('Upgrade');

        if (upgradeHeader !== 'websocket') {
            const url = new URL(request.url);
            
            if (url.pathname === '/') {
                return new Response(JSON.stringify(request.cf), { status: 200 });
            }
            
            if (url.pathname === `/${userID}`) {
                return new Response(
                    getConfig(userID, request.headers.get('Host')), 
                    {
                        status: 200,
                        headers: { "Content-Type": "text/plain;charset=utf-8" }
                    }
                );
            }
            
            return new Response('Not found', { status: 404 });
        }

        return handleWebSocket(request, userID, proxyIP);
    }
};

async function handleWebSocket(request, userID, proxyIP) {
    const { client, server } = Object.fromEntries(
        Object.entries(new WebSocketPair()).map(([k, v], i) => [i ? 'server' : 'client', v])
    );
    
    server.accept();
    
    const stream = createWebSocketStream(server, request.headers.get('sec-websocket-protocol'));
    
    const socketState = {
        remote: null,
        udpWriter: null,
        isDns: false
    };

    stream.pipeTo(new WritableStream({
        write: (chunk) => handleStreamData(chunk, socketState, server, userID, proxyIP),
        close: () => {},
        abort: () => closeWebSocket(server)
    })).catch(() => closeWebSocket(server));

    return new Response(null, { status: 101, webSocket: client });
}

function createWebSocketStream(webSocket, earlyHeader) {
    let isCanceled = false;
    
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', event => 
                !isCanceled && controller.enqueue(event.data));
            
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                !isCanceled && controller.close();
            });
            
            webSocket.addEventListener('error', err => controller.error(err));
            
            const { earlyData, error } = parseBase64(earlyHeader);
            if (error) controller.error(error);
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            isCanceled = true;
            closeWebSocket(webSocket);
        }
    });
}

async function handleStreamData(chunk, state, webSocket, userID, proxyIP) {
    if (state.isDns && state.udpWriter) {
        return state.udpWriter(chunk);
    }
    
    if (state.remote) {
        const writer = state.remote.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
    }

    const header = parseHeader(chunk, userID);
    if (header.hasError) return;

    if (header.isUDP) {
        if (header.portRemote === 53) {
            state.isDns = true;
            const { write } = await setupUDPHandler(webSocket, header.resVersion);
            state.udpWriter = write;
            state.udpWriter(chunk.slice(header.rawDataIndex));
        }
        return;
    }

    handleTCPConnection(state, header, chunk, webSocket, proxyIP);
}

async function handleTCPConnection(state, header, chunk, webSocket, proxyIP) {
    const connectToAddress = async (address, port) => {
        if (!state.remote || state.remote.closed) {
            state.remote = connect({ hostname: address, port });
        }
        const writer = state.remote.writable.getWriter();
        await writer.write(chunk.slice(header.rawDataIndex));
        writer.releaseLock();
        return state.remote;
    };

    const tryConnect = async (address, port) => {
        const socket = await connectToAddress(address, port);
        return forwardData(socket, webSocket, header.resVersion);
    };

    try {
        if (!await tryConnect(header.addressRemote, header.portRemote)) {
            if (!await tryConnect(proxyIP, header.portRemote)) {
                closeWebSocket(webSocket);
            }
        }
    } catch {
        closeWebSocket(webSocket);
    }
}

async function forwardData(socket, webSocket, resHeader) {
    let hasData = false;
    
    await socket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket closed');
            }

            const data = resHeader ? 
                concatBuffers(resHeader, chunk) : 
                chunk;
            
            webSocket.send(data);
            resHeader = null;
            hasData = true;
        }
    })).catch(() => closeWebSocket(webSocket));

    return hasData;
}

function parseHeader(buffer, userID) {
    if (buffer.byteLength < 24) return { hasError: true };
    
    const version = buffer.slice(0, 1);
    const id = buffer.slice(1, 17);
    const optLength = buffer[17];
    const command = buffer[18 + optLength];
    
    if (!validateUserID(id, userID)) return { hasError: true };
    
    const portStart = 18 + optLength + 1;
    const port = new DataView(buffer.slice(portStart, portStart + 2)).getUint16(0);
    
    const addressInfo = parseAddress(buffer, portStart + 2);
    if (!addressInfo.address) return { hasError: true };
    
    return {
        hasError: false,
        addressRemote: addressInfo.address,
        portRemote: port,
        rawDataIndex: addressInfo.endIndex,
        resVersion: new Uint8Array(version),
        isUDP: command === 2
    };
}

function parseAddress(buffer, start) {
    const type = buffer[start];
    let address = '', length = 0;
    const valueStart = start + 1;

    switch (type) {
        case 1: // IPv4
            length = 4;
            address = new Uint8Array(buffer.slice(valueStart, valueStart + length)).join('.');
            break;
        case 2: // Domain
            length = buffer[valueStart];
            address = new TextDecoder().decode(buffer.slice(valueStart + 1, valueStart + 1 + length));
            length += 1;
            break;
        case 3: // IPv6
            length = 16;
            address = formatIPv6(new DataView(buffer.slice(valueStart, valueStart + length)));
            break;
    }

    return {
        address,
        endIndex: valueStart + length
    };
}

async function setupUDPHandler(webSocket, resHeader) {
    let headerSent = false;
    
    const writer = new WritableStream({
        async write(chunk) {
            try {
                const response = await queryDNS(chunk);
                if (response && webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(formatDNSResponse(resHeader, response, headerSent));
                    headerSent = true;
                }
            } catch {
                closeWebSocket(webSocket);
            }
        }
    }).getWriter();

    return { 
        write: chunk => writer.write(chunk).catch(console.error) 
    };
}

async function queryDNS(request) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    try {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/dns-message' },
            body: request,
            signal: controller.signal
        });
        clearTimeout(timeout);
        return await response.arrayBuffer();
    } catch (error) {
        throw error;
    }
}

function formatDNSResponse(header, response, headerSent) {
    const size = new Uint8Array([
        (response.byteLength >> 8) & 0xff, 
        response.byteLength & 0xff
    ]);
    
    const payload = new Uint8Array(
        (headerSent ? 0 : header.byteLength) + 
        size.byteLength + 
        response.byteLength
    );
    
    let offset = 0;
    if (!headerSent) {
        payload.set(header, 0);
        offset = header.byteLength;
    }
    
    payload.set(size, offset);
    payload.set(new Uint8Array(response), offset + size.byteLength);
    
    return payload;
}

function parseBase64(str) {
    if (!str) return { error: null };
    
    try {
        const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(normalized);
        const buffer = new Uint8Array(binary.length);
        
        for (let i = 0; i < binary.length; i++) {
            buffer[i] = binary.charCodeAt(i);
        }
        
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocket(socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}

function validateUserID(buffer, userID) {
    const id = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    return buffer.every((byte, index) => byte === id[index]);
}

function formatIPv6(dataView) {
    const segments = [];
    for (let i = 0; i < 8; i++) {
        segments.push(dataView.getUint16(i * 2).toString(16));
    }
    return segments.join(':');
}

function concatBuffers(header, data) {
    const result = new Uint8Array(header.byteLength + data.byteLength);
    result.set(header, 0);
    result.set(new Uint8Array(data), header.byteLength);
    return result;
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
