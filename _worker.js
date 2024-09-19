import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const uuid = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxy = env.PROXYIP ?? '';
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWebSocket(request, uuid, proxy)
        : handleHttp(request, uuid);
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};
const handleHttp = (request, uuid) => {
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
const handleWebSocket = async (request, uuid, proxy) => {
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
      handleTcp(remoteSocket, address, port, clientData, server, resHeader, proxy);
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
const handleTcp = async (remoteSocket, address, port, clientData, server, resHeader, proxy) => {
  try {
    const tcpSocket = await connectAndSend(remoteSocket, address, port, clientData);
    await forwardData(tcpSocket, server, resHeader, async () => {
      try {
        const fallbackSocket = await connectAndSend(remoteSocket, proxy || address, port, clientData);
        fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(server));
        await forwardData(fallbackSocket, server, resHeader);
      } catch (err) {
        closeWebSocket(server);
      }
    });
  } catch (err) {
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
const parseWebSocketHeader = (buffer, uuid) => {
  const view = new DataView(buffer);
  const headerUuid = byteToString(new Uint8Array(buffer.slice(1, 17))); 
  if (headerUuid !== uuid) return { error: true }; 
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
  let hasDataBuffer = null;
  let resHeaderLength = resHeader ? resHeader.length : 0;
  let currentBufferSize = 0;  
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      write: async (chunk) => {
        hasData = true;
        const totalLength = resHeaderLength + chunk.byteLength;       
        if (!hasDataBuffer || totalLength > currentBufferSize) {
          currentBufferSize = Math.max(totalLength, currentBufferSize * 2 || chunk.byteLength);
          hasDataBuffer = new Uint8Array(currentBufferSize);
        }       
        if (resHeader) {
          hasDataBuffer.set(resHeader, 0);
          hasDataBuffer.set(chunk, resHeaderLength);
          server.send(hasDataBuffer.subarray(0, totalLength));
          resHeader = null;
        } else {
          server.send(chunk);
        }
      }
    }));
  } catch {
    closeWebSocket(server);
  }
  if (!hasData && retry) retry();
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
const dnsCache = new Map();
const dnsTTL = 86400000;
const handleUdp = async (server, resHeader, clientData) => {
  const parseUdpPackets = (data) => {
    const packets = [];
    let index = 0;
    while (index < data.byteLength) {
      const udpPacketLength = new DataView(data.buffer, index, 2).getUint16(0);
      packets.push({ length: udpPacketLength, data: data.slice(index + 2, index + 2 + udpPacketLength) });
      index += 2 + udpPacketLength;
    }
    return packets;
  };
  const fetchDnsResult = async (packet) => {
    const cacheKey = packet.data.slice(0, 2).toString();
    const cachedEntry = dnsCache.get(cacheKey);
    if (cachedEntry && (Date.now() - cachedEntry.timestamp < dnsTTL)) {
      return cachedEntry.result;
    }
    try {
      const response = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: packet.data
      });
      const result = await response.arrayBuffer();
      dnsCache.set(cacheKey, { result, timestamp: Date.now() });
      return result;
    } catch (error) {
      return null;
    }
  };
  const udpPackets = parseUdpPackets(clientData);
  const dnsResults = await Promise.all(udpPackets.map(fetchDnsResult));
  return async chunk => {
    dnsResults.forEach(res => {
      if (res) {
        server.send(new Uint8Array(res));
      }
    });
  };
};
const getConfig = (uuid, host) => `
vless://${uuid}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
