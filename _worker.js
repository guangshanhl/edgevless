import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWs(request, userID, proxyIP)
        : handleHttp(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttp = async (request, userID) => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/':
      return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
    case `/${userID}`:
      return new Response(getConfig(userID, request.headers.get('Host')), {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    default:
      return new Response('Not found', { status: 404 });
  }
};
const handleWs = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const readableStream = createWstream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  let remoteSocket = { value: null };
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (remoteSocket.value) return await writeToRemote(remoteSocket.value, chunk);
      const { hasError, addressRemote, portRemote, rawDataIndex, isVersion, isUDP } = processHeader(chunk, userID);
      if (hasError) return;
      const responseHeader = new Uint8Array([isVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);
      if (isUDP && portRemote === 53) {
       await handleUDP(webSocket, responseHeader, clientData);
      } else {
      handleTCP(remoteSocket, addressRemote, proxyIP, portRemote, clientData, webSocket, responseHeader);
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
const handleTcp = async (remoteSocket, addressRemote, proxyIP, portRemote, clientData, webSocket, responseHeader) => {
  const tryConnect = async (address, port) => {
    const tcpSocket = await connectAndWrite(remoteSocket, address, port, clientData);
    return tcpSocket ? forwardToData(tcpSocket, webSocket, responseHeader) : false;
  };
  if (!(await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote))) {
    closeWebSocket(webSocket);
  }
};
const connectAndWrite = async (remoteSocket, address, port, clientData) => {
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = connect({ hostname: address, port });
  }  
  await writeToRemote(remoteSocket.value, clientData);
  return remoteSocket.value;
};
const createWstream = (webSocket, earlyDataHeader) => {
  let isCancelled = false;
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocket.addEventListener('message', event => !isCancelled && controller.enqueue(event.data));
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', err => controller.error(err));
    },
    cancel() {
      isCancelled = true;
      closeWebSocket(webSocket);
    }
  });
};
const processHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  if (stringify(new Uint8Array(buffer.slice(1, 17))) !== userID) return { hasError: true }; 
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const version = new Uint8Array(buffer.slice(0, 1));
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
    isVersion: version,
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  let hasData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        hasData = true;
        const dataToSend = responseHeader
          ? new Uint8Array([...responseHeader, ...new Uint8Array(chunk)]).buffer
          : chunk;
        webSocket.send(dataToSend);
        responseHeader = null;
      }
    }));
  } catch {
    closeWebSocket(webSocket);
  }
  return hasData;
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
const handleUDP = async (webSocket, responseHeader, clientData) => {
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
          webSocket.send(new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsResult)]).buffer);
        }
        index += 2 + udpPacketLength;
      }
    }
  });
  const writer = transformStream.writable.getWriter();
  await writer.write(clientData);
  writer.close();
};
const getConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
