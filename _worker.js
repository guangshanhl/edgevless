import {
    connect
}
from 'cloudflare:sockets';
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
                    return new Response(JSON.stringify(request.cf), {
                        status: 200
                    });
                case `/${userID}`: {
                        const passConfig = getpassConfig(userID, request.headers.get('Host'));
                        return new Response(`${passConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                default:
                    return new Response('Not found', {
                        status: 404
                    });
                }
            } else {
                return await passOverWSHandler(request);
            }
        } catch (err) {
            let e = err;
            return new Response(e.toString());
        }
    },
};
async function passOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
    let portWithRandomLog = '';
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    let remoteSocketWapper = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;
    readableWebSocketStream.pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (isDns && udpStreamWrite) {
                    return udpStreamWrite(chunk);
                }
                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter()
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
                    passVersion = new Uint8Array([0, 0]),
                    isUDP,
                } = processpassHeader(chunk, userID);
                address = addressRemote;
                portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
} `;
                if (hasError) {
                    throw new Error(message);
                    return;
                }
                if (isUDP) {
                    if (portRemote === 53) {
                        isDns = true;
                    } else {
                        throw new Error('UDP proxy only enable for DNS which is port 53');
                        return;
                    }
                }
                const passResponseHeader = new Uint8Array([passVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);
                if (isDns) {
                    const {
                        write
                    } = await handleUDPOutBound(webSocket, passResponseHeader, log);
                    udpStreamWrite = write;
                    udpStreamWrite(rawClientData);
                    return;
                }
                handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, passResponseHeader, log);
            },
            close() {
                log(`readableWebSocketStream is close`);
            },
            abort(reason) {
                log(`readableWebSocketStream is abort`, JSON.stringify(reason));
            },
        })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, passResponseHeader, log, ) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        log(`connected to ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }
    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
            tcpSocket.closed.catch(error => {
                console.log('retry tcpSocket closed error', error);
            }).finally(() => {
                safeCloseWebSocket(webSocket);
            })
            remoteSocketToWS(tcpSocket, webSocket, passResponseHeader, null, log);
    }
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, passResponseHeader, retry, log);
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });
            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                controller.error(err);
            });
            const {
                earlyData,
                error
            } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {},
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }
            log(`ReadableStream was canceled, due to ${reason}`)
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
    return stream;
}
function processpassHeader(passBuffer, userID) {
    if (passBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data',
        };
    }
    const version = new Uint8Array(passBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    if (stringify(new Uint8Array(passBuffer.slice(1, 17))) === userID) {
        isValidUser = true;
    }
    if (!isValidUser) {
        return {
            hasError: true,
            message: 'invalid user',
        };
    }
    const optLength = new Uint8Array(passBuffer.slice(17, 18))[0];
    const command = new Uint8Array(passBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    if (command === 1) {
        // 处理命令 1（通常是 TCP）
    } else if (command === 2) {
        isUDP = true;
    } else if (command === 3) {
        // 处理命令 3 (MUX)
        console.log('MUX command encountered, skipping.');
        return {
            hasError: false, // 如果你选择跳过 MUX 命令，可以这样返回
        };
    }
    
    const portIndex = 18 + optLength + 1;
    const portBuffer = passBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(passBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    
    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = new Uint8Array(passBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2: // 域名
            addressLength = new Uint8Array(passBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(passBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            const dataView = new DataView(passBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `invalid addressType ${addressType}`,
            };
    }

    if (!addressValue) {
        return {
            hasError: true,
            message: `addressValue is empty, addressType is ${addressType}`,
        };
    }
    
    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        passVersion: version,
        isUDP,
    };
}

async function remoteSocketToWS(remoteSocket, webSocket, passResponseHeader, retry, log) {
    let remoteChunkCount = 0;
    let chunks = [];
    let passHeader = passResponseHeader;
    let hasIncomingData = false;

    // 使用 ReadableStream 进行数据传输
    await remoteSocket.readable
    .pipeTo(
        new WritableStream({
            start() {},
            async write(chunk, controller) {
                hasIncomingData = true;

                // 检查 WebSocket 是否已关闭
                if (webSocket.readyState !== WebSocket.OPEN) {
                    controller.error('WebSocket is not open, cannot send data.');
                    return; // 如果 WebSocket 已关闭，停止写入
                }

                // 如果有 passResponseHeader，先发送头部再发送数据
                if (passHeader) {
                    try {
                        const combinedData = await new Blob([passHeader, chunk]).arrayBuffer();
                        webSocket.send(combinedData);
                        passHeader = null; // 只发送一次头部
                    } catch (err) {
                        console.error("Error sending combined header and data:", err);
                        controller.error("Error sending data with header.");
                    }
                } else {
                    try {
                        webSocket.send(chunk);
                    } catch (err) {
                        console.error("Error sending data:", err);
                        controller.error("Error sending data.");
                    }
                }
            },
            close() {
                log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
            },
            abort(reason) {
                console.error(`remoteConnection!.readable abort`, reason);
                if (webSocket.readyState === WebSocket.OPEN) {
                    safeCloseWebSocket(webSocket); // 确保 WebSocket 在流中止时安全关闭
                }
            },
        })
    )
    .catch((error) => {
        console.error(`remoteSocketToWS has exception: `, error.stack || error);
        safeCloseWebSocket(webSocket); // 出现异常时关闭 WebSocket
    });

    // 如果没有接收到任何数据，并且存在重试逻辑，则调用重试函数
    if (!hasIncomingData && retry) {
        log(`No incoming data, retrying...`);
        retry();
    }
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return {
            error: null
        };
    }
    try {
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return {
            earlyData: arryBuffer.buffer,
            error: null
        };
    } catch (error) {
        return {
            error
        };
    }
}
function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('safeCloseWebSocket error', error);
    }
}
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
async function handleUDPOutBound(webSocket, passResponseHeader, log) {
    let ispassHeaderSent = false;
    const transformStream = new TransformStream({
        start(controller) {},
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength; ) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(
                        chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) {}
    });
    transformStream.readable.pipeTo(new WritableStream({
            async write(chunk) {
                const resp = await fetch('https://1.1.1.1/dns-query', {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/dns-message',
                    },
                    body: chunk,
                })
                    const dnsQueryResult = await resp.arrayBuffer();
                const udpSize = dnsQueryResult.byteLength;
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    log(`doh success and dns message length is ${udpSize}`);
                    if (ispassHeaderSent) {
                        webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                    } else {
                        webSocket.send(await new Blob([passResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                        ispassHeaderSent = true;
                    }
                }
            }
        })).catch((error) => {
        log('dns udp has error' + error)
    });
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getpassConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
