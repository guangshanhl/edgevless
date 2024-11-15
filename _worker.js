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
                        const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
                        return new Response(`${vlessConfig}`, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8",
                            }
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
    let portWithRandomLog = '';
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const log = (info, event) => console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
    let remoteSocket = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    const handleChunk = async (chunk) => {
        if (isDns && udpStreamWrite) {
            return udpStreamWrite(chunk);
        }
        if (remoteSocket.value) {
            const writer = remoteSocket.value.writable.getWriter();
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
            vlessVersion = new Uint8Array([0, 0]),
            isUDP,
        } = processVlessHeader(chunk, userID);
        address = addressRemote;
        portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
        if (hasError) {
            log(message);
            return;
        }
        if (isUDP) {
            if (portRemote === 53) {
                isDns = true;
            } else {
                log('Unsupported UDP port');
                return;
            }
        }
        const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
        const rawClientData = chunk.slice(rawDataIndex);
        if (isDns) {
            const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
        }
        handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    };
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            await handleChunk(chunk);
        },
        close() {
            log('readableWebSocketStream is close');
        },
        abort(reason) {
            log('readableWebSocketStream is abort', JSON.stringify(reason));
        }
    })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
    async function connectAndWrite(address, port) {
        if (!remoteSocket.value || remoteSocket.value.closed) {
            remoteSocket.value = connect({
                hostname: address,
                port: port,
            });
            log(`connected to ${address}:${port}`);
        } else {
            log(`already connected to ${address}:${port}`);
        }        
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();       
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, log);
    }
    if (!await tryConnect(addressRemote, portRemote)) {
        if (!await tryConnect(proxyIP, portRemote)) {
            closeWebSocket(webSocket);
        }
    }
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            const messageHandler = (event) => {
                if (!readableStreamCancel) {
                    controller.enqueue(event.data);
                }
            };
            const closeHandler = () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) {
                    controller.close();
                }
            };
            const errorHandler = (err) => {
                log('webSocketServer has error');
                controller.error(err);
            };
            webSocketServer.addEventListener('message', messageHandler);
            webSocketServer.addEventListener('close', closeHandler);
            webSocketServer.addEventListener('error', errorHandler);
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
            controller.signal.addEventListener('abort', () => {
                webSocketServer.removeEventListener('message', messageHandler);
                webSocketServer.removeEventListener('close', closeHandler);
                webSocketServer.removeEventListener('error', errorHandler);
                safeCloseWebSocket(webSocketServer);
            });
        },
        pull(controller) {},
        cancel(reason) {
            if (!readableStreamCancel) {
                log(`ReadableStream was canceled, due to ${reason}`);
                readableStreamCancel = true;
                safeCloseWebSocket(webSocketServer);
            }
        }
    });
    return stream;
}
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data',
        };
    }
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const userBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
    const isValidUser = stringify(userBuffer) === userID;
    if (!isValidUser) {
        return {
            hasError: true,
            message: 'invalid user',
        };
    }
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 19 + optLength))[0];
    let isUDP = false;
    if (command !== 1 && command !== 2) {
        return {
            hasError: false,
            message: `command ${command} is not supported, command 01-tcp, 02-udp, 03-mux`,
        };
    } else if (command === 2) {
        isUDP = true;
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    const addressType = new Uint8Array(vlessBuffer.slice(portIndex + 2, portIndex + 3))[0];
    let addressValue = '';
    let addressLength = 0;
    switch (addressType) {
        case 1: // IPv4
            addressLength = 4;
            addressValue = Array.from(new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 7))).join('.');
            break;
        case 2: // Domain name
            addressLength = new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 4))[0];
            addressValue = new TextDecoder().decode(vlessBuffer.slice(portIndex + 4, portIndex + 4 + addressLength));
            break;
        case 3: // IPv6
            addressLength = 16;
            const ipv6Buffer = new DataView(vlessBuffer.slice(portIndex + 3, portIndex + 19));
            addressValue = [];
            for (let i = 0; i < 8; i++) {
                addressValue.push(ipv6Buffer.getUint16(i * 2).toString(16));
            }
            addressValue = addressValue.join(':');
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
        rawDataIndex: portIndex + 3 + addressLength,
        vlessVersion: version,
        isUDP,
    };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, log) {
    let hasIncomingData = false;
    let vlessHeader = vlessResponseHeader;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    hasIncomingData = true;
                    if (webSocket.readyState !== WebSocket.OPEN) {
                        return controller.error('webSocket.readyState is not open, maybe close');
                    }
                    if (vlessHeader) {
                        const combined = new Uint8Array(vlessHeader.length + chunk.byteLength);
                        combined.set(new Uint8Array(vlessHeader), 0);
                        combined.set(new Uint8Array(chunk), vlessHeader.length);
                        webSocket.send(combined.buffer);
                        vlessHeader = null;
                    } else {
                        webSocket.send(chunk);
                    }
                },
                close() {
                    log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
                },
                abort(reason) {
                    log(`remoteConnection!.readable abort, reason: ${reason}`);
                }
            })
        );
    } catch (error) {
        log(`remoteSocketToWS has exception: ${error.stack || error}`);
        safeCloseWebSocket(webSocket);
    }
    return hasIncomingData;
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decodedStr = atob(normalizedStr);
        const arrayBuffer = Uint8Array.from(decodedStr, (c) => c.charCodeAt(0));
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}
const WEBSOCKET_READY_STATE = {
    OPEN: 1,
    CLOSING: 2
};
function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WEBSOCKET_READY_STATE.OPEN || socket.readyState === WEBSOCKET_READY_STATE.CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('Error in safeCloseWebSocket:', error);
    }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return [
        byteToHex[arr[offset + 0]], byteToHex[arr[offset + 1]], byteToHex[arr[offset + 2]], byteToHex[arr[offset + 3]],
        '-',
        byteToHex[arr[offset + 4]], byteToHex[arr[offset + 5]],
        '-',
        byteToHex[arr[offset + 6]], byteToHex[arr[offset + 7]],
        '-',
        byteToHex[arr[offset + 8]], byteToHex[arr[offset + 9]],
        '-',
        byteToHex[arr[offset + 10]], byteToHex[arr[offset + 11]], byteToHex[arr[offset + 12]], byteToHex[arr[offset + 13]], byteToHex[arr[offset + 14]], byteToHex[arr[offset + 15]]
    ].join('').toLowerCase();
}
function stringify(arr, offset = 0) {
    return unsafeStringify(arr, offset);
}
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
    let isVlessHeaderSent = false;
    const processUdpChunk = (chunk) => {
        let index = 0;
        const udpPackets = [];
        while (index < chunk.byteLength) {
            const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
            const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
            index += 2 + udpPacketLength;
            udpPackets.push(udpData);
        }
        return udpPackets;
    };
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            const udpPackets = processUdpChunk(chunk);
            udpPackets.forEach(packet => controller.enqueue(packet));
        }
    });
    try {
        await transformStream.readable.pipeTo(new WritableStream({
            async write(chunk) {
                try {
                    const response = await fetch('https://dns.google/dns-query', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/dns-message' },
                        body: chunk
                    });
                    const dnsQueryResult = await response.arrayBuffer();
                    const udpSize = dnsQueryResult.byteLength;
                    const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                    const dataToSend = isVlessHeaderSent
                        ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                        : new Uint8Array([...vlessResponseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
                    if (webSocket.readyState === WebSocket.OPEN) {
                        log(`doh success and dns message length is ${udpSize}`);
                        webSocket.send(dataToSend.buffer);
                        isVlessHeaderSent = true;
                    }
                } catch (error) {
                    log('dns udp has error: ' + error);
                }
            }
        }));
    } catch (error) {
        log('dns udp has error: ' + error);
    }
    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}
function getVLESSConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
