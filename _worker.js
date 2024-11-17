import { connect } from 'cloudflare:sockets';

class CacheManager {
    constructor() {
        this.userIDCache = new Map();
        this.responseHeaderCache = new Map();
        this.configCache = new Map();
        this.base64Cache = new Map();
        this.addressCache = new Map();
        this.MAX_CACHE_SIZE = 1024;
    }

    getUserID(userID) {
        if (!this.userIDCache.has(userID)) {
            const processed = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
            this.userIDCache.set(userID, processed);
            this.checkCacheSize(this.userIDCache);
        }
        return this.userIDCache.get(userID);
    }

    getResponseHeader(version) {
        const key = version.toString();
        if (!this.responseHeaderCache.has(key)) {
            const header = new Uint8Array([version[0], 0]);
            this.responseHeaderCache.set(key, header);
            this.checkCacheSize(this.responseHeaderCache);
        }
        return this.responseHeaderCache.get(key);
    }

    getConfig(userID, hostName) {
        const key = `${userID}:${hostName}`;
        if (!this.configCache.has(key)) {
            const config = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
            this.configCache.set(key, config);
            this.checkCacheSize(this.configCache);
        }
        return this.configCache.get(key);
    }

    getBase64Buffer(base64Str) {
        if (!base64Str) return { error: null };    
        if (!this.base64Cache.has(base64Str)) {
            try {
                const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
                const binaryStr = atob(normalizedStr);
                const length = binaryStr.length;
                const arrayBuffer = new Uint8Array(length);             
                for (let i = 0; i < length; i++) {
                    arrayBuffer[i] = binaryStr.charCodeAt(i);
                }            
                this.base64Cache.set(base64Str, {
                    earlyData: arrayBuffer.buffer,
                    error: null
                });
                this.checkCacheSize(this.base64Cache);
            } catch (error) {
                return { error };
            }
        }
        return this.base64Cache.get(base64Str);
    }

    getAddress(addressType, buffer, startIndex) {
    const keyBuffer = buffer.slice(startIndex, startIndex + (addressType === 2 ? 1 : addressType === 1 ? 4 : 16));
    const key = `${addressType}:${Array.from(new Uint8Array(keyBuffer)).join(',')}`;    

    if (!this.addressCache.has(key)) {
        let result = '';
        if (addressType === 1) { // IPv4
            result = Array.from(new Uint8Array(buffer.slice(startIndex, startIndex + 4))).join('.');
        } else if (addressType === 2) { // Domain
            const len = new Uint8Array(buffer.slice(startIndex, startIndex + 1))[0];
            result = new TextDecoder().decode(buffer.slice(startIndex + 1, startIndex + 1 + len));
        } else if (addressType === 3) { // IPv6
            const dataView = new DataView(buffer.slice(startIndex, startIndex + 16));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16).padStart(4, '0'));
            }
            result = ipv6.join(':');
        }
        this.addressCache.set(key, result);
        this.checkCacheSize(this.addressCache);
    }
    return this.addressCache.get(key);
}
    checkCacheSize(cache) {
        if (cache.size > this.MAX_CACHE_SIZE) {
            const iterator = cache.keys();
            for (let i = 0; i < Math.floor(this.MAX_CACHE_SIZE / 2); i++) {
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
                    case `/${userID}`: {
                        const config = cacheManager.getConfig(userID, request.headers.get('Host'));
                        return new Response(config, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8"
                            },
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await resOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

function processResHeader(resBuffer, userID) {
    if (resBuffer.byteLength < 24) return { hasError: true };

    const version = new Uint8Array(resBuffer.slice(0, 1));
    const bufferUserID = cacheManager.getUserID(userID);
    
    if (new Uint8Array(resBuffer.slice(1, 17)).some((byte, index) => byte !== bufferUserID[index])) {
        return { hasError: true };
    }

    const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
    const command = new Uint8Array(resBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;
    
    if (!isUDP && command !== 1) return { hasError: false };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(resBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    const addressIndex = portIndex + 2;
    const addressType = new Uint8Array(resBuffer.slice(addressIndex, addressIndex + 1))[0];
    const addressValueIndex = addressIndex + 1;

    if (![1, 2, 3].includes(addressType)) return { hasError: true };

    const addressRemote = cacheManager.getAddress(addressType, resBuffer, addressValueIndex);
    if (!addressRemote) return { hasError: true };

    const addressLength = addressType === 1 ? 4 : addressType === 2 ? 
        new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + 1))[0] + 1 : 16;

    return {
        hasError: false,
        addressRemote,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        resVersion: version,
        isUDP
    };
}

// Continue in next message...
async function resOverWSHandler(request) {
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
                return udpWrite(chunk);
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
                resVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processResHeader(chunk, userID);

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

            const resHeader = cacheManager.getResponseHeader(resVersion);
            const clientData = chunk.slice(rawDataIndex);

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }

            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
        close() {},
        abort(reason) {},
    })).catch((err) => {
        closeWebSocket(webSocket);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

// Would you like me to continue with the remaining functions?
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    const stream = new ReadableStream({
        start(controller) {
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
                console.error('WebSocket error:', err);
                controller.error(err);
            });

            const { earlyData, error } = cacheManager.getBase64Buffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {},
        cancel(reason) {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
    return stream;
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({
                hostname: address,
                port: port
            });
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
        if (!await tryConnect(addressRemote, portRemote)) {
            if (!await tryConnect(proxyIP, portRemote)) {
                closeWebSocket(webSocket);
            }
        }
    } catch (error) {
        closeWebSocket(webSocket);
    }
}

// Continuing with the remaining functions in the next part...
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                controller.error('WebSocket is closed');
                return;
            }
            let bufferToSend;
            if (resHeader) {
                bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                bufferToSend.set(resHeader, 0);
                bufferToSend.set(chunk, resHeader.byteLength);
                resHeader = null;
            } else {
                bufferToSend = chunk;
            }
            webSocket.send(bufferToSend);
            hasData = true;
        },
        close() {},
        abort(reason) {}
    })).catch((error) => {
        closeWebSocket(webSocket);
    });
    return hasData;
}

async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const writer = new WritableStream({
        async write(chunk) {
            try {
                const dnsResponse = await queryDNS(chunk);
                if (dnsResponse && webSocket.readyState === WebSocket.OPEN) {
                    const resPayload = queryDNSResponse(resHeader, dnsResponse, headerSent);
                    webSocket.send(resPayload);
                    headerSent = true;
                }
            } catch (error) {
                closeWebSocket(webSocket);
            }
        }
    }).getWriter();
    return { write: chunk => writer.write(chunk).catch(console.error) };
}

async function queryDNS(dnsRequest) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/dns-message' },
            body: dnsRequest,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return await response.arrayBuffer();
    } catch (error) {
        throw error;
    }
}

function queryDNSResponse(resHeader, dnsResponse, headerSent) {
    const sizeBuffer = new Uint8Array([(dnsResponse.byteLength >> 8) & 0xff, dnsResponse.byteLength & 0xff]);
    const resPayload = new Uint8Array((headerSent ? 0 : resHeader.byteLength) + sizeBuffer.byteLength + dnsResponse.byteLength);   
    let offset = 0;
    if (!headerSent) {
        resPayload.set(resHeader, offset);
        offset += resHeader.byteLength;
    }    
    resPayload.set(sizeBuffer, offset);
    resPayload.set(new Uint8Array(dnsResponse), offset + sizeBuffer.byteLength);    
    return resPayload;
}

function closeWebSocket(socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}
