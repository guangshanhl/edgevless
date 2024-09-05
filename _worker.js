import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      return isWebSocket
        ? handlewsRequest(request, userID, proxyIP)
        : handlehttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handlehttpRequest = async (request, userID) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/') {
    return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
  } else if (pathname === `/${userID}`) {
    return new Response(getUserConfig(userID, request.headers.get('Host')), {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  } else {
    return new Response('Not found', { status: 404 });
  }
};
const handlewsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const readableStream = createWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        udpStreamWrite(chunk);
        return;
      }
      if (remoteSocket.value) {
        await writeToRemote(remoteSocket.value, chunk);
        return;
      }
      const { hasError, addressRemote = '', portRemote = 443, rawDataIndex, Version = new Uint8Array([0, 0]), isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) return;
      const ResponseHeader = new Uint8Array([Version[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        isDns = portRemote === 53;
        if (isDns) {
          udpStreamWrite = await handleUdpRequest(webSocket, ResponseHeader, rawClientData);
        }
      } else {
        handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, ResponseHeader, proxyIP);
      }
    },
    close() {
      closeWebSocket(webSocket);
    },
    abort(err) {
      closeWebSocket(webSocket);
    }
  }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, ResponseHeader, proxyIP) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    await forwardToData(tcpSocket, webSocket, ResponseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, ResponseHeader);
    });
  } catch (error) {
    closeWebSocket(webSocket);
  }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (remoteSocket.value && !remoteSocket.value.closed) {
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
  } else {
    const tcpSocket = await connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;
    await writeToRemote(tcpSocket, rawClientData);
    return tcpSocket;
  }
};
const createWebSocketStream = (webSocket, earlyDataHeader) => {
  return new ReadableStream({
    start(controller) {
      const result = base64ToBuffer(earlyDataHeader);
      if (result.error) return controller.error(result.error);
      if (result.earlyData) controller.enqueue(result.earlyData);
      const handleMessage = event => controller.enqueue(event.data);
      const handleClose = () => controller.close();
      const handleError = err => controller.error(err);
      webSocket.addEventListener('message', handleMessage);
      webSocket.addEventListener('close', handleClose);
      webSocket.addEventListener('error', handleError);
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
};
const processWebSocketHeader = (buffer, userID) => {
  const version = new Uint8Array(Buffer.slice(0, 1));
  const view = new DataView(buffer);
  const userIDArray = new Uint8Array(buffer.slice(1, 17));
  if (stringify(userIDArray) !== userID) return { hasError: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : addressType === 1 ? 4 : 16;
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  let addressValue;
  const addressArray = new Uint8Array(buffer, addressValueIndex, addressLength);
  switch (addressType) {
    case 1:
      addressValue = Array.from(addressArray).join('.');
      break;
    case 2:
      addressValue = new TextDecoder().decode(addressArray);
      break;
    case 3:
      addressValue = Array.from(addressArray).map(b => b.toString(16).padStart(2, '0')).join(':');
      break;
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    Version: version,,
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, ResponseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return;
  }
  let hasData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        hasData = true;
        let dataToSend;
        if (ResponseHeader) {
          const combinedLength = ResponseHeader.length + chunk.byteLength;
          dataToSend = new Uint8Array(combinedLength);
          dataToSend.set(ResponseHeader, 0);
          dataToSend.set(new Uint8Array(chunk), ResponseHeader.length);
          ResponseHeader = null;
        } else {
          dataToSend = new Uint8Array(chunk);
        }
        webSocket.send(dataToSend.buffer);
      }
    }));
  } catch (error) {
    closeWebSocket(webSocket);
  }
  if (!hasData && retry) {
    retry();
  }
};
const base64ToBuffer = base64Str => {
  try {
    if (base64Str.includes('-') || base64Str.includes('_')) base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64Str), len = binaryStr.length, buffer = new Uint8Array(len);
    for (let i = 0; i < len; i++) buffer[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = socket => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    socket.close();
  }
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, ResponseHeader, rawClientData) => {
  const dnsCache = new Map();
  const dnsFetch = async (chunk) => {
    const cacheKey = chunk.toString('base64');
    if (dnsCache.has(cacheKey)) {
      return dnsCache.get(cacheKey);
    }
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: chunk
    });
    const result = await response.arrayBuffer();
    dnsCache.set(cacheKey, result);
    return result;
  };
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      const chunkBuffer = new Uint8Array(chunk);
      while (index < chunkBuffer.byteLength) {
        const udpPacketLength = (chunkBuffer[index] << 8) | chunkBuffer[index + 1];
        const dnsResult = await dnsFetch(chunkBuffer.slice(index + 2, index + 2 + udpPacketLength));
        const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
        if (webSocket.readyState === WebSocket.OPEN) {
          const responseBuffer = new Uint8Array(ResponseHeader.length + udpSizeBuffer.length + dnsResult.byteLength);
          responseBuffer.set(ResponseHeader, 0);
          responseBuffer.set(udpSizeBuffer, ResponseHeader.length);
          responseBuffer.set(new Uint8Array(dnsResult), ResponseHeader.length + udpSizeBuffer.length);
          webSocket.send(responseBuffer.buffer);
        }
        index += 2 + udpPacketLength;
      }
    }
  });
  const writer = transformStream.writable.getWriter();
  await writer.write(rawClientData);
  writer.close();
};
const getUserConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
