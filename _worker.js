import { connect } from 'cloudflare:sockets';

// 优化的数据流处理
class StreamProcessor {
    static CHUNK_SIZE = 64 * 1024; // 64KB chunks
    static BUFFER_THRESHOLD = 1024 * 1024; // 1MB buffer threshold
    
    static createTransformStream() {
        return new TransformStream({
            transform: (chunk, controller) => {
                if (chunk.byteLength > this.CHUNK_SIZE) {
                    let offset = 0;
                    while (offset < chunk.byteLength) {
                        const size = Math.min(this.CHUNK_SIZE, chunk.byteLength - offset);
                        controller.enqueue(chunk.slice(offset, offset + size));
                        offset += size;
                    }
                } else {
                    controller.enqueue(chunk);
                }
            }
        });
    }
}

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

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebStream = makeWebStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    let isDns = false;

    readableWebStream
        .pipeThrough(StreamProcessor.createTransformStream())
        .pipeTo(new WritableStream({
            async write(chunk, controller) {
                if (isDns && udpWrite) {
                    return udpWrite(chunk);
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

function makeWebStream(webSocket, earlyHeader) {
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
                closeWebSocket(webSocket);
            });

            if (earlyHeader) {
                const earlyData = decodeBase64ToBuffer(earlyHeader);
                if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    }, { highWaterMark: StreamProcessor.BUFFER_THRESHOLD });
}

function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };

    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }

    const version = ressBuffer.slice(0, 1);
    const bufferUserID = ressBuffer.slice(1, 17);
    
    if (new Uint8Array(bufferUserID).some((byte, index) => byte !== cachedUserID[index])) {
        return { hasError: true };
    }

    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    
    const isUDP = command === 2;
    if (command !== 1 && !isUDP) return { hasError: false };

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

    let addressIndex = portIndex + 2;
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
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: new Uint8Array(version),
        isUDP,
    };
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
        remoteSocket.value = connect({ hostname: address, port });
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }

    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }

    if (!(await tryConnect(addressRemote, portRemote)) && !(await tryConnect(proxyIP, portRemote))) {
        closeWebSocket(webSocket);
    }
}

async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;

    await remoteSocket.readable
        .pipeThrough(StreamProcessor.createTransformStream())
        .pipeTo(new WritableStream({
            write(chunk) {
                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    if (resHeader) {
                        const data = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                        data.set(resHeader, 0);
                        data.set(chunk, resHeader.byteLength);
                        webSocket.send(data);
                        resHeader = null;
                    } else {
                        webSocket.send(chunk);
                    }
                    hasData = true;
                }
            }
        })).catch((error) => {
            closeWebSocket(webSocket);
        });

    return hasData;
}

async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partChunk = null;
    const chunks = [];
    let totalLength = 0;

    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partChunk) {
                chunk = new Uint8Array([...partChunk, ...chunk]);
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

                chunks.push(udpData);
                totalLength += udpData.byteLength;

                if (totalLength >= StreamProcessor.CHUNK_SIZE) {
                    const mergedChunk = new Uint8Array(totalLength);
                    let chunkOffset = 0;
                    for (const piece of chunks) {
                        mergedChunk.set(piece, chunkOffset);
                        chunkOffset += piece.byteLength;
                    }
                    controller.enqueue(mergedChunk);
                    chunks.length = 0;
                    totalLength = 0;
                }
            }
        },
        flush(controller) {
            if (chunks.length > 0) {
                const mergedChunk = new Uint8Array(totalLength);
                let offset = 0;
                for (const piece of chunks) {
                    mergedChunk.set(piece, offset);
                    offset += piece.byteLength;
                }
                controller.enqueue(mergedChunk);
            }
        }
    });

    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/dns-message' },
                body: chunk
            });

            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            
            const payload = headerSent
                ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
                : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
            
            headerSent = true;

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(payload);
            }
        }
    }));

    const writer = transformStream.writable.getWriter();
    return {
        write(chunk) {
            writer.write(chunk);
        }
    };
}

function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}

function decodeBase64ToBuffer(base64Str) {
    try {
        const normalized = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(normalized), c => c.charCodeAt(0));
    } catch {
        return null;
    }
}

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
