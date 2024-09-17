import { connect } from 'cloudflare:sockets';
let uuid = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxy = '';
export default {
  async fetch(request, env) {
    try {
      uuid = env.UUID || uuid;
			proxy = env.PROXYIP || proxy;
      return request.headers.get('Upgrade') === 'websocket'
        ? handleSocket(request)
        : handleHttp(request);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttp = (request) => {
  const { pathname } = new URL(request.url);
  const host = request.headers.get("Host");
  if (pathname === "/") {
    return new Response(JSON.stringify(request.cf, null, 4));
  }
  if (pathname === `/${uuid}`) {
    return new Response(getConfig(uuid, host), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleSocket = async (request) => {
  const [client, server] = new WebSocketPair();
  server.accept();
  const swpHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createSocketStream(server, swpHeader);
  let remoteSocket = { socket: null }, udpWriter = null, isDns = false;
  const processChunk = async (chunk) => {
    if (isDns && udpWriter) return udpWriter(chunk);
    if (remoteSocket.socket) return await writeToSocket(remoteSocket.socket, chunk);
    const { error, address, port, dataOffset, version, isUdp } = parseWebSocketHeader(chunk, uuid);
    if (error) return;
    const resHeader = new Uint8Array([version[0], 0]);
    const clientData = chunk.slice(dataOffset);
    if (isUdp) {
      isDns = port === 53;
      udpWriter = isDns ? await handleUdp(server, resHeader, clientData) : null;
    } else {
      handleTcp(remoteSocket, address, port, clientData, server, resHeader);
    }
  };
  readableStream.pipeTo(new WritableStream({ write: processChunk }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handleTcp = async (remoteSocket, address, port, clientData, server, resHeader) => {
  try {
    const tcpSocket = await connectAndSend(remoteSocket, address, port, clientData);
    await forwardData(tcpSocket, server, resHeader, async () => {
      const fallSocket = await connectAndSend(remoteSocket, proxy || address, port, clientData);
      fallSocket.closed.catch(() => {}).finally(() => closeWebSocket(server));
      await forwardData(fallSocket, server, resHeader);
    });
  } catch {
    closeWebSocket(server);
  }
};
const connectAndSend = async (remoteSocket, address, port, clientData) => {
  if (!remoteSocket.socket || remoteSocket.socket.closed) {
    remoteSocket.socket = await connect({ hostname: address, port });
  }
  await writeToSocket(remoteSocket.socket, clientData);
  return remoteSocket.socket;
};
const createSocketStream = (webSocket, swpHeader) => new ReadableStream({
  start(controller) {
    const { earlyData, error } = base64ToBuffer(swpHeader);
    if (error) return controller.error(error);
    if (earlyData) controller.enqueue(earlyData);
    webSocket.addEventListener('message', event => controller.enqueue(event.data));
    webSocket.addEventListener('close', () => controller.close());
    webSocket.addEventListener('error', err => controller.error(err));
  },
  cancel: () => closeWebSocket(webSocket)
});
const parseWebSocketHeader = (buffer) => {
  const view = new DataView(buffer);
  const isUuid = byteToString(new Uint8Array(buffer.slice(1, 17))); return isUuid !== uuid ? { error: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUdp = command === 2;
  const port = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  const address = addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
    : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
  return {
    error: false,
    address,
    port,
    dataOffset: addressValueIndex + addressLength,
    version: [0],
    isUdp
  };
};
const forwardData = async (remoteSocket, server, resHeader, retry) => {
  if (server.readyState !== WebSocket.OPEN) return closeWebSocket(server);
  let hasData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      write: async (chunk) => {
        hasData = true;
        server.send(resHeader ? new Uint8Array([...resHeader, ...chunk]) : chunk);
        resHeader = null;
      }
    }));
  } catch {
    closeWebSocket(server);
  }
  if (retry && !hasData) retry();
};
const base64ToBuffer = base64Str => {
  try {
    const formattedStr = base64Str.replace(/[-_]/g, m => (m === '-' ? '+' : '/'));
    const buffer = Uint8Array.from(atob(formattedStr), char => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
};
const closeWebSocket = webSocket => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocket.readyState)) webSocket.close();
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const byteToString = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-').toLowerCase();
};
const handleUdp = async (server, resHeader, clientData) => {
  const udpPackets = [];
  for (let index = 0; index < clientData.byteLength;) {
    const udpPacketLength = new DataView(clientData.buffer, index, 2).getUint16(0);
    udpPackets.push({ length: udpPacketLength, data: clientData.slice(index + 2, index + 2 + udpPacketLength) });
    index += 2 + udpPacketLength;
  }
  const dnsResults = await Promise.all(udpPackets.map(packet =>
    fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: packet.data
    }).then(response => response.arrayBuffer())
  ));
  if (server.readyState !== WebSocket.OPEN) return;
  dnsResults.forEach(result => {
    const response = new Uint8Array(result);
    const dataToSend = new Uint8Array([...resHeader, response.byteLength, ...response]);
    server.send(dataToSend);
  });
};
const getConfig = (uuid, host) => `
vless://${uuid}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
