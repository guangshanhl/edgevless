import { connect } from 'cloudflare:sockets';

const responseHeader = new Uint8Array([0, 0]); // 全局分配响应头
const remoteSockets = new Map(); // 用于存储已连接的服务器

export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP ?? '';
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';

      return isWebSocket 
        ? await handleWsRequest(request, userID, proxyIP)
        : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};

const handleHttpRequest = (request, userID) => {
  const { pathname } = new URL(request.url);
  const host = request.headers.get('Host');

  if (pathname === '/') {
    return new Response(JSON.stringify(request.cf, null, 4));
  }

  if (pathname === `/${userID}`) {
    return new Response(getConfig(userID, host), {
      headers: { 'Content-Type': 'application/json;charset=utf-8' },
    });
  }

  return new Response('Not found', { status: 404 });
};

const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();

  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createSocketStream(webSocket, earlyHeader);

  const processChunk = async (chunk) => {
    try {
      const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processSocketHeader(chunk, userID);

      if (hasError) return;

      responseHeader[0] = Version[0]; // 更新响应头版本
      const rawClientData = chunk.slice(rawDataIndex);

      // 根据 isUDP 动态选择处理逻辑
      if (isUDP) {
        await handleUdpRequest(webSocket, addressRemote, portRemote, rawClientData);
      } else {
        await handleTcpRequest(webSocket, addressRemote, portRemote, rawClientData, proxyIP);
      }
    } catch (error) {
      closeWebSocket(webSocket);
    }
  };

  readableStream.pipeTo(new WritableStream({ write: processChunk }));
  return new Response(null, { status: 101, webSocket: client });
};

const handleTcpRequest = async (webSocket, addressRemote, portRemote, rawClientData, proxyIP) => {
  let remoteSocket = remoteSockets.get(`${addressRemote}:${portRemote}`);

  // 如果没有连接，建立连接
  if (!remoteSocket || remoteSocket.closed) {
    remoteSocket = await connect({ hostname: addressRemote, port: portRemote });
    remoteSockets.set(`${addressRemote}:${portRemote}`, remoteSocket);
  }

  await writeToRemote(remoteSocket, rawClientData);
  await forwardToData(remoteSocket, webSocket);
};

const handleUdpRequest = async (webSocket, addressRemote, portRemote, rawClientData) => {
  let remoteSocket = remoteSockets.get(`${addressRemote}:${portRemote}`);

  // 如果没有连接，建立连接
  if (!remoteSocket || remoteSocket.closed) {
    remoteSocket = await connect({ hostname: addressRemote, port: portRemote });
    remoteSockets.set(`${addressRemote}:${portRemote}`, remoteSocket);
  }

  await writeToRemote(remoteSocket, rawClientData);
  await forwardToData(remoteSocket, webSocket);
};

const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};

const createSocketStream = (webSocket, earlyHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);

      webSocket.addEventListener('message', (event) => controller.enqueue(event.data));
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', (err) => controller.error(err));
    },
    cancel: () => closeWebSocket(webSocket)
  });
};

const processSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);

  if (stringify(new Uint8Array(buffer.slice(1, 17))).toLowerCase() !== userID.toLowerCase()) {
    return { hasError: true };
  }

  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : addressType === 1 ? 4 : 16;
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  const addressValue = extractAddress(buffer, addressType, addressValueIndex, addressLength);

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    Version: [0],
    isUDP,
  };
};

const extractAddress = (buffer, addressType, addressValueIndex, addressLength) => {
  return addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
    : Array.from(new Uint8Array(buffer, addressValueIndex, 16))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(':');
};

const forwardToData = async (remoteSocket, webSocket) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    return closeWebSocket(webSocket);
  }

  const writable = new WritableStream({
    write: async (chunk) => {
      webSocket.send(responseHeader); // 使用全局的 responseHeader
      webSocket.send(chunk);
    }
  });

  try {
    await remoteSocket.readable.pipeTo(writable);
  } catch (error) {
    closeWebSocket(webSocket);
  }
};

const base64ToBuffer = (base64Str) => {
  try {
    const formattedStr = base64Str.replace(/[-_]/g, (m) => (m === '-' ? '+' : '/'));
    const binaryStr = atob(formattedStr);
    const buffer = Uint8Array.from(binaryStr, (char) => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
};

const closeWebSocket = (webSocket) => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(webSocket.readyState)) {
    webSocket.close();
  }
};

const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));

const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments
    .map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-')
    .toLowerCase();
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
