import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
const BUFFER_SIZE = 32768;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
export default {
    async fetch(request, env, ctx) {
      	userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;  
        if (request.headers.get('Upgrade') === 'websocket') {
            return await ressOverWSHandler(request);
        }
        const url = new URL(request.url);
        const routes = {
            '/': () => new Response(JSON.stringify(request.cf)),
            [`/${userID}`]: () => {
                const config = getConfig(userID, request.headers.get('Host'));
                return new Response(config, {
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                });
            }
        };
        const handler = routes[url.pathname];
        return handler ? handler() : new Response('Not found', { status: 404 });
    }
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
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                try {
                    await writer.write(chunk);
                } finally {
                    writer.releaseLock();
                }
                return;
            }
            const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = processRessHeader(chunk, userID);
            if (hasError) return;
            const clientData = chunk.slice(rawDataIndex);
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    return;
                }
            }
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
            } else {
                handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
            }
        }
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
        remoteSocket.value = await connect({ hostname: address, port });
        const writer = remoteSocket.value.writable.getWriter();
	try {
             await writer.write(clientData);
        } finally {
              writer.releaseLock();
        }
        return remoteSocket.value;
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    const connected = await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote);
    if (!connected) {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isActive = true;
    const stream = new ReadableStream({
        start(controller) {
            const messageHandler = (event) => {
                if (!isActive) return;           
                const message = event.data;
                if (message instanceof ArrayBuffer || message instanceof Uint8Array) {
                    for (let offset = 0; offset < message.byteLength; offset += BUFFER_SIZE) {
                        const chunk = new Uint8Array(
                            message.slice(offset, offset + BUFFER_SIZE)
                        );
                        controller.enqueue(chunk);
                    }
                } else {
                    controller.enqueue(message);
                }
            };
            const handleError = (error) => {
                if (!isActive) return;
                controller.error(error);
                isActive = false;
            };
            webSocket.addEventListener('message', messageHandler);
            webSocket.addEventListener('close', () => {
                if (!isActive) return;
                closeWebSocket(webSocket);
                controller.close();
                isActive = false;
            });
            webSocket.addEventListener('error', handleError);
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (error) {
                    handleError(error);
                } else if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
            return () => {
                isActive = false;
                webSocket.removeEventListener('message', messageHandler);
                webSocket.removeEventListener('close', () => {});
                webSocket.removeEventListener('error', handleError);
                closeWebSocket(webSocket);
            };
        },
        pull(controller) {
            return Promise.resolve();
        },
        cancel(reason) {
            isActive = false;
            closeWebSocket(webSocket);
        }
    }, {
        highWaterMark: BUFFER_SIZE,
        size(chunk) {
            return chunk.byteLength || 1;
        }
    });
    return stream;
}
let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) return { hasError: true };
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
    if (webSocket.readyState !== 1) {
	    return false;
    }
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk, controller) {
                let bufferToSend;               
                if (resHeader) {
                    bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    bufferToSend.set(resHeader, 0);
                    bufferToSend.set(chunk, resHeader.byteLength);
                    resHeader = null;
                } else {
                    bufferToSend = chunk;
                }
                for (let offset = 0; offset < bufferToSend.length; offset += BUFFER_SIZE) {
                    const subdata = bufferToSend.slice(offset, offset + BUFFER_SIZE);                   
                    webSocket.send(subdata);
                }
		hasData = true;
            },
        }));
    } catch (error) {
        closeWebSocket(webSocket);
    }
    return hasData;
}
function base64ToBuffer(base64Str) {
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
    let partialChunk = null;    
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            if (partialChunk) {
                chunk = new Uint8Array([...partialChunk, ...chunk]);
                partialChunk = null;
            }            
            let offset = 0;
            while (offset < chunk.byteLength) {
                if (chunk.byteLength < offset + 2) {
                    partialChunk = chunk.slice(offset);
                    break;
                }
                const dataView = new DataView(chunk.buffer, chunk.byteOffset + offset);
                const udpPacketLength = dataView.getUint16(0);
                const nextOffset = offset + 2 + udpPacketLength;
                if (chunk.byteLength < nextOffset) {
                    partialChunk = chunk.slice(offset);
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
            const response = await fetch('https://dns.google/dns-query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/dns-message',
                    'Accept': 'application/dns-message'
                },
                body: chunk
            });
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
        }
    })).catch(error => {
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
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
