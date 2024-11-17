import { connect } from 'cloudflare:sockets';

class CacheManager {
    constructor() {
        this.caches = {
            userID: new Map(),
            responseHeader: new Map(),
            config: new Map(),
            base64: new Map()
        };
        this.MAX_SIZE = 1024;
    }

    get(type, key, generator) {
        const cache = this.caches[type];
        if (!cache.has(key)) {
            const value = generator();
            cache.set(key, value);
            this.pruneCache(cache);
        }
        return cache.get(key);
    }

    getUserID(userID) {
        return this.get('userID', userID, () => 
            new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)))
        );
    }

    getResponseHeader(version) {
        return this.get('responseHeader', version.toString(), () => 
            new Uint8Array([version[0], 0])
        );
    }

    getConfig(userID, hostName) {
        return this.get('config', `${userID}:${hostName}`, () =>
            `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
        );
    }

    getBase64Buffer(base64Str) {
        if (!base64Str) return { error: null };
        
        return this.get('base64', base64Str, () => {
            try {
                const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
                const binaryStr = atob(normalizedStr);
                const arrayBuffer = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    arrayBuffer[i] = binaryStr.charCodeAt(i);
                }
                return { earlyData: arrayBuffer.buffer, error: null };
            } catch (error) {
                return { error };
            }
        });
    }

    pruneCache(cache) {
        if (cache.size > this.MAX_SIZE) {
            const iterator = cache.keys();
            for (let i = 0; i < Math.floor(this.MAX_SIZE / 2); i++) {
                cache.delete(iterator.next().value);
            }
        }
    }
}

const cacheManager = new CacheManager();
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');

            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf), { status: 200 });
                    case `/${userID}`:
                        return new Response(
                            cacheManager.getConfig(userID, request.headers.get('Host')),
                            {
                                status: 200,
                                headers: { "Content-Type": "text/plain;charset=utf-8" }
                            }
                        );
                    default:
                        return new Response('Not found', { status: 404 });
                }
            }
            return await handleWebSocket(request);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};

function processHeader(buffer, userID) {
    if (buffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(buffer.slice(0, 1));
    const bufferUserID = cacheManager.getUserID(userID);
    
    if (new Uint8Array(buffer.slice(1, 17)).some((byte, i) => byte !== bufferUserID[i])) {
        return { hasError: true };
    }

    const optLength = new Uint8Array(buffer.slice(17, 18))[0];
    const command = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;
    
    if (command !== 1 && !isUDP) return { hasError: false };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
    const addressType = new Uint8Array(buffer.slice(portIndex + 2, portIndex + 3))[0];
    
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = portIndex + 3;

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            addressValue = Array.from(new Uint16Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)))
                .map(x => x.toString(16))
                .join(':');
            break;
        default:
            return { hasError: true };
    }

    return !addressValue ? { hasError: true } : {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        resVersion: version,
        isUDP
    };
}

async function handleWebSocket(request) {
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();

    const stream = makeReadableStream(server, request.headers.get('sec-websocket-protocol'));
    let remoteSocket = { value: null };
    let udpWriter = null;
    let isDns = false;

    stream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpWriter) return udpWriter(chunk);
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
                resVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processHeader(chunk, userID);

            if (hasError) return;
            if (isUDP) {
                isDns = portRemote === 53;
                if (!isDns) return;
            }

            const resHeader = cacheManager.getResponseHeader(resVersion);
            const clientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDP(server, resHeader);
                udpWriter = write;
                udpWriter(clientData);
                return;
            }

            handleTCP(remoteSocket, addressRemote, portRemote, clientData, server, resHeader);
        }
    })).catch(() => closeWS(server));

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

function makeReadableStream(ws, earlyHeader) {
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', evt => {
                if (!cancelled) controller.enqueue(evt.data);
            });
            
            ws.addEventListener('close', () => {
                closeWS(ws);
                if (!cancelled) controller.close();
            });
            
            ws.addEventListener('error', err => controller.error(err));
            
            const { earlyData, error } = cacheManager.getBase64Buffer(earlyHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel() {
            cancelled = true;
            closeWS(ws);
        }
    });
}

async function handleTCP(remoteSocket, address, port, data, ws, header) {
    const connect = async (addr, p) => {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({
                hostname: addr,
                port: p
            });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
        return remoteSocket.value;
    };

    const forward = async (addr, p) => {
        const socket = await connect(addr, p);
        return forwardData(socket, ws, header);
    };

    try {
        if (!await forward(address, port) && !await forward(proxyIP, port)) {
            closeWS(ws);
        }
    } catch {
        closeWS(ws);
    }
}

async function forwardData(socket, ws, header) {
    let hasData = false;
    await socket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            if (ws.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket closed');
            }
            
            const buffer = header ? 
                (() => {
                    const tmp = new Uint8Array(header.byteLength + chunk.byteLength);
                    tmp.set(header, 0);
                    tmp.set(chunk, header.byteLength);
                    header = null;
                    return tmp;
                })() : chunk;
            
            ws.send(buffer);
            hasData = true;
        }
    })).catch(() => closeWS(ws));
    
    return hasData;
}

async function handleUDP(ws, header) {
    let headerSent = false;
    const writer = new WritableStream({
        async write(chunk) {
            try {
                const response = await queryDNS(chunk);
                if (response && ws.readyState === WebSocket.OPEN) {
                    ws.send(createDNSResponse(header, response, headerSent));
                    headerSent = true;
                }
            } catch {
                closeWS(ws);
            }
        }
    }).getWriter();

    return { write: chunk => writer.write(chunk).catch(console.error) };
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

function createDNSResponse(header, response, headerSent) {
    const size = new Uint8Array([(response.byteLength >> 8) & 0xff, response.byteLength & 0xff]);
    const buffer = new Uint8Array((headerSent ? 0 : header.byteLength) + size.byteLength + response.byteLength);
    
    let offset = 0;
    if (!headerSent) {
        buffer.set(header, 0);
        offset = header.byteLength;
    }
    
    buffer.set(size, offset);
    buffer.set(new Uint8Array(response), offset + size.byteLength);
    
    return buffer;
}

function closeWS(socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}
