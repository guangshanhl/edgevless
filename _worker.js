import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';  
    try {
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWsRequest(request, userID, proxyIP)
        : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};
const handleHttpRequest = async (request, userID) => {
  const url = new URL(request.url);
  const responses = {
    '/': new Response(JSON.stringify(request.cf, null, 4)),
    [`/${userID}`]: new Response(getUserConfig(userID, request.headers.get('Host')), { 
      headers: { "Content-Type": "text/plain;charset=utf-8" } 
    }),
  };
  return responses[url.pathname] || new Response('Not found', { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const readableStream = createWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }    
      if (remoteSocket.value) {
        return await writeToRemote(remoteSocket.value, chunk);
      }   
      const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processWebSocketHeader(chunk, userID);    
      if (hasError) return;
      const responseHeader = new Uint8Array([Version[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      isDns = isUDP && portRemote === 53;
      if (isDns) {
        udpStreamWrite = await handleUdpRequest(webSocket, responseHeader, rawClientData);
      } else {
        handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP);
      }
    }
  }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handletcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, ResponseHeader, proxyIP) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    await forwardToData(tcpSocket, webSocket, ResponseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, ResponseHeader);
    });
  } catch {
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
const createWebSocketStream = (webSocket, earlyDataHeader) => new ReadableStream({
  start(controller) {
    const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader); 
    if (error) {
      controller.error(error);
      return;
    }  
    if (earlyData) {
      controller.enqueue(earlyData);
    }
    const handleMessage = event => controller.enqueue(event.data);
    const handleCloseOrError = (err) => {
      if (err) controller.error(err);
      controller.close();
      cleanup();
    };
    const cleanup = () => {
      webSocket.removeEventListener('message', handleMessage);
      webSocket.removeEventListener('close', cleanup);
      webSocket.removeEventListener('error', cleanup);
    };
    webSocket.addEventListener('message', handleMessage);
    webSocket.addEventListener('close', cleanup);
    webSocket.addEventListener('error', handleCloseOrError);
  },
  cancel() {
    closeWebSocket(webSocket);
  }
});
const processWebSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  if (stringify(new Uint8Array(buffer.slice(1, 17))) !== userID) {
    return { hasError: true };
  }
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressInfo = getAddressInfo(view, buffer, 18 + optLength + 3);
  return {
    hasError: false,
    addressRemote: addressInfo.value,
    portRemote,
    rawDataIndex: addressInfo.index,
    Version: [0],
    isUDP,
  };
};
const getAddressInfo = (view, buffer, startIndex) => {
  const addressType = view.getUint8(startIndex);
  let addressLength;
  switch (addressType) {
    case 1:
      addressLength = 4;
      break;
    case 2:
      addressLength = view.getUint8(startIndex + 1);
      break;
    case 3:
      addressLength = 16;
      break;
    default:
      throw new Error('Unknown address type');
  }
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
  const addressValue = addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, addressLength)).join('.')
    : addressType === 2
      ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
      : Array.from(new Uint8Array(buffer, addressValueIndex, addressLength))
          .map(b => b.toString(16).padStart(2, '0'))
          .join(':');
  return { value: addressValue, index: addressValueIndex + addressLength };
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
        const dataToSend = ResponseHeader 
          ? new Uint8Array([...ResponseHeader, ...new Uint8Array(chunk)]).buffer 
          : chunk;        
        webSocket.send(dataToSend);
        ResponseHeader = null;
      }
    }));
  } catch (error) {
    closeWebSocket(webSocket);
  } finally {
    if (!hasData && retry) {
      retry();
    }
  }
};
const base64ToBuffer = base64Str => {
  try {
    base64Str = base64Str.replace(/[-_]/g, match => match === '-' ? '+' : '/');
    const binaryStr = atob(base64Str);
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) buffer[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = webSocket => {
  if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
    webSocket.close();
  }
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
};
const dnsCache = new Map();
const CACHE_EXPIRY = 3600000;
const dnsFetch = async (chunk) => {
  const queryKey = chunk.toString('base64');
  const cachedResponse = dnsCache.get(queryKey); 
  if (cachedResponse && (Date.now() - cachedResponse.timestamp < CACHE_EXPIRY)) {
    return cachedResponse.data;
  }
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: chunk
  });
  const dnsResult = await response.arrayBuffer();
  dnsCache.set(queryKey, { data: dnsResult, timestamp: Date.now() });
  return dnsResult;
};
const handleudpRequest = async (webSocket, ResponseHeader, rawClientData) => {
  const bufferSize = 1024 * 1024;
  const sendBuffer = new Uint8Array(bufferSize);
  let bufferIndex = 0;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      const promises = [];
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const dnsQuery = chunk.slice(index + 2, index + 2 + udpPacketLength);  
        promises.push(
          dnsFetch(dnsQuery).then(dnsResult => {
            const responseWithHeader = new Uint8Array([...ResponseHeader, ...new Uint8Array(dnsResult)]);
            sendBuffer.set(responseWithHeader, bufferIndex);
            bufferIndex += responseWithHeader.byteLength;
            if (bufferIndex >= bufferSize) {
              webSocket.send(sendBuffer.slice(0, bufferIndex));
              bufferIndex = 0;
            }
          })
        );
        index += 2 + udpPacketLength;
      }
      await Promise.all(promises);
    },
    async flush(controller) {
      if (bufferIndex > 0) {
        webSocket.send(sendBuffer.slice(0, bufferIndex));
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
