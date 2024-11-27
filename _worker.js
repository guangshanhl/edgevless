import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
let cachedUserID;

export default {
    async fetch(request, env, ctx) {
        userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;

        if(request.headers.get('Upgrade') === 'websocket') {
            return await handleWebSocket(request);
        }

        const url = new URL(request.url);
        if(url.pathname === '/') {
            return new Response(JSON.stringify(request.cf));
        }
        
        if(url.pathname === `/${userID}`) {
            return new Response(
                getVLESSConfig(userID, request.headers.get('Host')),
                {headers: {'Content-Type': 'text/plain;charset=utf-8'}}
            );
        }

        return new Response('Not found', {status: 404});
    }
};

async function handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const stream = makeWebSocketStream(server, earlyDataHeader);
    
    let remoteSocket = null;
    let udpWriter = null;
    let isDNS = false;

    stream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDNS && udpWriter) {
                udpWriter.write(chunk);
                return;
            }

            if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const {
                hasError,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                resHeader = new Uint8Array([0, 0]),
                isUDP,
            } = parseVLESSHeader(chunk, userID);

            if (hasError) return;

            if (isUDP) {
                if (portRemote === 53) {
                    isDNS = true;
                    udpWriter = await handleDNS(server, resHeader);
                    udpWriter.write(chunk.slice(rawDataIndex));
                }
                return;
            }

            handleTCP(remoteSocket, addressRemote, portRemote, chunk.slice(rawDataIndex), server, resHeader);
        }
    })).catch(() => closeWebSocket(server));

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

function makeWebSocketStream(webSocket, earlyDataHeader) {
    let active = true;
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (!active) return;
                controller.enqueue(event.data);
            });

            webSocket.addEventListener('close', () => {
                if (!active) return;
                controller.close();
                active = false;
            });

            webSocket.addEventListener('error', () => {
                if (!active) return;
                controller.error();
                active = false;
            });

            if (earlyDataHeader) {
                const earlyData = base64ToArrayBuffer(earlyDataHeader);
                if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
        },
        cancel() {
            active = false;
            closeWebSocket(webSocket);
        }
    });
}

async function handleDNS(webSocket, resHeader) {
    let headerSent = false;
    const transform = new TransformStream({
        transform(chunk, controller) {
            const view = new DataView(chunk.buffer);
            const len = view.getUint16(0);
            if (chunk.byteLength >= len + 2) {
                controller.enqueue(chunk.slice(2, len + 2));
            }
        }
    });

    transform.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/dns-message',
                },
                body: chunk
            });
            
            const result = await response.arrayBuffer();
            const data = new Uint8Array(result);
            const size = new Uint8Array([data.length >> 8, data.length & 0xff]);
            
            const sendData = headerSent ? 
                new Uint8Array([...size, ...data]) :
                new Uint8Array([...resHeader, ...size, ...data]);
            
            headerSent = true;
            if (webSocket.readyState === 1) {
                webSocket.send(sendData);
            }
        }
    })).catch(() => closeWebSocket(webSocket));

    return transform.writable.getWriter();
}

async function handleTCP(remoteSocket, address, port, data, webSocket, resHeader) {
    async function tryConnect(addr) {
        try {
            remoteSocket = await connect({
                hostname: addr,
                port: port
            });
            const writer = remoteSocket.writable.getWriter();
            await writer.write(data);
            writer.releaseLock();

            let firstChunk = true;
            await remoteSocket.readable.pipeTo(new WritableStream({
                write(chunk) {
                    if (webSocket.readyState !== 1) return;
                    if (firstChunk) {
                        webSocket.send(new Uint8Array([...resHeader, ...chunk]));
                        firstChunk = false;
                    } else {
                        webSocket.send(chunk);
                    }
                }
            }));
            return true;
        } catch {
            return false;
        }
    }

    // 先尝试主地址
    if (await tryConnect(address)) {
        return;
    }
    
    // 主地址失败后尝试proxyIP
    if (proxyIP && await tryConnect(proxyIP)) {
        return;
    }

    closeWebSocket(webSocket);
}


function parseVLESSHeader(buffer, userID) {
    if (buffer.byteLength < 24) return { hasError: true };
    
    const version = new Uint8Array([buffer[0]]);
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(
            userID.replace(/-/g, '').match(/.{2}/g).map(byte => parseInt(byte, 16))
        );
    }

    const id = new Uint8Array(buffer.slice(1, 17));
    if (id.some((byte, i) => byte !== cachedUserID[i])) {
        return { hasError: true };
    }

    const optLength = buffer[17];
    const command = buffer[18 + optLength];
    if (command !== 1 && command !== 2) {
        return { hasError: true };
    }

    const portIndex = 18 + optLength + 1;
    const portView = new DataView(buffer.buffer);
    const port = portView.getUint16(portIndex);

    let addr = '';
    let offset = portIndex + 2;
    const addrType = buffer[offset++];

    switch(addrType) {
        case 1: // IPv4
            addr = new Uint8Array(buffer.slice(offset, offset + 4)).join('.');
            offset += 4;
            break;
        case 2: // Domain
            const len = buffer[offset++];
            addr = new TextDecoder().decode(buffer.slice(offset, offset + len));
            offset += len;
            break;
        case 3: // IPv6
            const ipv6View = new DataView(buffer.buffer, offset, 16);
            const ipv6Parts = [];
            for(let i = 0; i < 8; i++) {
                ipv6Parts.push(ipv6View.getUint16(i * 2).toString(16));
            }
            addr = ipv6Parts.join(':');
            offset += 16;
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addr,
        portRemote: port,
        rawDataIndex: offset,
        resHeader: version,
        isUDP: command === 2
    };
}

function base64ToArrayBuffer(base64) {
    try {
        const binaryString = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    } catch {
        return null;
    }
}

function closeWebSocket(socket) {
    if (socket.readyState === 1) {
        socket.close();
    }
}

function getVLESSConfig(userID, host) {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
}
