import { connect } from 'cloudflare:sockets';
const VLESS_VERSION = new Uint8Array([0]);
const DNS_PORT = 53;
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        
        try {
            const upgrade = request.headers.get('Upgrade');
            return upgrade === 'websocket'
                ? await handleWsRequest(request, userID, proxyIP)
                : handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/") {
        return new Response(JSON.stringify(request.cf, null, 4));
    }
    if (path === `/${userID}`) {
        const vlessConfig = getConfig(userID, request.headers.get("Host"));
        return new Response(vlessConfig, {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }
    return new Response("Not found", { status: 404 });
};
class StreamHandler {
    static createStream(webSocket, earlyHeader) {
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
                webSocket.addEventListener('message', event => {
                    controller.enqueue(event.data);
                });
                webSocket.addEventListener('close', () => {
                    StreamHandler.closeWebSocket(webSocket);
                    controller.close();
                });
                webSocket.addEventListener('error', event => {
                    controller.error(event);
                });
            },
            cancel: () => StreamHandler.closeWebSocket(webSocket)
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
    static closeWebSocket(ws) {
        if (ws.readyState <= 2) ws.close();
    }
}
async function handleWsRequest(request, userID, proxyIP) {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = StreamHandler.createStream(webSocket, earlyDataHeader);    
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
            if (isUDP && port === DNS_PORT) {
                const { write } = await handleDNS(webSocket, resHeader);
                udpWriter = write;
                udpWriter(clientData);
                return;
            }
            await handleTCP(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream).catch(() => {
        StreamHandler.closeWebSocket(webSocket);
    });
    return new Response(null, { 
        status: 101, 
        webSocket: client 
    });
}
async function writeToRemote(socket, chunk) {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
}
async function handleTCP(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP) {
    const tryConnect = async (addr) => {
        try {
            if (!remoteSocket.value || remoteSocket.value.closed) {
                remoteSocket.value = await connect({ hostname: addr, port });
            }
            await writeToRemote(remoteSocket.value, clientData);
            return await forwardData(remoteSocket.value, webSocket, resHeader);
        } catch {
            return false;
        }
    };
    if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
        StreamHandler.closeWebSocket(webSocket);
    }
}
async function forwardData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    let headerSent = Boolean(resHeader);
    const writableStream = new WritableStream({
        write(chunk) {
            if (ws.readyState !== 1) {
                throw new Error("WebSocket closed");
            }
            if (headerSent) {
                const buffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                buffer.set(resHeader);
                buffer.set(new Uint8Array(chunk), resHeader.byteLength);
                webSocket.send(buffer);
                headerSent = false;
            } else {
                webSocket.send(chunk);
            }
            hasData = true;
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch {
        StreamHandler.closeWebSocket(webSocket);
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
async function handleDNS(webSocket, resHeader) {
    let headerSent = false;   
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const size = new DataView(chunk.buffer, offset, 2).getUint16(0);
                const data = chunk.subarray(offset + 2, offset + 2 + size);
                offset += 2 + size;
                const dnsResponse = await handleDNSRequest(data);
                const responseSize = dnsResponse.byteLength;
                const sizeBuffer = new Uint8Array([
                    (responseSize >> 8) & 0xff,
                    responseSize & 0xff
                ]);
                const totalLength = headerSent 
                    ? sizeBuffer.length + responseSize
                    : resHeader.length + sizeBuffer.length + responseSize;
                const response = new Uint8Array(totalLength);
                let position = 0;
                if (!headerSent) {
                    response.set(resHeader, position);
                    position += resHeader.length;
                    headerSent = true;
                }
                response.set(sizeBuffer, position);
                response.set(new Uint8Array(dnsResponse), position + sizeBuffer.length);
                if (ws.readyState === 1) {
                    webSocket.send(response);
                }
            }
            controller.terminate();
        }
    });
    const writer = transformStream.writable.getWriter();
    return { write: chunk => writer.write(chunk) };
}
async function handleDNSRequest(packet) {
    const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: {
            'accept': 'application/dns-message',
            'content-type': 'application/dns-message',
        },
        body: packet
    });
    return response.arrayBuffer();
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
function getConfig(userID, host) {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
}
