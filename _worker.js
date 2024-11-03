import { connect } from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            const isSocket = request.headers.get('Upgrade') === 'websocket';
            return isSocket 
                ? handleWsRequest(request, userID, proxyIP) 
                : handleHttpRequest(request, userID);
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
        const vlessConfig = getConfig(userID, request.headers.get("Host"));
        return new Response(vlessConfig, {
            headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
    }
    return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
    const [client, webSocket] = new WebSocketPair();
    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWSStream(webSocket, earlyHeader);
    let remoteSocket = { value: null };
    let udpWrite = null;
    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (udpWrite) {
                return udpWrite(chunk);
            }
            if (remoteSocket.value) {
                await writeToRemote(remoteSocket.value, chunk);
                return;
            }
            const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
            if (hasError) return;
            const resHeader = new Uint8Array([passVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isUDP && port === 53) {
                const { write } = await handleUdpRequest(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTcpRequest(remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handleTcpRequest = async (remoteSocket, address, port, clientData, webSocket, resHeader, proxyIP) => {
  const tryConnect = async (addr) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
      remoteSocket.value = await connect({ hostname: addr, port });
    }
    await writeToRemote(remoteSocket.value, clientData);
    return await forwardToData(remoteSocket.value, webSocket, resHeader);
  };
  if (!(await tryConnect(address)) && !(await tryConnect(proxyIP))) {
    closeWebSocket(webSocket);
  }
};
const createWSStream = (webSocket, earlyHeader) => { 
    const handleEvent = (event, controller) => {
        switch (event.type) {
            case 'message':
                controller.enqueue(event.data);
                break;
            case 'close':
                closeWebSocket(webSocket);
                controller.close();
                break;
            case 'error':
                controller.error(event);
                break;
        }
    };
    return new ReadableStream({
        start(controller) {
            const { earlyData, error } = base64ToBuffer(earlyHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
            ['message', 'close', 'error'].forEach(type => 
                webSocket.addEventListener(type, event => handleEvent(event, controller))
            );
        },
        cancel() {
            closeWebSocket(webSocket);
        }
    });
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
    const receivedID = stringify(bytes.subarray(1, 17));
    if (receivedID !== userID) return new WebSocketHeader(true); 
    const optLength = bytes[17];
    const commandStartIndex = 18 + optLength;
    const command = bytes[commandStartIndex];
    const isUDP = command === 2;
    const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
    const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
    return new WebSocketHeader(false, address, port, rawDataIndex, bytes.subarray(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
    const addressType = bytes[startIndex];
    const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = addressType === 1
        ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
        : addressType === 2
        ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
        : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  let hasSent = Boolean(resHeader);
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      if (hasSent) {
        const combinedBuffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
        combinedBuffer.set(resHeader);
        combinedBuffer.set(new Uint8Array(chunk), resHeader.byteLength);
        webSocket.send(combinedBuffer);
        hasSent = false;
      } else {
        webSocket.send(chunk);
      }
      hasData = true;
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(webSocket);
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
const closeWebSocket = (webSocket) => {
    if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
        webSocket.close();
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
const handleUdpRequest = async (webSocket, resHeader) => {
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const size = new DataView(chunk.buffer, offset, 2).getUint16(0);
                const data = chunk.subarray(offset + 2, offset + 2 + size);
                offset += 2 + size;
                const dnsResponse = await handleDNSRequest(data);
                const responseSize = dnsResponse.byteLength;
                const header = new Uint8Array([(responseSize >> 8) & 0xff, responseSize & 0xff]);               
                if (webSocket.readyState === WebSocket.OPEN) {
                    webSocket.send(new Uint8Array([...resHeader, ...header, ...new Uint8Array(dnsResponse)]));
                }
            }
            controller.terminate();
        }
    });
    return {
        write: chunk => transformStream.writable.getWriter().write(chunk)
    };
};
const handleDNSRequest = async (query) => {
    const response = await fetch("https://1.1.1.1/dns-query", {
        method: "POST",
        headers: {
            accept: "application/dns-message",
            "content-type": "application/dns-message",
        },
        body: query,
    });
    return response.arrayBuffer();
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
