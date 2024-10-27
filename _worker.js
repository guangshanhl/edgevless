import { connect } from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            const isWebSocket = request.headers.get('Upgrade') === 'websocket';
            if (isWebSocket) {
                return handleWsRequest(request, userID, proxyIP);
            }
            return handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const path = new URL(request.url).pathname;
    if (path === "/") {
        return new Response(JSON.stringify(request.cf, null, 4));
    }
    if (path === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            }
        });
    }
    return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
    const [clientSocket, serverSocket] = new WebSocketPair();
    serverSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, earlyDataHeader);
    let remoteSocket = { value: null };
    const responseHeader = new Uint8Array(2);    
    const writableStream = new WritableStream({
        async write(chunk) {
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;
            responseHeader[0] = passVersion[0];
            responseHeader[1] = 0;
            const rawClientData = chunk.slice(rawDataIndex);
            if (isUDP && port === 53) {
                await handleUdpRequest(serverSocket, responseHeader, rawClientData);
                return;
            }
            handleTcpRequest(remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP);
        }
    });    
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: clientSocket });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({ hostname: address, port });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
    const tryConnect = async (address, port) => {
        try {
            const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
            return await forwardToData(tcpSocket, serverSocket, responseHeader);
        } catch (error) {
            return false;
        }
    };    
    if (!(await tryConnect(address, port) || await tryConnect(proxyIP, port))) {
        closeWebSocket(serverSocket);
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
    const stream = new ReadableStream({
        start(controller) {
            serverSocket.addEventListener("message", (event) => {
                const message = event.data;
                controller.enqueue(message);
            });
            serverSocket.addEventListener("close", () => {
                closeWebSocket(serverSocket);
                controller.close();
            });
            serverSocket.addEventListener("error", (err) => {
                controller.error(err);
            });
            const { earlyData, error } = base64ToBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        cancel() {
            closeWebSocket(serverSocket);
        },
    });
    return stream;
};
class WebSocketHeader {
    constructor(hasError, address, port, rawDataIndex, passVersion, isUDP) {
        this.hasError = hasError;
        this.address = address;
        this.port = port;
        this.rawDataIndex = rawDataIndex;
        this.passVersion = passVersion;
        this.isUDP = isUDP;
    }
}
const processWebSocketHeader = (buffer, userID) => {
    const bytes = new Uint8Array(buffer);
    const receivedID = stringify(bytes.slice(1, 17));
    if (receivedID !== userID) return new WebSocketHeader(true);
    const optLength = bytes[17];
    const commandStartIndex = 18 + optLength;
    const command = bytes[commandStartIndex];
    const isUDP = command === 2;
    const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
    return new WebSocketHeader(false, address, port, rawDataIndex, bytes.slice(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
    const addressType = bytes[startIndex];
    let addressLength;
    if (addressType === 2) {
        addressLength = bytes[startIndex + 1];
    } else if (addressType === 1) {
        addressLength = 4;
    } else {
        addressLength = 16;
    }    
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = (addressType === 1)
        ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
        : (addressType === 2)
            ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
            : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');    
    return {
        address: addressValue,
        rawDataIndex: addressValueIndex + addressLength,
    };
};
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
    let hasData = false;
    try {
        await remoteSocket.readable.pipeTo(
            new WritableStream({
                async write(chunk, controller) {             
                    if (serverSocket.readyState !== WebSocket.OPEN) {
                        controller.error('serverSocket is closed');
                        return;
                    }
                    if (responseHeader) {
                        const combined = new Uint8Array(responseHeader.length + chunk.length);
                        combined.set(new Uint8Array(responseHeader), 0);
                        combined.set(new Uint8Array(chunk), responseHeader.length);
                        serverSocket.send(combined);
                        responseHeader = null;
                    } else {
                        serverSocket.send(chunk);
                    }
                    hasData = true;
                }
            })
        );
    } catch (error) {
        closeWebSocket(serverSocket);
    }
    return hasData;
};
const base64ToBuffer = (base64Str) => {
    try {
        if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
            return { earlyData: base64Str, error: null };
        }
        const binaryStr = atob(base64Str.replace(/[-_]/g, (match) => (match === '-' ? '+' : '/')));
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};
const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};
const byteToHexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    const result = [];
    for (const len of segments) {
        let str = '';
        for (let i = 0; i < len; i++) {
            str += byteToHexTable[arr[offset++]];
        }
        result.push(str);
    }
    return result.join('-').toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader, rawClientData) => {
    const dnsFetch = async (chunk) => {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'content-type': 'application/dns-message' },
            body: chunk
        });
        return response.arrayBuffer();
    };  
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let index = 0;
            while (index < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
                const dnsResult = await dnsFetch(chunk.slice(index + 2, index + 2 + udpPacketLength));
                const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
                if (serverSocket.readyState === WebSocket.OPEN) {
                    serverSocket.send(new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsResult)]).buffer);
                }
                index += 2 + udpPacketLength;
            }
        }
    }); 
    const writer = transformStream.writable.getWriter();
    await writer.write(rawClientData);
    writer.close();
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
