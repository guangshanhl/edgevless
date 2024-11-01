import { connect } from 'cloudflare:sockets';

const BUFFER_SIZE = 16384;
const VLESS_VERSION = new Uint8Array([0]);
const WS_READY_STATE = {
    OPEN: 1,
    CLOSING: 2
};
const DNS_CACHE_TIME = 300000; // 5分钟缓存
const configCache = new Map();
const dnsCache = new Map();

export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        
        const url = new URL(request.url);
        const upgrade = request.headers.get('Upgrade');
        
        const handlers = {
            'websocket': () => handleWsRequest(request, userID, proxyIP),
            'default': () => handleHttpRequest(request, userID, url)
        };
        
        return (handlers[upgrade?.toLowerCase()] || handlers.default)();
    }
};

class VlessSocket {
    constructor(webSocket) {
        this.webSocket = webSocket;
        this.buffer = new Uint8Array(BUFFER_SIZE);
        this.offset = 0;
    }

    send(data) {
        if (this.webSocket.readyState === WS_READY_STATE.OPEN) {
            this.webSocket.send(data);
            return true;
        }
        return false;
    }

    close() {
        if (this.webSocket.readyState <= WS_READY_STATE.CLOSING) {
            this.webSocket.close();
        }
    }

    appendToBuffer(chunk) {
        const remaining = BUFFER_SIZE - this.offset;
        if (chunk.byteLength <= remaining) {
            this.buffer.set(new Uint8Array(chunk), this.offset);
            this.offset += chunk.byteLength;
            return true;
        }
        return false;
    }

    clearBuffer() {
        this.offset = 0;
    }

    getBufferView() {
        return this.buffer.subarray(0, this.offset);
    }
}

class StreamHandler {
    static createStream(vlessSocket, earlyHeader) {
        return new ReadableStream({
            start(controller) {
                if (earlyHeader) {
                    const { data, error } = StreamHandler.decodeEarlyData(earlyHeader);
                    if (error) {
                        controller.error(error);
                        return;
                    }
                    if (data) controller.enqueue(data);
                }

                vlessSocket.webSocket.addEventListener('message', event => {
                    controller.enqueue(event.data);
                });

                vlessSocket.webSocket.addEventListener('close', () => {
                    vlessSocket.close();
                    controller.close();
                });

                vlessSocket.webSocket.addEventListener('error', event => {
                    controller.error(event);
                });
            },
            cancel() {
                vlessSocket.close();
            }
        });
    }

    static decodeEarlyData(data) {
        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            return { data, error: null };
        }

        try {
            const binary = atob(data.replace(/[-_]/g, m => m === '-' ? '+' : '/'));
            const buffer = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                buffer[i] = binary.charCodeAt(i);
            }
            return { data: buffer.buffer, error: null };
        } catch (error) {
            return { error };
        }
    }
}

class DNSHandler {
    static async query(domain) {
        const cached = dnsCache.get(domain);
        if (cached && Date.now() - cached.timestamp < DNS_CACHE_TIME) {
            return cached.data;
        }

        const response = await fetch('https://1.1.1.1/dns-query', {
            method: 'POST',
            headers: {
                'accept': 'application/dns-message',
                'content-type': 'application/dns-message',
            },
            body: await this.createQuery(domain)
        });

        const data = await response.arrayBuffer();
        dnsCache.set(domain, {
            timestamp: Date.now(),
            data
        });

        return data;
    }

    static async createQuery(domain) {
        const buffer = new Uint8Array(2 + domain.length + 4);
        const view = new DataView(buffer.buffer);
        let offset = 0;

        view.setUint16(offset, Math.random() * 65535); // Transaction ID
        offset += 2;

        const domainParts = domain.split('.');
        for (const part of domainParts) {
            buffer[offset++] = part.length;
            for (let i = 0; i < part.length; i++) {
                buffer[offset++] = part.charCodeAt(i);
            }
        }
        buffer[offset++] = 0; // Root domain

        view.setUint16(offset, 1);  // Type A
        view.setUint16(offset + 2, 1); // Class IN

        return buffer;
    }
}

async function handleWsRequest(request, userID, proxyIP) {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();

    const vlessSocket = new VlessSocket(webSocket);
    const readableStream = StreamHandler.createStream(
        vlessSocket, 
        request.headers.get('sec-websocket-protocol')
    );

    let remoteSocket = { value: null };
    let udpWriter = null;

    const writableStream = new WritableStream({
        async write(chunk) {
            if (udpWriter) {
                return udpWriter(chunk);
            }

            if (remoteSocket.value) {
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }

            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = 
                processHeader(chunk, userID);

            if (hasError) return;

            const resHeader = new Uint8Array([passVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);

            if (isUDP && port === 53) {
                const { write } = await handleDNS(vlessSocket, resHeader);
                udpWriter = write;
                udpWriter(clientData);
                return;
            }

            await handleTCP(remoteSocket, address, port, clientData, vlessSocket, resHeader, proxyIP);
        }
    });

    readableStream.pipeTo(writableStream).catch(() => {
        vlessSocket.close();
    });

    return new Response(null, { 
        status: 101, 
        webSocket: client 
    });
}

async function writeToRemote(socket, chunk) {
    const writer = socket.writable.getWriter();
    try {
        await writer.write(chunk);
    } finally {
        writer.releaseLock();
    }
}

async function handleTCP(remoteSocket, address, port, clientData, vlessSocket, resHeader, proxyIP) {
    const tryConnect = async (addr) => {
        try {
            if (!remoteSocket.value || remoteSocket.value.closed) {
                remoteSocket.value = await connect({ hostname: addr, port });
            }
            await writeToRemote(remoteSocket.value, clientData);
            return await forwardData(remoteSocket.value, vlessSocket, resHeader);
        } catch {
            return false;
        }
    };

    if (!(await tryConnect(address)) && proxyIP && !(await tryConnect(proxyIP))) {
        vlessSocket.close();
    }
}

async function forwardData(remoteSocket, vlessSocket, resHeader) {
    let hasData = false;
    let headerSent = Boolean(resHeader);

    const writableStream = new WritableStream({
        write(chunk) {
            if (vlessSocket.webSocket.readyState !== WS_READY_STATE.OPEN) {
                throw new Error("WebSocket closed");
            }

            if (headerSent) {
                const buffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                buffer.set(resHeader);
                buffer.set(new Uint8Array(chunk), resHeader.byteLength);
                vlessSocket.send(buffer);
                headerSent = false;
            } else {
                vlessSocket.send(chunk);
            }
            hasData = true;
        }
    });

    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch {
        vlessSocket.close();
    }

    return hasData;
}

function processHeader(buffer, userID) {
    const bytes = new Uint8Array(buffer);
    if (stringify(bytes.subarray(1, 17)) !== userID) {
        return { hasError: true };
    }

    const optLength = bytes[17];
    const commandStart = 18 + optLength;
    const command = bytes[commandStart];
    const isUDP = command === 2;
    const port = (bytes[commandStart + 1] << 8) | bytes[commandStart + 2];
    const { address, rawDataIndex } = parseAddress(bytes, commandStart + 3);

    return {
        hasError: false,
        address,
        port,
        rawDataIndex,
        passVersion: bytes.subarray(0, 1),
        isUDP
    };
}

function parseAddress(bytes, start) {
    const addressType = bytes[start];
    const addrLength = addressType === 2 ? bytes[start + 1] : (addressType === 1 ? 4 : 16);
    const addrStart = start + (addressType === 2 ? 2 : 1);
    const addrEnd = addrStart + addrLength;

    let address;
    if (addressType === 1) {
        address = bytes.subarray(addrStart, addrEnd).join('.');
    } else if (addressType === 2) {
        address = new TextDecoder().decode(bytes.subarray(addrStart, addrEnd));
    } else {
        address = Array.from(bytes.subarray(addrStart, addrEnd))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':');
    }

    return { address, rawDataIndex: addrEnd };
}

function handleHttpRequest(request, userID, url) {
    const path = url.pathname;

    if (path === "/") {
        return new Response(JSON.stringify(request.cf, null, 4));
    }

    if (path === `/${userID}`) {
        const host = request.headers.get("Host");
        const cachedConfig = configCache.get(host);
        if (!cachedConfig) {
            const config = `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
            configCache.set(host, config);
            return new Response(config, {
                headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
        }
        return new Response(cachedConfig, {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }

    return new Response("Not found", { status: 404 });
}

const hexTable = Array.from({ length: 256 }, (_, i) => 
    (i + 0x100).toString(16).substr(1)
);

function stringify(arr, offset = 0) {
    const segments = [4, 2, 2, 2, 6];
    return segments
        .map(len => {
            const hex = Array.from({ length: len }, () => 
                hexTable[arr[offset++]]
            ).join('');
            return hex;
        })
        .join('-')
        .toLowerCase();
}
