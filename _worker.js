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
                return await ressOverWSHandler(request);
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
async function ressOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = '';
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';

    const readableWebStream = makeWebStream(webSocket, earlyHeader);

    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;

    // 使用 TransformStream 处理 WebSocket 数据流
    const transformStream = new TransformStream({
        async start(controller) {
            readableWebStream.pipeTo(new WritableStream({
                async write(chunk, controller) {
                    if (isDns && udpWrite) {
                        return udpWrite(chunk); // 处理 DNS 数据
                    }
                    if (remoteSocket.value) {
                        const writer = remoteSocket.value.writable.getWriter();
                        await writer.write(chunk); // 将数据写入远程 Socket
                        writer.releaseLock();
                        return;
                    }

                    // 处理 ressHeader
                    const {
                        hasError,
                        portRemote = 443,
                        addressRemote = '',
                        rawDataIndex,
                        ressVersion = new Uint8Array([0, 0]),
                        isUDP,
                    } = processRessHeader(chunk, userID);
                    address = addressRemote;

                    if (hasError) {
                        return;
                    }

                    // UDP 数据处理
                    if (isUDP) {
                        if (portRemote === 53) {
                            isDns = true;
                        } else {
                            return;
                        }
                    }

                    // 拼接 header
                    const resHeader = new Uint8Array([ressVersion[0], 0]);
                    const clientData = chunk.slice(rawDataIndex);

                    // DNS 请求处理
                    if (isDns) {
                        const { write } = await handleUDPOutBound(webSocket, resHeader);
                        udpWrite = write;
                        udpWrite(clientData);
                        return;
                    }

                    // TCP 数据转发处理
                    handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
                }
            })).catch((err) => {
                closeWebSocket(webSocket);
            });
        },

        async transform(chunk, controller) {
            // 这里不做额外的数据处理，直接将数据传递
            controller.enqueue(chunk); // 将数据传递下去，不做修改
        },

        cancel(reason) {
            closeWebSocket(webSocket); // 如果流被取消，关闭 WebSocket
        }
    });

    // 创建一个可读流来传输 WebSocket 数据
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
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
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;

    const transformStream = new TransformStream({
        async start(controller) {
            // WebSocket 数据接收
            webSocket.addEventListener('message', (event) => {
                if (isCancel) return;
                const message = event.data;
                controller.enqueue(message); // 将接收到的 WebSocket 消息发送到管道
            });

            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (isCancel) return;
                controller.close(); // 关闭流
            });

            webSocket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                controller.error(err); // 错误时流出错
            });

            // 将早期数据处理成 Buffer
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error); // 错误处理
            } else if (earlyData) {
                controller.enqueue(earlyData); // 如果有早期数据，先行发送
            }
        },

        async transform(chunk, controller) {
            // 这里可以对 WebSocket 数据进行流处理和修改（如压缩、加密等），目前直接传递数据
            controller.enqueue(chunk); // 直接将数据传递到下游
        },

        cancel(reason) {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket); // 取消流时关闭 WebSocket
        }
    });

    return new ReadableStream(transformStream);
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
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    try {
        await remoteSocket.readable
            .pipeThrough(new TransformStream({
                transform(chunk, controller) {
                    if (!resHeader) {
                        controller.enqueue(chunk);
                        return;
                    }                
                    const data = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    data.set(resHeader);
                    data.set(chunk, resHeader.byteLength);
                    controller.enqueue(data);
                    resHeader = null;
                }
            }))
            .pipeTo(new WritableStream({
                write(chunk) {
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(chunk);
                        hasData = true;
                    }
                }
            }));
    } catch {
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
const WEBSOCKET_READY_STATE = {
    OPEN: 1,
    CLOSING: 2
};
function closeWebSocket(socket) {
    if (socket.readyState === WEBSOCKET_READY_STATE.OPEN || socket.readyState === WEBSOCKET_READY_STATE.CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partChunk = null;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partChunk) {
                const combinedChunk = new Uint8Array(partChunk.byteLength + chunk.byteLength);
                combinedChunk.set(partChunk, 0);
                combinedChunk.set(chunk, partChunk.byteLength);
                chunk = combinedChunk;
                partChunk = null;
            }
            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partChunk = chunk.slice(offset);
                    break;
                }
                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;
                if (chunk.byteLength < nextOffset) {
                    partChunk = chunk.slice(offset);
                    break;
                }
                const udpData = chunk.slice(offset + 2, nextOffset);
                offset = nextOffset;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/dns-message' },
                    body: chunk
                });
                const dnsQueryResult = await resp.arrayBuffer();
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);            
                let payload;
                if (headerSent) {
                    payload = new Uint8Array(udpSizeBuffer.byteLength + dnsQueryResult.byteLength);
                    payload.set(udpSizeBuffer, 0);
                    payload.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
                } else {
                    payload = new Uint8Array(resHeader.byteLength + udpSizeBuffer.byteLength + dnsQueryResult.byteLength);
                    payload.set(resHeader, 0);
                    payload.set(udpSizeBuffer, resHeader.byteLength);
                    payload.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + udpSizeBuffer.byteLength);
                    headerSent = true;
                }
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(payload);
                }
            } catch (error) {
            }
        }
    })).catch((error) => {});
    const writer = transformStream.writable.getWriter();   
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
