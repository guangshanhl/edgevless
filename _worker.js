import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');           
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return handleHTTPRequest(request, config.userID);
            }            
            return await resOverWSHandler(request);           
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHTTPRequest = (request, userID) => {
    const url = new URL(request.url);    
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf), { 
                status: 200 
            });            
        case `/${userID}`: {
            const config = getConfig(userID, request.headers.get('Host'));
            return new Response(config, {
                status: 200,
                headers: {
                    "Content-Type": "text/plain;charset=utf-8"
                }
            });
        }        
        default:
            return new Response('Not found', { 
                status: 404 
            });
    }
};
async function resOverWSHandler(request) {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();
    const state = {
        address: '',
        remoteSocket: { value: null },
        udpWrite: null,
        isDns: false
    };
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    const handleChunk = async (chunk, controller) => {
        if (state.isDns && state.udpWrite) {
            return state.udpWrite(chunk);
        }
        if (state.remoteSocket.value) {
            const writer = state.remoteSocket.value.writable.getWriter();
            try {
                await writer.write(chunk);
            } finally {
                writer.releaseLock();
            }
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
        state.address = addressRemote;       
        if (hasError) return;
        if (isUDP) {
            if (portRemote === 53) {
                state.isDns = true;
            } else {
                return;
            }
        }
        const resHeader = new Uint8Array([resVersion[0], 0]);
        const clientData = chunk.slice(rawDataIndex);
        if (state.isDns) {
            const { write } = await handleUDPOutBound(webSocket, resHeader);
            state.udpWrite = write;
            state.udpWrite(clientData);
            return;
        }
        handleTCPOutBound(
            state.remoteSocket, 
            addressRemote, 
            portRemote, 
            clientData, 
            webSocket, 
            resHeader
        );
    };
    readableWebStream.pipeTo(new WritableStream({
        write: handleChunk,
        close() {},
        abort() {},
    })).catch(() => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    const createConnection = async (address, port) => {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({
                hostname: address,
                port
            });
        }
        const writer = remoteSocket.value.writable.getWriter();
        try {
            await writer.write(clientData);
        } finally {
            writer.releaseLock();
        }       
        return remoteSocket.value;
    };
    const establishConnection = async (address, port) => {
        const tcpSocket = await createConnection(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    };
    try {
        const primaryConnection = await establishConnection(addressRemote, portRemote);
        if (primaryConnection) {
            return;
        }
        const fallbackConnection = await establishConnection(proxyIP, portRemote);
        if (!fallbackConnection) {
            closeWebSocket(webSocket);
        }
    } catch {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isActive = true;   
    const handleEarlyHeader = (controller) => {
        if (!earlyHeader) return;       
        const { earlyData, error } = base64ToBuffer(earlyHeader);
        if (error) {
            controller.error(error);
            return;
        }       
        if (earlyData) {
            controller.enqueue(earlyData);
        }
    };
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', ({ data }) => {
                if (!isActive) return;
                controller.enqueue(data);
            });
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (!isActive) return;
                controller.close();
            });
            webSocket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                controller.error(err);
            });
            handleEarlyHeader(controller);
        },
        pull(controller) {
        },
        cancel() {
            if (!isActive) return;
            isActive = false;
            closeWebSocket(webSocket);
        }
    });
}
const ADDRESS_TYPES = {
    IPV4: 1,
    DOMAIN: 2,
    IPV6: 3
};
let cachedUserID;
function processResHeader(resBuffer, userID) {
    if (resBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const bufferView = new Uint8Array(resBuffer);
    const dataView = new DataView(resBuffer);
    const version = bufferView.slice(0, 1);
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(
            userID.replace(/-/g, '')
                .match(/../g)
                .map(byte => parseInt(byte, 16))
        );
    }
    const bufferUserID = bufferView.slice(1, 17);
    if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = bufferView[17];
    const commandIndex = 18 + optLength;
    const command = bufferView[commandIndex];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = commandIndex + 1;
    const portRemote = dataView.getUint16(portIndex);
    const addressIndex = portIndex + 2;
    const addressType = bufferView[addressIndex];
    let addressValueIndex = addressIndex + 1;
    let addressLength = 0;
    let addressValue = '';
    switch (addressType) {
        case ADDRESS_TYPES.IPV4:
            addressLength = 4;
            addressValue = bufferView
                .slice(addressValueIndex, addressValueIndex + addressLength)
                .join('.');
            break;
        case ADDRESS_TYPES.DOMAIN:
            addressLength = bufferView[addressValueIndex];
            addressValueIndex++;
            addressValue = new TextDecoder().decode(
                resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case ADDRESS_TYPES.IPV6:
            addressLength = 16;
            const ipv6Parts = Array.from({ length: 8 }, (_, i) => 
                dataView.getUint16(addressValueIndex + i * 2).toString(16)
            );
            addressValue = ipv6Parts.join(':');
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
        resVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    const streamWriter = new WritableStream({
        async write(chunk) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                throw new Error('WebSocket is closed');
            }
            const bufferToSend = resHeader
                ? concatenateBuffers(resHeader, chunk)
                : chunk;
            webSocket.send(bufferToSend);
            hasData = true;
            resHeader = null;
        },
        close() {},
        abort() {}
    });
    try {
        await remoteSocket.readable.pipeTo(streamWriter);
    } catch {
        closeWebSocket(webSocket);
    }
    return hasData;
}
function concatenateBuffers(header, chunk) {
    const combined = new Uint8Array(header.byteLength + chunk.byteLength);
    combined.set(header);
    combined.set(chunk, header.byteLength);
    return combined;
}
function base64ToBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        const normalizedStr = base64Str
            .replace(/-/g, '+')
            .replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const arrayBuffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
        return { 
            earlyData: arrayBuffer.buffer, 
            error: null 
        };
    } catch (error) {
        return { error };
    }
}
function closeWebSocket(socket) {
    const CLOSEABLE_STATES = [WebSocket.OPEN, WebSocket.CLOSING];   
    if (CLOSEABLE_STATES.includes(socket.readyState)) {
        socket.close();
    }
}
const DNS_TIMEOUT = 5000;
const DNS_ENDPOINT = 'https://cloudflare-dns.com/dns-query';
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const writer = new WritableStream({
        async write(chunk) {
            try {
                const dnsResponse = await queryDNS(chunk);               
                if (dnsResponse && webSocket.readyState === WebSocket.OPEN) {
                    const resPayload = createDNSResponse(resHeader, dnsResponse, headerSent);
                    webSocket.send(resPayload);
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
async function queryDNS(dnsRequest) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DNS_TIMEOUT);
    const response = await fetch(DNS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsRequest,
        signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response.arrayBuffer();
}
function createDNSResponse(resHeader, dnsResponse, headerSent) {
    const responseLength = dnsResponse.byteLength;
    const sizeBuffer = new Uint8Array([
        (responseLength >> 8) & 0xff, 
        responseLength & 0xff
    ]);
    const totalLength = (headerSent ? 0 : resHeader.byteLength) + 
                       sizeBuffer.byteLength + 
                       responseLength;                      
    const resPayload = new Uint8Array(totalLength);
    let offset = 0;
    if (!headerSent) {
        resPayload.set(resHeader, offset);
        offset += resHeader.byteLength;
    }
    resPayload.set(sizeBuffer, offset);
    resPayload.set(new Uint8Array(dnsResponse), offset + sizeBuffer.byteLength);
    return resPayload;
}
const CONFIG_TEMPLATE = {
    protocol: 'vless',
    port: '443',
    encryption: 'none',
    security: 'tls',
    fingerprint: 'randomized',
    type: 'ws',
    path: '/?ed=2560'
};
function getConfig(userID, hostName) {
    return `${CONFIG_TEMPLATE.protocol}://${userID}@${hostName}:${CONFIG_TEMPLATE.port}?` +
           `encryption=${CONFIG_TEMPLATE.encryption}&` +
           `security=${CONFIG_TEMPLATE.security}&` +
           `sni=${hostName}&` +
           `fp=${CONFIG_TEMPLATE.fingerprint}&` +
           `type=${CONFIG_TEMPLATE.type}&` +
           `host=${hostName}&` +
           `path=${encodeURIComponent(CONFIG_TEMPLATE.path)}#${hostName}`;
}
