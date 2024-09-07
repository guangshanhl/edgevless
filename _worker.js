import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      return request.headers.get('Upgrade') === 'websocket'
        ? handlewsRequest(request, userID, proxyIP)
        : handlehttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handlehttpRequest = (request, userID) => {
  const path = new URL(request.url).pathname;
  if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, request.headers.get("Host")), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handlewsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(webSocket, earlyDataHeader);
  let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
      if (remoteSocket.value) return await writeToRemote(remoteSocket.value, chunk);
      const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) return;
      const responseHeader = new Uint8Array([Version[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        isDns = portRemote === 53;
        if (isDns) {
          udpStreamWrite = await handleUdpRequest(webSocket, responseHeader, rawClientData);
        }
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
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    await forwardToData(tcpSocket, webSocket, responseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, responseHeader);
    });
  } catch {
    closeWebSocket(webSocket);
  }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (remoteSocket.value && !remoteSocket.value.closed) {
    await writeToRemote(remoteSocket.value, rawClientData);   
  } else {
    remoteSocket.value = await connect({ hostname: address, port });
    await writeToRemote(remoteSocket.value, rawClientData);
  }
  return remoteSocket.value;
};
const createWebSocketStream = (webSocket, earlyDataHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocketEvents(webSocket, controller);
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
};
const webSocketEvents = (webSocket, controller) => {
  const onMessage = event => controller.enqueue(event.data);
  const onClose = () => controller.close();
  const onError = err => controller.error(err);
  webSocket.addEventListener('message', onMessage);
  webSocket.addEventListener('close', onClose);
  webSocket.addEventListener('error', onError);
  controller.closed.then(() => {
    webSocket.removeEventListener('message', onMessage);
    webSocket.removeEventListener('close', onClose);
    webSocket.removeEventListener('error', onError);
  });
};
const processWebSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  if (stringify(new Uint8Array(buffer.slice(1, 17))) !== userID) return { hasError: true }; 
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : addressType === 1 ? 4 : 16;
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  let addressValue;
  switch (addressType) {
    case 1: addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
      break;
    case 2: addressValue = new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
      break;
    case 3: addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
      break;
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    Version: [0],
    isUDP
  };
};
const forwardToData = (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return;
  }
  let hasData = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      hasData = true;
      if (responseHeader) {
        const combined = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
        combined.set(responseHeader);
        combined.set(chunk, responseHeader.byteLength);
        controller.enqueue(combined);
        responseHeader = null;
      } else {
        controller.enqueue(chunk);
      }
    }
  });
  try {
    const reader = remoteSocket.readable.getReader();
    const writer = webSocket.writable.getWriter();
    const stream = new ReadableStream({
      start(controller) {
        reader.read().then(function processText({ done, value }) {
          if (done) {
            controller.close();
            return;
          }
          controller.enqueue(value);
          reader.read().then(processText);
        });
      }
    });
    await stream.pipeThrough(transformStream).pipeTo(writer);
  } catch (error) {
    closeWebSocket(webSocket);
  }
  if (!hasData && retry) {
    await retry();
  }
}
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
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  let index = 0;
  while (index < rawClientData.byteLength) {
    const { dnsResult, length } = await queryDns(rawClientData, index);
    if (webSocket.readyState === WebSocket.OPEN) {
      const combinedData = bufferPool.get(responseHeader.byteLength + dnsResult.byteLength + 4);
      combinedData.set(responseHeader);
      combinedData.set(new Uint8Array([dnsResult.byteLength >> 8, dnsResult.byteLength & 0xff]), responseHeader.byteLength);
      combinedData.set(new Uint8Array(dnsResult), responseHeader.byteLength + 2);
      webSocket.send(combinedData);
    }
    index += 2 + length;
  }
};
const queryDns = async (chunk, index) => {
  const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
  const dnsRequestBuffer = bufferPool.get(udpPacketLength);
  dnsRequestBuffer.set(chunk.slice(index + 2, index + 2 + udpPacketLength));
  const dnsResult = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message' },
    body: dnsRequestBuffer
  }).then(response => response.arrayBuffer());
  return {
    dnsResult,
    length: udpPacketLength
  };
};
const getUserConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
