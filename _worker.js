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
      return new Response(err.toString());
    }
  }
};
const handleHttpRequest = (request, userID) => {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, request.headers.get("Host")), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(webSocket, earlyDataHeader);
  const remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
  const processChunk = async (chunk) => {
    if (isDns && udpStreamWrite) {
      await udpStreamWrite(chunk);
      return;
    }
    if (remoteSocket.value) {
      await writeToRemote(remoteSocket.value, chunk);
      return;
    }
    const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processWebSocketHeader(chunk, userID);
    if (hasError) return;
    const responseHeader = new Uint8Array([Version[0], 0]);
    const rawClientData = chunk.slice(rawDataIndex);
    isDns = isUDP && portRemote === 53;
    isUDP ? udpStreamWrite = await handleUdpRequest(webSocket, responseHeader, rawClientData) : handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP);
  };
  readableStream.pipeTo(new WritableStream({ write: processChunk }));
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
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = await connect({ hostname: address, port });
  }
  await writeToRemote(remoteSocket.value, rawClientData);
  return remoteSocket.value;
};
const createWebSocketStream = (webSocket, earlyDataHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener('message', event => controller.enqueue(event.data));
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', err => controller.error(err));
    },
    cancel: () => closeWebSocket(webSocket)
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
  const addressValue = addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
    : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
  return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: addressValueIndex + addressLength, Version: [0], isUDP };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);
  let hasData = false;
  try {
    const writable = new WritableStream({
      write: async (chunk) => {
        hasData = true;
        const data = responseHeader ? new Uint8Array([...responseHeader, ...chunk]) : chunk;
        webSocket.send(data);
        responseHeader = null;
      }
    });
    await remoteSocket.readable.pipeTo(writable);
  } catch {
    closeWebSocket(webSocket);
  }
  if (!hasData && retry) retry();
};
const base64ToBuffer = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/[-_]/g, m => (m === '-' ? '+' : '/')));
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = webSocke => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocke.readyState)) webSocke.close();
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const udpRequests = [];
  let index = 0;
  while (index < rawClientData.byteLength) {
    const udpPacketLength = new DataView(rawClientData.buffer, index, 2).getUint16(0);
    const packet = rawClientData.slice(index + 2, index + 2 + udpPacketLength);
    udpRequests.push(packet);
    index += 2 + udpPacketLength;
  }
  const dnsResults = await Promise.all(udpRequests.map(packet =>
    fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: packet
    }).then(response => response.arrayBuffer())
  ));
  for (const dnsResult of dnsResults) {
    if (webSocket.readyState === WebSocket.OPEN) {
      const combinedData = new Uint8Array([...responseHeader, (dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff, ...new Uint8Array(dnsResult)]);
      webSocket.send(combinedData);
    }
  }
};
const getConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
