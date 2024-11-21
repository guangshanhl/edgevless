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
            } else {
                return await resOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function resOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let address = '';
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);

    // 使用 TransformStream 处理 WebSocket 数据流
    const transformedStream = new TransformStream({
        async transform(chunk, controller) {
            // 在这里处理从 WebSocket 获取的数据
            let isDns = false;
            let udpWrite = null;

            // 解析响应头等操作
            const {
                hasError,
                portRemote = 443,
                addressRemote = '',
                rawDataIndex,
                resVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processResHeader(chunk, userID);
            address = addressRemote;

            if (hasError) {
                return;
            }

            // 如果是 DNS 请求
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                }
                return; // 不进行数据流处理
            }

            const resHeader = new Uint8Array([resVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            
            // 处理 DNS 请求
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData); // 将 DNS 请求转发出去
                return;
            }

            // 处理 TCP 请求：确保 remoteSocket 已连接
            await handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
            controller.enqueue(chunk); // 将处理后的数据加入输出流
        },
        async flush(controller) {
            // 清理工作，如关闭 WebSocket 或其他清理操作
            closeWebSocket(webSocket);
        }
    });

    // 将 WebSocket 数据流传输至 TransformStream
    readableWebStream.pipeThrough(transformedStream).pipeTo(new WritableStream({
        write(chunk) {
            // 将转换后的数据发送给客户端
            if (webSocket.readyState === WebSocket.OPEN) {
                webSocket.send(chunk);
            }
        },
        close() {
            console.log('WebSocket closed.');
        }
    }));

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            // 如果没有连接，或者连接已经关闭，重新建立连接
            remoteSocket.value = connect({
                hostname: address,
                port: port,
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
        // 尝试连接远程地址，如果失败则连接到代理 IP
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
    const stream = new ReadableStream({
        start(controller) {
            // 监听 WebSocket 消息并传递给流控制器
            webSocket.addEventListener('message', (event) => {
                if (isCancel) return;
                const message = event.data;
                controller.enqueue(message); // 将消息加入流
            });

            // 监听 WebSocket 关闭事件，关闭流
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (isCancel) return;
                controller.close(); // 关闭流
            });

            // 监听 WebSocket 错误事件，流出错时传递错误
            webSocket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                controller.error(err); // 将错误传递给流
            });

            // 处理初始 header 数据（如果存在）
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error); // 如果错误，终止流
            } else if (earlyData) {
                controller.enqueue(earlyData); // 将早期数据加入流
            }
        },
        pull(controller) {},
        cancel(reason) {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket); // 在取消时关闭 WebSocket
        }
    });

    return stream;
}
let cachedUserID;
function processResHeader(resBuffer, userID) {
    if (resBuffer.byteLength < 24) {
        return { hasError: true };
    }
    const version = new Uint8Array(resBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(resBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) {
        return { hasError: true };
    }
    const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
    const command = new Uint8Array(resBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = resBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(resBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
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
        resVersion: version,
        isUDP,
    };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    try {
        await remoteSocket.readable
            .pipeThrough(new TransformStream({
                transform(chunk, controller) {
                    if (resHeader) {
                        const combinedData = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                        combinedData.set(resHeader);
                        combinedData.set(chunk, resHeader.byteLength);
                        resHeader = null;
                        controller.enqueue(combinedData);
                    } else {
                        controller.enqueue(chunk);
                    }
                },
            }))
            .pipeTo(new WritableStream({
                write(chunk) {
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(chunk);
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
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
    // 创建 TransformStream 管道
    const udpTransformStream = new TransformStream({
        async transform(chunk, controller) {
            try {
                // 将请求转发到远程 DNS 服务器
                const dnsResponse = await queryDNS(chunk);

                // 构造响应数据
                const resPayload = queryDNSResponse(resHeader, dnsResponse);

                // 发送给 WebSocket 客户端
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(resPayload);
                }

                // 将数据发送到下游流（如果需要）
                controller.enqueue(resPayload);
            } catch (error) {
                console.error('UDP Transform Error:', error);
                closeWebSocket(webSocket);
                controller.error(error);
            }
        },

        flush(controller) {
            // 在流关闭时，清理资源
            closeWebSocket(webSocket);
        }
    });

    // 返回流写入器以便在其他部分使用
    const writable = udpTransformStream.writable.getWriter();
    return {
        write: chunk => writable.write(chunk).catch(console.error),
    };
}

async function queryDNS(dnsRequest) {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsRequest,
    });
    return await response.arrayBuffer();
}

function queryDNSResponse(resHeader, dnsResponse) {
    const sizeBuffer = new Uint8Array([(dnsResponse.byteLength >> 8) & 0xff, dnsResponse.byteLength & 0xff]);
    const resPayload = new Uint8Array(resHeader.byteLength + sizeBuffer.byteLength + dnsResponse.byteLength);

    // 拼接响应头和 DNS 响应数据
    resPayload.set(resHeader, 0);
    resPayload.set(sizeBuffer, resHeader.byteLength);
    resPayload.set(new Uint8Array(dnsResponse), resHeader.byteLength + sizeBuffer.byteLength);

    return resPayload;
}

function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
