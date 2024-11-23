import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader && upgradeHeader === 'websocket') {
                return await handleWebSocket(request);
            }
            
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`: {
                    const config = getConfig(userID, request.headers.get('Host'));
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
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

async function handleWebSocket(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    let remoteSocket = null;
    let udpTransformer = null;

    // 创建处理入站数据的 TransformStream
    const inboundTransform = new TransformStream({
        async transform(chunk, controller) {
            if (udpTransformer) {
                await udpTransformer.write(chunk);
                return;
            }

            const {
                hasError,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);

            if (hasError) return;

            const clientData = chunk.slice(rawDataIndex);
            const resHeader = new Uint8Array([ressVersion[0], 0]);

            if (isUDP && portRemote === 53) {
                udpTransformer = await createUDPTransformer(webSocket, resHeader);
                await udpTransformer.write(clientData);
                return;
            }

            if (!isUDP) {
                await handleTCPData(addressRemote, portRemote, clientData, webSocket, resHeader);
            }
        }
    });

    // 创建 WebSocket 到 TransformStream 的管道
    const webSocketStream = makeWebSocketStream(webSocket, earlyHeader);
    webSocketStream
        .pipeTo(inboundTransform.writable)
        .catch((err) => {
            closeWebSocket(webSocket);
        });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

function makeWebSocketStream(webSocket, earlyHeader) {
    return new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                controller.enqueue(event.data);
            });

            webSocket.addEventListener('close', () => {
                controller.close();
                closeWebSocket(webSocket);
            });

            webSocket.addEventListener('error', (err) => {
                controller.error(err);
            });

            const { earlyData, error } = base64ToBuffer(earlyHeader);
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

async function createUDPTransformer(webSocket, resHeader) {
    let headerSent = false;

    const transformer = new TransformStream({
        transform(chunk, controller) {
            if (chunk.byteLength < 2) return;
            
            const length = new DataView(chunk.buffer, chunk.byteOffset, 2).getUint16(0);
            if (chunk.byteLength < length + 2) return;
            
            controller.enqueue(chunk.slice(2, length + 2));
        }
    });

    transformer.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });

            const dnsResult = await response.arrayBuffer();
            const sizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
            
            const payload = headerSent
                ? new Uint8Array([...sizeBuffer, ...new Uint8Array(dnsResult)])
                : new Uint8Array([...resHeader, ...sizeBuffer, ...new Uint8Array(dnsResult)]);
            
            headerSent = true;
            
            if (webSocket.readyState === 1) {
                webSocket.send(payload);
            }
        }
    }));

    return transformer.writable.getWriter();
}

async function handleTCPData(address, port, data, webSocket, resHeader) {
    const socket = await connect({ hostname: address, port });
    
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (resHeader) {
                controller.enqueue(new Uint8Array([...resHeader, ...chunk]));
                resHeader = null;
            } else {
                controller.enqueue(chunk);
            }
        }
    });

    // 发送初始数据
    const writer = socket.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();

    // 建立双向数据流
    socket.readable
        .pipeThrough(transformStream)
        .pipeTo(new WritableStream({
            write(chunk) {
                if (webSocket.readyState === 1) {
                    webSocket.send(chunk);
                }
            }
        }))
        .catch(() => closeWebSocket(webSocket));
}

let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) {
        return { hasError: true };
    }
    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = ressBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
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
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
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
        ressVersion: version,
        isUDP,
    };
}

function base64ToBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
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
    if (socket.readyState === 1 || socket.readyState === 2) {
        socket.close();
    }
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
