import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWebSocket(request, userID, proxyIP)
        : handleNonWebSocketRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleNonWebSocketRequest = async (request, userID) => {
  const { pathname, hostname, protocol } = new URL(request.url);
  if (pathname === '/') {
    return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
  } else if (pathname === `/${userID}`) {
    return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return fetch(new Request(new URL(`https://${hostname === '' ? 'cn.bing.com' : hostname}`), request));
};
const handleWebSocket = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const readableStream = createReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
      if (remoteSocket.value) return await writeToRemoteSocket(remoteSocket.value, chunk);
      const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
      if (hasError) return;
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        isDns = portRemote === 53;
        if (isDns) {
          udpStreamWrite = await handleUDPOutbound(webSocket, vlessResponseHeader, rawClientData);
        }
      } else {
        handleTCPOutbound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP);
      }
    }
  })); 
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemoteSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handleTCPOutbound = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, proxyIP) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    forwardDataToWebSocket(tcpSocket, webSocket, vlessResponseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocketSafely(webSocket));
      forwardDataToWebSocket(fallbackSocket, webSocket, vlessResponseHeader);
    });
  } catch (error) {
    closeWebSocketSafely(webSocket);
  }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (remoteSocket.value && !remoteSocket.value.closed) {
    await writeToRemoteSocket(remoteSocket.value, rawClientData);
    return remoteSocket.value;
  } else {
    const tcpSocket = await connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;
    await writeToRemoteSocket(tcpSocket, rawClientData);
    return tcpSocket;
  }
};
const createReadableWebSocketStream = (webSocket, earlyDataHeader) => {
  let isCancelled = false;
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener('message', event => !isCancelled && controller.enqueue(event.data));
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', err => controller.error(err));
    },
    cancel() {
      isCancelled = true;
      closeWebSocketSafely(webSocket);
    }
  });
};
const processVlessHeader = (buffer, userID) => {
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
    vlessVersion: 0,
    isUDP
  };
};
const forwardDataToWebSocket = async (remoteSocket, webSocket, vlessResponseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocketSafely(webSocket);
    return;
  }
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        hasIncomingData = true;
        const dataToSend = vlessResponseHeader
          ? new Uint8Array([...vlessResponseHeader, ...new Uint8Array(chunk)]).buffer
          : chunk;
        webSocket.send(dataToSend);
        vlessResponseHeader = null;
      }
    }));
  } catch {
    closeWebSocketSafely(webSocket);
  }
  if (!hasIncomingData && retry) retry();
};
const base64ToArrayBuffer = base64Str => {
  try {
    if (base64Str.includes('-') || base64Str.includes('_')) base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64Str), len = binaryStr.length, buffer = new Uint8Array(len);
    for (let i = 0; i < len; i++) buffer[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocketSafely = socket => {
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
const handleUDPOutbound = async (webSocket, vlessResponseHeader, rawClientData) => {
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
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(new Uint8Array([...vlessResponseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsResult)]).buffer);
        }
        index += 2 + udpPacketLength;
      }
    }
  });
  const writer = transformStream.writable.getWriter();
  await writer.write(rawClientData);
  writer.close();
};
const getVLESSConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
