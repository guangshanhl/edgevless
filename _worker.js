import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env, ctx) {
        userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;   
        try {
            if(request.headers.get('Upgrade') === 'websocket') {
                return await handleWebSocket(request);
            }
            const url = new URL(request.url);
            const routes = new Map([
                ['/', () => new Response(JSON.stringify(request.cf))],
                [`/${userID}`, () => {
                    const config = getConfig(userID, request.headers.get('Host'));
                    return new Response(config, {
                        headers: {'Content-Type': 'text/plain;charset=utf-8'}
                    });
                }]
            ]);
            const handler = routes.get(url.pathname);
            return handler ? handler() : new Response('Not found', {status: 404});
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
async function handleWebSocket(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpWrite) {
                udpWrite(chunk);
                return;
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
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP && portRemote === 53) {
  		isDns = true;
	    } else if (isUDP) {
		return;
	    }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({ hostname: address, port });
        }
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    async function tryConnect(address) {
        const tcpSocket = await connectAndWrite(address, portRemote);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    if (await tryConnect(addressRemote)) {
        return;
    }
    if (await tryConnect(proxyIP)) {
        return;
    }
    closeWebSocket(webSocket);
}
function makeWebStream(webSocket, earlyHeader) {
    let isActive = true;
    return new ReadableStream({
        start(controller) {
             webSocket.addEventListener('message', (event) => {
		if (!isActive) return;
		const message = event.data;
		controller.enqueue(message);
	    });
            webSocket.addEventListener('close', () => {
                if (!isActive) return;
                closeWebSocket(webSocket);
                controller.close();
                isActive = false;
            });
            webSocket.addEventListener('error', (error) => {
                if (!isActive) return;
                controller.error(error);
                isActive = false;
            });
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (!error && earlyData) {
                    controller.enqueue(earlyData);
                }
            }
        },
        cancel() {
            isActive = false;
            closeWebSocket(webSocket);
        }
    });
}
let cachedUserID;

function processRessHeader(ressBuffer, userID) {
    const MIN_BUFFER_LENGTH = 24;
    const USER_ID_SIZE = 16;
    const COMMAND_POS = 18;
    const PORT_SIZE = 2;
    const IPV6_SIZE = 16;

    if (ressBuffer.byteLength < MIN_BUFFER_LENGTH) {
        return { hasError: true };
    }

    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;

    // 缓存 userID 仅在第一次解析时
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }

    // 比较用户ID
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, USER_ID_SIZE + 1));
    for (let i = 0; i < USER_ID_SIZE; i++) {
        if (bufferUserID[i] !== cachedUserID[i]) {
            return { hasError: true };
        }
    }

    // 获取命令并检查
    const optLength = ressBuffer[USER_ID_SIZE + 1];
    const command = ressBuffer[COMMAND_POS + optLength];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }

    // 获取端口信息
    const portRemote = new DataView(ressBuffer.slice(COMMAND_POS + optLength + 1, COMMAND_POS + optLength + 3)).getUint16(0);
    let addressIndex = COMMAND_POS + optLength + 3;

    const addressType = ressBuffer[addressIndex];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2: // DNS
            addressLength = ressBuffer[addressValueIndex];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: // IPv6
            addressLength = IPV6_SIZE;
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

    if (!addressValue) return { hasError: true };

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

async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                let bufferToSend;               
                if (resHeader) {
                    bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    bufferToSend.set(resHeader);
                    bufferToSend.set(chunk, resHeader.byteLength);
                    resHeader = null;
                } else {
                    bufferToSend = chunk;
                }
                if (webSocket.readyState === 1) {
                    webSocket.send(bufferToSend);
                    hasData = true;
                }
            },
        }));
    } catch (error) {
        closeWebSocket(webSocket);
    }
    return hasData;
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
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (chunk.byteLength < 2) return;
            const dataView = new DataView(chunk.buffer, chunk.byteOffset);
            const udpPacketLength = dataView.getUint16(0);
            if (chunk.byteLength < 2 + udpPacketLength) return;
            const udpData = chunk.slice(2, 2 + udpPacketLength);
            controller.enqueue(udpData);
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                const response = await fetch('https://cloudflare-dns.com/dns-query', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/dns-message',
                        'Accept': 'application/dns-message'
                    },
                    body: chunk
                });
                if (!response.ok) {
                    throw new Error(`DNS query failed: ${response.status}`);
                }
                const dnsQueryResult = await response.arrayBuffer();
                const udpSizeBuffer = new Uint8Array([
                    (dnsQueryResult.byteLength >> 8) & 0xff,
                    dnsQueryResult.byteLength & 0xff
                ]);
                const payload = headerSent 
                    ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                    : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);               
                headerSent = true;
                if (webSocket.readyState === 1) {
                    webSocket.send(payload);
                }
            } catch (error) {
                closeWebSocket(webSocket);
            }
        }
    })).catch(() => {
        closeWebSocket(webSocket);
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
