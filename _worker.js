import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP ?? '';
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
  const host = request.headers.get("Host");
  if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, host), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createSocketStream(webSocket, earlyHeader);
  let remoteSocket = { value: null }, udpWrite = null, isDns = false, address = '';
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpWrite) return udpWrite(chunk);
      if (remoteSocket.value) return await writeToRemote(remoteSocket.value, chunk);
      const { hasError, addressRemote = '', portRemote = 443, rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processSocketHeader(chunk, userID);
      address = addressRemote;
      if (hasError) return;
      const responseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        isDns = portRemote === 53;
        if (isDns) udpWrite = handleUdpRequest(webSocket, responseHeader, rawClientData);
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
  const connectAndWrite = async (address, port) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
      remoteSocket.value = await connect({ hostname: address, port });
    }
    return remoteSocket.value;
  };
  try {
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    await writeToRemote(tcpSocket, rawClientData);
    await forwardToData(tcpSocket, webSocket, responseHeader, async () => {
      const fallbackSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
      await writeToRemote(fallbackSocket, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, responseHeader);
    });
  } catch (error) {
    closeWebSocket(webSocket);
  }
};
let reuseStream;
const createSocketStream = (webSocket, earlyHeader) => {
  if (reuseStream) {
    reuseStream.cancel();
    reuseStream = null;
  }
  const { earlyData, error } = base64ToBuffer(earlyHeader);
  if (error) return new ReadableStream().cancel();
  reuseStream = new ReadableStream({
    start(controller) {
      if (earlyData) controller.enqueue(earlyData);
      addWebSocketListeners(webSocket, controller);
    },
    cancel: () => closeWebSocket(webSocket)
  });
  return reuseStream;
};
const addWebSocketListeners = (webSocket, controller) => {
  webSocket.addEventListener('message', event => controller.enqueue(event.data));
  webSocket.addEventListener('close', () => controller.close());
  webSocket.addEventListener('error', err => controller.error(err));
};
const processSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  const version = new Uint8Array(buffer.slice(0, 1));
  const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
  if (receivedID !== userID) return { hasError: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  let addressValue;
  switch (addressType) {
    case 1:
      addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
      break;
    case 2:
      const addressLength = view.getUint8(addressIndex + 1);
      addressValue = new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
      break;
    case 3:
      addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 16))
        .map(b => b.toString(16).padStart(2, '0')).join(':');
      break;
    default:
      return { hasError: true };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + (addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16)),
    vlessVersion: version,
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);
  let hasData = false;
  const combinedHeader = responseHeader ? new Uint8Array(responseHeader) : null;
  const writable = new WritableStream({
    write: async (chunk) => {
      hasData = true;
      let dataToSend = chunk;
      if (combinedHeader) {
        const combinedData = new Uint8Array(combinedHeader.length + chunk.length);
        combinedData.set(combinedHeader);
        combinedData.set(chunk, combinedHeader.length);
        dataToSend = combinedData;
      }
      webSocket.send(dataToSend);
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writable);
  } catch (error) {
    closeWebSocket(webSocket);
  }
  if (retry && !hasData) retry();
};
const base64ToBuffer = (base64Str) => {
  try {
    const formattedStr = base64Str.replace(/[-_]/g, m => (m === '-' ? '+' : '/'));
    const buffer = Buffer.from(formattedStr, 'base64');
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
};
const closeWebSocket = (webSocket) => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocket.readyState)) webSocket.close();
};
const stringify = (arr, offset = 0) => {
  const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
  const segments = [4, 2, 2, 2, 6];
  return segments.reduce((acc, len) => {
    const segment = Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('');
    return acc ? `${acc}-${segment}` : segment;
  }, '').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const dataView = new DataView(rawClientData.buffer);
  const dnsQueryBatches = [];
  let index = 0;
  while (index < rawClientData.byteLength) {
    const udpPacketLength = dataView.getUint16(index);
    const dnsQuery = rawClientData.slice(index + 2, index + 2 + udpPacketLength);
    dnsQueryBatches.push(dnsQuery);
    index += 2 + udpPacketLength;
  }
  const fetchDnsQuery = async (dnsQuery) => {
    try {
      const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsQuery
      });
      return response.arrayBuffer();
    } catch {
      return null;
    }
  };
  const dnsResponses = await Promise.allSettled(dnsQueryBatches.map(fetchDnsQuery));
  dnsResponses.forEach(result => {
    if (result.status === 'fulfilled' && result.value && webSocket.readyState === WebSocket.OPEN) {
      const dnsResult = result.value;
      const combinedData = new Uint8Array(responseHeader.length + 2 + dnsResult.byteLength);
      combinedData.set(responseHeader, 0);
      combinedData.set([dnsResult.byteLength >> 8, dnsResult.byteLength & 0xff], responseHeader.length);
      combinedData.set(new Uint8Array(dnsResult), responseHeader.length + 2);
      webSocket.send(combinedData);
    }
  });
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
