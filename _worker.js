import { connect } from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            return request.headers.get('Upgrade') === 'websocket'
                ? handleWsRequest(request, userID, proxyIP)
                : handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));
    if (path === `/${userID}`) {
        return new Response(
            getConfig(userID, request.headers.get("Host")),
            { headers: { "Content-Type": "text/plain;charset=utf-8" }}
        );
    }
    return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
    const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();    
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWSStream(webSocket, earlyHeader);
    const remoteSocket = { value: null };
    let udpWriter = null;
    const writableStream = new WritableStream({
        async write(chunk) {
            if (udpWriter) return udpWriter(chunk);
            if (remoteSocket.value) {
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }           
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;           
            const resHeader = new Uint8Array([passVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isUDP && port === 53) {
                const { write } = await handleUdpRequest(webSocket, resHeader);
                udpWriter = write;
                udpWriter(clientData);
                return;
            }
            handleTcpRequest(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const handleTcpRequest = async (remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP) => {
    const tryConnect = async (addr) => {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({ hostname: addr, port });
        }
        await writeToRemote(remoteSocket.value, clientData);
        return await forwardToData(remoteSocket.value, webSocket, resHeader);
    };    
    if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
        closeWebSocket(webSocket);
    }
};
const createWSStream = (webSocket, earlyHeader) => {
    return new ReadableStream({
        start(controller) {
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
            const handlers = {
                message: e => controller.enqueue(e.data),
                close: () => {
                    closeWebSocket(webSocket);
                    controller.close();
                },
                error: e => controller.error(e)
            };
            Object.entries(handlers).forEach(([type, handler]) => 
                webSocket.addEventListener(type, handler)
            );
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    });
};
const processWebSocketHeader = (buffer, userID) => {
    const bytes = new Uint8Array(buffer);
    if (stringify(bytes.subarray(1, 17)) !== userID) {
        return { hasError: true };
    }
    const optLength = bytes[17];
    const cmdStart = 18 + optLength;
    const isUDP = bytes[cmdStart] === 2;
    const port = (bytes[cmdStart + 1] << 8) | bytes[cmdStart + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, cmdStart + 3);
    return {
        hasError: false,
        address,
        port,
        rawDataIndex,
        passVersion: bytes.subarray(0, 1),
        isUDP
    };
};
const getAddressInfo = (bytes, start) => {
    const addrType = bytes[start];
    const addrLen = addrType === 2 ? bytes[start + 1] : (addrType === 1 ? 4 : 16);
    const valueStart = start + (addrType === 2 ? 2 : 1);
    const valueEnd = valueStart + addrLen;   
    let address;
    if (addrType === 1) {
        address = bytes.subarray(valueStart, valueEnd).join('.');
    } else if (addrType === 2) {
        address = new TextDecoder().decode(bytes.subarray(valueStart, valueEnd));
    } else {
        address = Array.from(bytes.subarray(valueStart, valueEnd))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':');
    }
    return { address, rawDataIndex: valueEnd };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
    let hasData = false;
    let needHeader = Boolean(resHeader);
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            write(chunk) {
                if (webSocket.readyState !== WebSocket.OPEN) {
                    controller.error("WebSocket closed");
                }
                if (needHeader) {
                    const combined = new Uint8Array(resHeader.length + chunk.byteLength);
                    combined.set(resHeader);
                    combined.set(new Uint8Array(chunk), resHeader.length);
                    webSocket.send(combined);
                    needHeader = false;
                } else {
                    webSocket.send(chunk);
                }
                hasData = true;
            }
        }));
    } catch {
        closeWebSocket(webSocket);
    }
    return hasData;
};
const handleUdpRequest = async (webSocket, resHeader) => {
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const size = new DataView(chunk.buffer, offset, 2).getUint16(0);
                const data = chunk.subarray(offset + 2, offset + 2 + size);
                offset += 2 + size;
                const dnsResponse = await handleDNSRequest(data);
                const responseSize = dnsResponse.byteLength;
                const header = new Uint8Array([(responseSize >> 8) & 0xff, responseSize & 0xff]);               
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(new Uint8Array([...resHeader, ...header, ...new Uint8Array(dnsResponse)]));
                }
            }
            controller.terminate();
        }
    });
    return {
        write: chunk => transformStream.writable.getWriter().write(chunk)
    };
};
const handleDNSRequest = async (query) => {
    const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
        },
        body: query,
    });
    return response.arrayBuffer();
};
const hexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (() => {
    return (arr, offset = 0) => {
        const lens = [4, 2, 2, 2, 6];
        return lens.map(len => {
            const hex = Array(len).fill().map(() => hexTable[arr[offset++]]).join('');
            return hex;
        }).join('-').toLowerCase();
    };
})();
const base64ToBuffer = (str) => {
    try {
        if (str instanceof ArrayBuffer || str instanceof Uint8Array) {
            return { earlyData: str };
        }
        const binary = atob(str.replace(/[-_]/g, m => m === '-' ? '+' : '/'));
        const buffer = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            buffer[i] = binary.charCodeAt(i);
        }
        return { earlyData: buffer.buffer };
    } catch (error) {
        return { error };
    }
};
const closeWebSocket = (webSocket) => {
    if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
        webSocket.close();
    }
};
const getConfig = (userID, host) => 
    `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
