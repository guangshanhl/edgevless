import { connect } from 'cloudflare:sockets';

// 模块级预先分配的缓冲区
const preAllocatedBuffer = new Uint8Array(65535); // 64KB 缓冲区
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

export default {
  async fetch(request, env) {
    try {
      const uuid = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxy = env.PROXYIP ?? '';
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWebSocket(request, uuid, proxy)
        : handleHttp(request, uuid);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};

// 处理普通 HTTP 请求
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

// 处理 WebSocket 请求
const handleWebSocket = async (request, uuid, proxy) => {
  const [client, server] = new WebSocketPair();
  server.accept();
  
  // 创建可读流处理 WebSocket 数据
  const readableStream = createSocketStream(server, request.headers.get('sec-websocket-protocol') || '');
  
  let remoteSocket = { socket: null }, udpWriter = null, isDns = false;
  
  const processChunk = async (chunk) => {
    if (isDns && udpWriter) return udpWriter(chunk);
    if (remoteSocket.socket) return await writeToSocket(remoteSocket.socket, chunk);
    
    // 解析 WebSocket 头部
    const { error, address, port, dataOffset, version, isUdp } = parseWebSocketHeader(chunk, uuid);
    if (error) return;
    
    // 使用预分配的缓冲区
    const resHeader = preAllocatedBuffer.subarray(0, 2); // 使用 2 字节的缓冲区
    resHeader.set(version, 0);
    resHeader[1] = 0;

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

// 写入数据到 Socket
const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};

// 处理 TCP 连接和数据转发
const handleTcp = async (remoteSocket, address, port, clientData, server, resHeader, proxy) => {
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

// 建立连接并发送数据
const connectAndSend = async (remoteSocket, address, port, clientData) => {
  if (!remoteSocket.socket || remoteSocket.socket.closed) {
    remoteSocket.socket = await connect({ hostname: address, port });
  }
  await writeToSocket(remoteSocket.socket, clientData);
  return remoteSocket.socket;
};

// 创建 WebSocket 可读流
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
// 转发数据并使用预分配缓冲区
const forwardData = async (remoteSocket, server, resHeader, retry) => {
  if (server.readyState !== WebSocket.OPEN) return closeWebSocket(server);
  let hasData = false;
  
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      write: async (chunk) => {
        hasData = true;
        
        // 复用缓冲区，合并响应头和数据
        const combinedData = preAllocatedBuffer.subarray(0, resHeader.length + chunk.length);
        combinedData.set(resHeader, 0);
        combinedData.set(chunk, resHeader.length);
        
        server.send(combinedData);
        resHeader = null; // 清空头部
      }
    }));
  } catch {
    closeWebSocket(server);
  }
  
  if (retry && !hasData) retry();
};

// 将 base64 转换为缓冲区
const base64ToBuffer = base64Str => {
  try {
    const formattedStr = base64Str.replace(/[-_]/g, m => (m === '-' ? '+' : '/'));
    const buffer = Uint8Array.from(atob(formattedStr), char => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
};

// 关闭 WebSocket
const closeWebSocket = webSocket => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocket.readyState)) webSocket.close();
};

// 处理 UDP 请求
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
    
    // 使用预分配缓冲区
    const dataToSend = preAllocatedBuffer.subarray(0, resHeader.length + response.byteLength);
    dataToSend.set(resHeader, 0);
    dataToSend.set(response, resHeader.length);
    
    server.send(dataToSend);
  });
};

// 生成配置信息
const getConfig = (uuid, host) => `
vless://${uuid}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
