import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
}
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
                        const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
                        return new Response(`${vlessConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            let e = err;
            return new Response(e.toString());
        }
    },
};
async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocket = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter()
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            const {
                hasError,
                message,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                vlessVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processVlessHeader(chunk, userID);
            address = addressRemote;
            if (hasError) {
                throw new Error(message);
                return;
            }
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP DNS is port 53');
                    return;
                }
            }
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
        },
    })).catch((err) => {
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
            timeout: 2000
        });    
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();    
        return tcpSocket;
    }
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP, portRemote);
        tcpSocket.closed
            .then(() => safeCloseWebSocket(webSocket))
            .catch(() => safeCloseWebSocket(webSocket));            
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
    }
    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
    } catch (error) {
        retry();
    }
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;   
    const stream = new ReadableStream({
        start(controller) {
            const messageHandler = (event) => {
                if (!readableStreamCancel) {
                    controller.enqueue(event.data);
                }
            };
            const closeHandler = () => {
                if (!readableStreamCancel) {
                    safeCloseWebSocket(webSocketServer);
                    controller.close();
                }
            };
            const errorHandler = (err) => {
                controller.error(err);
            };
            webSocketServer.addEventListener('message', messageHandler);
            webSocketServer.addEventListener('close', closeHandler);
            webSocketServer.addEventListener('error', errorHandler);
            if (earlyDataHeader) {
                const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
                if (error) {
                    controller.error(error);
                } else if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
            return () => {
                webSocketServer.removeEventListener('message', messageHandler);
                webSocketServer.removeEventListener('close', closeHandler);
                webSocketServer.removeEventListener('error', errorHandler);
            };
        },
        cancel(reason) {
            if (!readableStreamCancel) {
                readableStreamCancel = true;
                safeCloseWebSocket(webSocketServer);
            }
        }
    });
    return stream;
}
function processVlessHeader(vlessBuffer, userID) {
    const dataView = new DataView(vlessBuffer);
    const bufferSize = vlessBuffer.byteLength;
    if (bufferSize < 24) {
        return { hasError: true, message: 'Invalid buffer size' };
    }
    const version = dataView.getUint8(0);
    const uuidBytes = new Uint8Array(vlessBuffer.slice(1, 17));
    if (stringify(uuidBytes) !== userID) {
        return { hasError: true, message: 'Invalid UUID' };
    }
    const optLength = dataView.getUint8(17);
    const commandPos = 18 + optLength;   
    if (commandPos >= bufferSize) {
        return { hasError: true, message: 'Invalid option length' };
    }
    const command = dataView.getUint8(commandPos);
    const isUDP = command === 2;  
    if (command !== 1 && command !== 2) {
        return { hasError: true, message: 'Invalid command' };
    }
    const portPos = commandPos + 1;
    const portRemote = dataView.getUint16(portPos);
    const addressPos = portPos + 2;
    const addressType = dataView.getUint8(addressPos);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = addressPos + 1;
    try {
        switch (addressType) {
            case 1:
                addressLength = 4;
                const ipv4Bytes = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
                addressValue = ipv4Bytes.join('.');
                break;
            case 2:
                addressLength = dataView.getUint8(addressValueIndex);
                addressValueIndex++;
                addressValue = new TextDecoder().decode(
                    vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
                );
                break;
            case 3:
                addressLength = 16;
                const ipv6View = new DataView(vlessBuffer, addressValueIndex, addressLength);
                const ipv6Parts = [];
                for (let i = 0; i < 8; i++) {
                    ipv6Parts.push(ipv6View.getUint16(i * 2).toString(16));
                }
                addressValue = ipv6Parts.join(':');
                break;
            default:
                return { hasError: true };
        }
    } catch (error) {
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
        vlessVersion: new Uint8Array([version, 0]),
        isUDP
    };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasData = false;    
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    hasData = true;
                    
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        throw new Error('WebSocket not open');
                    }
                    if (vlessResponseHeader) {
                        const data = new Blob([vlessResponseHeader, chunk]);
                        webSocket.send(await data.arrayBuffer());
                        vlessResponseHeader = null;
                    } else {
                        webSocket.send(chunk);
                    }
                }
            })
        )
        .catch(() => {
            safeCloseWebSocket(webSocket);
        });
    if (!hasData && retry) {
        retry();
    }
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}
const uuidCache = new Map();
function isValidUUID(uuid) {
    if (uuidCache.has(uuid)) {
        return uuidCache.get(uuid);
    }
    const result = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid);
    uuidCache.set(uuid, result);
    return result;
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
    try {
        if (socket && (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING)) {
            socket.close();
        }
    } catch (error) {
    }
}
const byteToHex = new Array(256).fill().map((_, i) => 
    (i + 0x100).toString(16).slice(1)
);
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw new TypeError("Invalid UUID format");
    }
    return uuid;
}
function unsafeStringify(arr, offset = 0) {
    return (
        byteToHex[arr[offset]] +
        byteToHex[arr[offset + 1]] +
        byteToHex[arr[offset + 2]] +
        byteToHex[arr[offset + 3]] +
        '-' +
        byteToHex[arr[offset + 4]] +
        byteToHex[arr[offset + 5]] +
        '-' +
        byteToHex[arr[offset + 6]] +
        byteToHex[arr[offset + 7]] +
        '-' +
        byteToHex[arr[offset + 8]] +
        byteToHex[arr[offset + 9]] +
        '-' +
        byteToHex[arr[offset + 10]] +
        byteToHex[arr[offset + 11]] +
        byteToHex[arr[offset + 12]] +
        byteToHex[arr[offset + 13]] +
        byteToHex[arr[offset + 14]] +
        byteToHex[arr[offset + 15]]
    ).toLowerCase();
}
const DNS_CACHE = new Map();
const DNS_TIMEOUT = 4000;
const MAX_CACHE_SIZE = 500;
const DNS_CACHE_TIME = 24 * 60 * 60 * 1000
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    async function dnsQuery(chunk) {
        const queryKey = Buffer.from(chunk).toString('base64');
        const now = Date.now();
        const cached = DNS_CACHE.get(queryKey);
        if (cached && (now - cached.timestamp < DNS_CACHE_TIME)) {
            return cached.data;
        }
        if (DNS_CACHE.size > MAX_CACHE_SIZE) {
            for (const [key, value] of DNS_CACHE.entries()) {
                if (now - value.timestamp > DNS_CACHE_TIME) {
                    DNS_CACHE.delete(key);
                }
            }
        }
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DNS_TIMEOUT);
        try {
            const response = await fetch('https://1.1.1.1/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message',
                },
                body: chunk,
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`DNS query failed: ${response.status}`);
            }
            const result = await response.arrayBuffer();
            DNS_CACHE.set(queryKey, {
                timestamp: now,
                data: result
            });
            return result;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('DNS query timeout');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            const packets = [];
            let offset = 0;
            while (offset < chunk.byteLength) {
                const lengthView = new DataView(chunk, offset, 2);
                const packetLength = lengthView.getUint16(0);
                const packetData = new Uint8Array(
                    chunk.slice(offset + 2, offset + 2 + packetLength)
                );
                packets.push(packetData);
                offset += 2 + packetLength;
            }
            packets.forEach(packet => controller.enqueue(packet));
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                const dnsResponse = await dnsQuery(chunk);
                const responseSize = dnsResponse.byteLength;
                const sizeBuffer = new Uint8Array([
                    (responseSize >> 8) & 0xff,
                    responseSize & 0xff
                ]);
                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    if (isVlessHeaderSent) {
                        webSocket.send(new Blob([sizeBuffer, dnsResponse]).arrayBuffer());
                    } else {
                        webSocket.send(new Blob([vlessResponseHeader, sizeBuffer, dnsResponse]).arrayBuffer());
                        isVlessHeaderSent = true;
                    }
                }
            } catch (error) {
                if (!isVlessHeaderSent) {
                    webSocket.send(vlessResponseHeader);
                    isVlessHeaderSent = true;
                }
            }
        }
    })).catch(error => {
        safeCloseWebSocket(webSocket);
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            return writer.write(chunk);
        }
    };
}
function createDNSResponse(rcode) {
    return new Uint8Array([
        0x00, 0x00,
        0x81, 0x80,
        0x00, 0x01,
        0x00, 0x00,
        0x00, 0x00,
        0x00, 0x00,
    ]);
}
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
`;
}
