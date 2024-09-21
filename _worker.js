import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    return request.headers.get('Upgrade') === 'websocket'
      ? handleWsRequest(request, userID, proxyIP)
      : handleHttpRequest(request, userID);
  }
};
const handleHttpRequest = (request, userID) => {
  const path = new URL(request.url).pathname;
  if (path === '/') return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, request.headers.get('Host')), {
      headers: { 'Content-Type': 'application/json;charset=utf-8' }
    });
  }
  return new Response('Not found', { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createSocketStream(webSocket, earlyHeader); 
  let remoteSocket = { value: null };
  const responseHeader = new Uint8Array([0, 0]);
  const processChunk = async (chunk) => {
    if (remoteSocket.isDns) return remoteSocket.udpWrite(chunk);
    if (!remoteSocket.value) {
      const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processSocketHeader(chunk, userID);
      if (hasError) return;
      responseHeader[0] = Version[0];
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        remoteSocket.isDns = (portRemote === 53);
        remoteSocket.udpWrite = remoteSocket.isDns ? await handleUdpRequest(webSocket, responseHeader, rawClientData) : null;
      } else {
        await handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP);
      }
    } else {
      await writeToRemote(remoteSocket.value, chunk);
    }
  };
  readableStream.pipeTo(new WritableStream({ write: processChunk }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  if (!socket.writer) socket.writer = socket.writable.getWriter();
  try {
    await socket.writer.write(chunk);
  } catch (error) {
    socket.writer.releaseLock();
    socket.writer = null;
  }
};
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP) => {
  let retries = 0;
  const maxRetries = 3;
  while (retries < maxRetries) {
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
      await forwardToData(tcpSocket, webSocket, responseHeader, () => {
        retries++;
        connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      });
      break;
    } catch (error) {
      retries++;
      closeWebSocket(webSocket);
    }
  }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = await connect({ hostname: address, port });
  }
  await writeToRemote(remoteSocket.value, rawClientData);
  return remoteSocket.value;
};
const createSocketStream = (webSocket, earlyHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener('message', event => controller.enqueue(event.data));
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', err => controller.error(err));
    },
    cancel: () => closeWebSocket(webSocket)
  });
};
const processSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  if (stringify(new Uint8Array(buffer.slice(1, 17))).toLowerCase() !== userID.toLowerCase()) return { hasError: true };  
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressType = view.getUint8(18 + optLength + 3);
  const addressValueIndex = 18 + optLength + 3 + (addressType === 2 ? 2 : 1);
  const addressLength = addressType === 1 ? 4 : (addressType === 2 ? view.getUint8(18 + optLength + 4) : 16);
  const addressValue = getAddressValue(buffer, addressType, addressValueIndex, addressLength);
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    Version: [0],
    isUDP
  };
};
const getAddressValue = (buffer, addressType, addressValueIndex, addressLength) => {
  const view = new DataView(buffer);
  if (addressType === 1) {
    return Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
  } else if (addressType === 2) {
    return new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
  } else {
    return Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
  }
};
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);  
  let hasData = false;
  const writable = new WritableStream({
    write: async (chunk) => {
      hasData = true;
      webSocket.send(responseHeader);
      webSocket.send(chunk);
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writable);
  } catch {
    closeWebSocket(webSocket);
  }
  if (!hasData) retry();
};
const base64ToBuffer = (base64Str) => {
  try {
    const formattedStr = base64Str.replace(/[-_]/g, m => (m === '-' ? '+' : '/'));
    const binaryStr = atob(formattedStr);
    return { earlyData: Uint8Array.from(binaryStr, char => char.charCodeAt(0)).buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
};
const closeWebSocket = (webSocket) => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocket.readyState)) webSocket.close();
};
const byteToHex = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const dnsQueryBatches = [];
  const dataView = new DataView(rawClientData.buffer);
  let index = 0;
  while (index < rawClientData.byteLength) {
    const udpPacketLength = dataView.getUint16(index);
    dnsQueryBatches.push(rawClientData.slice(index + 2, index + 2 + udpPacketLength));
    index += 2 + udpPacketLength;
  }
  const dnsResponses = await Promise.all(
    dnsQueryBatches.map(dnsQuery =>
      fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsQuery
      }).then(response => response.arrayBuffer()).catch(() => new Uint8Array(0).buffer)
    )
  );
  return (udpResponse) => {
    const responseData = dnsResponses[udpResponse];
    if (responseData.byteLength) {
      webSocket.send(new Uint8Array(responseData));
    }
  };
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
