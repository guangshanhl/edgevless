import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
let cachedUserID;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return handleWebSocket(request);
            }
            
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`:
                    return new Response(
                        getConfig(userID, request.headers.get('Host')),
                        {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8"
                            }
                        }
                    );
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString());
        }
    }
};

async function handleWebSocket(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    let remoteSocket = null;
    let isDns = false;
    let resHeader = null;

    server.addEventListener('message', async event => {
        const chunk = event.data;
        if (!chunk) return;

        try {
            if (isDns) {
                const dnsResponse = await handleDNS(chunk, resHeader);
                if (server.readyState === WS_READY_STATE_OPEN) {
                    server.send(dnsResponse);
                }
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
                ressVersion = new Uint8Array([0, 0]),
                isUDP
            } = processRessHeader(chunk, userID);

            if (hasError) return;

            resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);

            if (isUDP && portRemote === 53) {
                isDns = true;
                const dnsResponse = await handleDNS(clientData, resHeader);
                if (server.readyState === WS_READY_STATE_OPEN) {
                    server.send(dnsResponse);
                }
            } else {
                remoteSocket = await connect({
                    hostname: addressRemote || proxyIP,
                    port: portRemote
                });

                const writer = remoteSocket.writable.getWriter();
                await writer.write(clientData);
                writer.releaseLock();

                remoteSocket.readable
                    .pipeTo(new WritableStream({
                        write(chunk) {
                            if (server.readyState === WS_READY_STATE_OPEN) {
                                const data = new Uint8Array([...resHeader, ...chunk]);
                                server.send(data);
                                resHeader = null;
                            }
                        },
                        close() {
                            closeWebSocket(server);
                        },
                        abort() {
                            closeWebSocket(server);
                        }
                    }))
                    .catch(() => closeWebSocket(server));
            }
        } catch (err) {
            closeWebSocket(server);
        }
    });

    server.addEventListener('close', () => {
        if (remoteSocket) {
            remoteSocket.close();
        }
    });

    server.addEventListener('error', () => {
        if (remoteSocket) {
            remoteSocket.close();
        }
    });

    return new Response(null, {
        status: 101,
        webSocket: client
    });
}

async function handleDNS(query, resHeader) {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: query
    });
    
    const result = await response.arrayBuffer();
    const sizeBuffer = new Uint8Array([
        (result.byteLength >> 8) & 0xff,
        result.byteLength & 0xff
    ]);
    
    return new Uint8Array([
        ...(resHeader || []),
        ...sizeBuffer,
        ...new Uint8Array(result)
    ]);
}

function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) {
        return { hasError: true };
    }

    const version = new Uint8Array(ressBuffer.slice(0, 1));
    
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(
            userID.replace(/-/g, '')
                 .match(/../g)
                 .map(byte => parseInt(byte, 16))
        );
    }

    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    if (bufferUserID.some((byte, i) => byte !== cachedUserID[i])) {
        return { hasError: true };
    }

    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    const isUDP = command === 2;
    
    if (!isUDP && command !== 1) {
        return { hasError: true };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    const addressIndex = portIndex + 2;
    const addressType = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1))[0];
    
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const ipv6 = [];
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: version,
        isUDP
    };
}

function base64ToBuffer(base64Str) {
    if (!base64Str) return { error: null };
    
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const length = binaryStr.length;
        const arrayBuffer = new Uint8Array(length);
        
        for (let i = 0; i < length; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}

function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
