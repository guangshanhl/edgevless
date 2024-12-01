import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
    async fetch(request, env, ctx) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';

        try {
            if (request.headers.get('Upgrade') === 'websocket') {
                return handleWebSocket(request, userID, proxyIP);
            }

            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`:
                    return new Response(
                        `vless://${userID}@${request.headers.get('Host')}:443?encryption=none&security=tls&sni=${request.headers.get('Host')}&fp=randomized&type=ws&host=${request.headers.get('Host')}&path=%2F%3Fed%3D2560#${request.headers.get('Host')}`,
                        { status: 200, headers: { "Content-Type": "text/plain;charset=utf-8" } }
                    );
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString());
        }
    }
};

async function handleWebSocket(request, userID, proxyIP) {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();

    const remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;

    makeReadableStream(webSocket, request.headers.get('sec-websocket-protocol') || '')
        .pipeTo(new WritableStream({
            async write(chunk) {
                if (isDns && udpWrite) return udpWrite(chunk);
                if (remoteSocket.value) {
                    const writer = remoteSocket.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
                    return;
                }

                const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = processHeader(chunk, userID);
                if (hasError) return;

                if (isUDP) {
                    if (portRemote === 53) {
                        isDns = true;
                    } else {
                        return;
                    }
                }

                const resHeader = new Uint8Array([ressVersion[0], 0]);
                const clientData = chunk.slice(rawDataIndex);

                if (isDns) {
                    const { write } = await handleDNS(webSocket, resHeader);
                    udpWrite = write;
                    udpWrite(clientData);
                    return;
                }

                handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP);
            }
        })).catch(() => closeWebSocket(webSocket));

    return new Response(null, { status: 101, webSocket: client });
}

function makeReadableStream(webSocket, earlyHeader) {
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (e) => controller.enqueue(e.data));
            webSocket.addEventListener('close', () => {
                controller.close();
                closeWebSocket(webSocket);
            });
            webSocket.addEventListener('error', (e) => {
                controller.error(e);
                closeWebSocket(webSocket);
            });

            const { earlyData, error } = parseBase64(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    });
}

async function handleTCP(remoteSocket, address, port, data, webSocket, resHeader, proxyIP) {
    const connect = async (addr) => {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = await connect({ hostname: addr, port });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(data);
        writer.releaseLock();
        return remoteSocket.value;
    };

    try {
        const socket = await connect(address) || await connect(proxyIP);
        if (!socket) {
            closeWebSocket(webSocket);
            return;
        }

        let headerSent = false;
        await socket.readable.pipeTo(new WritableStream({
            write(chunk) {
                if (webSocket.readyState !== WS_READY_STATE_OPEN) throw new Error('WebSocket closed');
                if (!headerSent) {
                    webSocket.send(new Blob([resHeader, chunk]).arrayBuffer());
                    headerSent = true;
                } else {
                    webSocket.send(chunk);
                }
            }
        }));
    } catch {
        closeWebSocket(webSocket);
    }
}

async function handleDNS(webSocket, resHeader) {
    let headerSent = false;
    let partial = null;
    
    const transform = new TransformStream({
        transform(chunk, controller) {
            if (partial) {
                chunk = new Uint8Array([...partial, ...chunk]);
                partial = null;
            }

            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partial = chunk.slice(offset);
                    break;
                }

                const length = new DataView(chunk.buffer).getUint16(offset);
                const end = offset + 2 + length;
                
                if (chunk.byteLength < end) {
                    partial = chunk.slice(offset);
                    break;
                }

                controller.enqueue(chunk.slice(offset + 2, end));
                offset = end;
            }
        }
    });

    transform.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });
            
            const result = await response.arrayBuffer();
            const size = new Uint8Array([(result.byteLength >> 8) & 0xff, result.byteLength & 0xff]);

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(headerSent ? 
                    new Blob([size, result]).arrayBuffer() : 
                    new Blob([resHeader, size, result]).arrayBuffer()
                );
                headerSent = true;
            }
        }
    }));

    return {
        write: chunk => transform.writable.getWriter().write(chunk)
    };
}

function processHeader(buffer, userID) {
    if (buffer.byteLength < 24) return { hasError: true };

    const version = buffer.slice(0, 1);
    const id = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(b => parseInt(b, 16)));
    
    if (new Uint8Array(buffer.slice(1, 17)).some((b, i) => b !== id[i])) {
        return { hasError: true };
    }

    const optLen = new Uint8Array(buffer.slice(17, 18))[0];
    const cmd = new Uint8Array(buffer.slice(18 + optLen, 18 + optLen + 1))[0];
    const isUDP = cmd === 2;
    
    if (!isUDP && cmd !== 1) return { hasError: true };

    const portStart = 18 + optLen + 1;
    const port = new DataView(buffer.slice(portStart, portStart + 2)).getUint16(0);
    const addrType = new Uint8Array(buffer.slice(portStart + 2, portStart + 3))[0];
    
    let addrLen = 0;
    let addrStart = portStart + 3;
    let addr = '';

    switch (addrType) {
        case 1:
            addr = new Uint8Array(buffer.slice(addrStart, addrStart + 4)).join('.');
            addrLen = 4;
            break;
        case 2:
            addrLen = new Uint8Array(buffer.slice(addrStart, addrStart + 1))[0];
            addrStart++;
            addr = new TextDecoder().decode(buffer.slice(addrStart, addrStart + addrLen));
            break;
        case 3:
            addrLen = 16;
            const ipv6 = [];
            const view = new DataView(buffer.slice(addrStart, addrStart + 16));
            for (let i = 0; i < 8; i++) {
                ipv6.push(view.getUint16(i * 2).toString(16));
            }
            addr = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        portRemote: port,
        addressRemote: addr,
        rawDataIndex: addrStart + addrLen,
        ressVersion: version,
        isUDP
    };
}

function parseBase64(str) {
    if (!str) return { error: null };
    try {
        const binary = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return { earlyData: bytes.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocket(socket) {
    if (socket.readyState <= WS_READY_STATE_CLOSING) {
        socket.close();
    }
}
