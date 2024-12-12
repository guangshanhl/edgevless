import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
const BUFFER_SIZE = 65536;
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
        async write(chunk) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                const writer = remoteSocket.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
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
        await writer.write(clientData);
        writer.releaseLock();
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
                        const chunk = new Uint8Array(message.slice(offset, offset + BUFFER_SIZE));
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
    const version = new DataView(ressBuffer, 0, 1).getUint8(0);
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer, 1, 16);
    if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = new DataView(ressBuffer, 17, 1).getUint8(0);
    const command = new DataView(ressBuffer, 18 + optLength, 1).getUint8(0);
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer, portIndex, 2).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(ressBuffer, addressIndex, 1).getUint8(0);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer, addressValueIndex, addressLength).join('.');
            break;
        case 2:
            addressLength = new DataView(ressBuffer, addressValueIndex, 1).getUint8(0);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                new Uint8Array(ressBuffer, addressValueIndex, addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const ipv6Parts = new Uint16Array(ressBuffer, addressValueIndex, addressLength / 2);
            addressValue = Array.from(ipv6Parts, part => part.toString(16)).join(':');
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
    try {
	let headerProcessed = false;
        await remoteSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                let bufferToSend;
                if (!headerProcessed && resHeader) {
                    bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                    bufferToSend.set(resHeader, 0);
                    bufferToSend.set(chunk, resHeader.byteLength);
                    resHeader = null;
					headerProcessed = true;
                } else {
                    bufferToSend = chunk;
                }
		if (webSocket.readyState === 1) {
			for (let offset = 0; offset < bufferToSend.length; offset += BUFFER_SIZE) {
				const subdata = bufferToSend.slice(offset, offset + BUFFER_SIZE);
				webSocket.send(subdata);
			}
			hasData = true;
		}
            }
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
        const arrayBuffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));      
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
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
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, chunk.byteOffset + index, 2).getUint16(0);
                const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
                controller.enqueue(udpData);
                index += 2 + udpPacketLength;
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const response = await fetch('https://dns.google/dns-query', {
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
            });
            const dnsQueryResult = await response.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            const dataToSend = headerSent 
                ? new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer()
                : new Blob([resHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer();
            if (webSocket.readyState === 1) {
                webSocket.send(await dataToSend);
                headerSent = true;
            }
        }
    }));
    return {
        write(chunk) {
            transformStream.writable.getWriter().write(chunk);
        }
    };
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
