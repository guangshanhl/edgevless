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
      try {
        if (isDns && udpStreamWrite) {
          await udpStreamWrite(chunk);
        } else if (remoteSocket.value) {
          await writeToRemote(remoteSocket.value, chunk);
        } else {
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
      } catch (error) {
        closeWebSocket(webSocket);
      }
    }
  }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    await forwardToData(tcpSocket, webSocket, responseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, responseHeader);
    });
  } catch (error) {
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
      if (earlyDataHeader) {
        try {
          const earlyData = base64ToBuffer(earlyDataHeader);
          controller.enqueue(earlyData);
        } catch (error) {
          controller.error(error);
          return;
        }
      }
      const onMessage = (event) => controller.enqueue(event.data);
      const onClose = () => controller.close();
      const onError = (error) => controller.error(error);
      webSocket.addEventListener('message', onMessage);
      webSocket.addEventListener('close', onClose);
      webSocket.addEventListener('error', onError);
      const cleanup = () => {
        webSocket.removeEventListener('message', onMessage);
        webSocket.removeEventListener('close', onClose);
        webSocket.removeEventListener('error', onError);
        closeWebSocket(webSocket);
      };
      controller.onabort = cleanup;
    },
    cancel() {
    }
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
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return;
  }
  let hasData = false;
  try {
    const writable = new WritableStream({
      write: async (chunk) => {
    		hasData = true;
        webSocket.send(responseHeader ? new Uint8Array([...responseHeader, ...chunk]) : chunk);
        responseHeader = null;
      }
    });
    await remoteSocket.readable.pipeTo(writable);
  } catch {
    closeWebSocket(webSocket);
  }
  if (!hasData && retry) retry();
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
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const processAndSendChunk = async (chunk, index) => {
    const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
    const dnsResult = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: chunk.slice(index + 2, index + 2 + udpPacketLength)
    }).then(response => response.arrayBuffer());
    if (webSocket.readyState === WebSocket.OPEN) {
      const combinedData = new Uint8Array([...responseHeader, (dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff, ...new Uint8Array(dnsResult)]);
      webSocket.send(combinedData);
    }
    return index + 2 + udpPacketLength;
  };
  let index = 0;
  while (index < rawClientData.byteLength) {
    index = await processAndSendChunk(rawClientData, index);
  }
};
const getUserConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
