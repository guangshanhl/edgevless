import { connect } from 'cloudflare:sockets';
class DataHandler {
    static bufferSize = 16384;
    static processor = {
        buffer: new Uint8Array(DataHandler.bufferSize),       
        processChunk(chunk) {
            if (chunk.byteLength <= DataHandler.bufferSize) {
                this.buffer.set(new Uint8Array(chunk), 0);
                return this.buffer.slice(0, chunk.byteLength);
            }
            return new Uint8Array(chunk);
        }
    };
    static processHeader(ressBuffer, userID) {
        if (!this.cachedUserID) {
            this.cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
        }
        return this.parseHeader(ressBuffer);
    }
    static parseHeader(ressBuffer) {
        if (ressBuffer.byteLength < 24) return { hasError: true };
        const version = new Uint8Array(ressBuffer.slice(0, 1));
        const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));       
        const hasError = bufferUserID.some((byte, index) => byte !== this.cachedUserID[index]);
        if (hasError) return { hasError: true };
        const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
        const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];       
        let isUDP = command === 2;
        if (command !== 1 && !isUDP) return { hasError: false };
        const portIndex = 18 + optLength + 1;
        const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
        let addressIndex = portIndex + 2;
        const addressType = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1))[0];
        return this.parseAddress(addressType, ressBuffer, addressIndex, version, portRemote, isUDP);
    }
    static parseAddress(addressType, ressBuffer, addressIndex, version, portRemote, isUDP) {
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
            ressVersion: version,
            isUDP,
        };
    }
}
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
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
    readableWebStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            const processedChunk = DataHandler.processor.processChunk(chunk);
            if (isDns && udpWrite) {
                return udpWrite(processedChunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(processedChunk);
                writer.releaseLock();
                return;
            }
            const headerInfo = DataHandler.processHeader(processedChunk, userID);
            if (headerInfo.hasError) return;
            const { portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = headerInfo;
            if (isUDP && portRemote === 53) {
                isDns = true;
            } else if (isUDP) {
                return;
            }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = processedChunk.slice(rawDataIndex);
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
    let isCancel = false;
    const handleMessage = (event, controller) => {
        if (!isCancel) {
            controller.enqueue(event.data);
        }
    };
    const handleClose = (controller) => {
        if (!isCancel) {
            controller.close();
            closeWebSocket(webSocket);
        }
    };
    const handleError = (err, controller) => {
        controller.error(err);
        closeWebSocket(webSocket);
    };
    const decodeBase64ToBuffer = (base64Str) => {
        try {
            const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
            const binaryStr = atob(normalizedStr);
            const length = binaryStr.length;
            const arrayBuffer = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                arrayBuffer[i] = binaryStr.charCodeAt(i);
            }
            return arrayBuffer.buffer;
        } catch {
            return null;
        }
    };
    const stream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => handleMessage(event, controller));
            webSocket.addEventListener('close', () => handleClose(controller));
            webSocket.addEventListener('error', (err) => handleError(err, controller));
            if (earlyHeader) {
                const earlyDataBuffer = decodeBase64ToBuffer(earlyHeader);
                if (earlyDataBuffer) {
                    controller.enqueue(earlyDataBuffer);
                } else {
                    controller.error(error);
                }
            }
        },
        cancel(reason) {
            if (!isCancel) {
                isCancel = true;
                closeWebSocket(webSocket);
            }
        }
    });
    return stream;
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

    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {            
            const processedChunk = DataHandler.processor.processChunk(chunk);
            let sendToData;

            if (resHeader) {
                sendToData = new Uint8Array(resHeader.byteLength + processedChunk.byteLength);
                sendToData.set(resHeader, 0);
                sendToData.set(processedChunk, resHeader.byteLength);
                resHeader = null;
            } else {
                sendToData = processedChunk;
            }

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.send(sendToData);
                hasData = true;
            }
        },
    })).catch((error) => {
        closeWebSocket(webSocket);
    });

    return hasData;
}

function closeWebSocket(socket) {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
        socket.close();
    }
}

async function handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    let partChunk = null;

    const transformStream = new TransformStream({
        transform(chunk, controller) {
            const processedChunk = DataHandler.processor.processChunk(chunk);
            
            if (partChunk) {
                processedChunk = new Uint8Array([...partChunk, ...processedChunk]);
                partChunk = null;
            }

            let offset = 0;
            while (offset < processedChunk.byteLength) {
                if (processedChunk.byteLength < offset + 2) {
                    partChunk = processedChunk.slice(offset);
                    break;
                }

                const udpPacketLength = new DataView(processedChunk.buffer, processedChunk.byteOffset + offset, 2).getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;

                if (processedChunk.byteLength < nextOffset) {
                    partChunk = processedChunk.slice(offset);
                    break;
                }

                const udpData = processedChunk.slice(offset + 2, nextOffset);
                offset = nextOffset;
                controller.enqueue(udpData);
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

function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
