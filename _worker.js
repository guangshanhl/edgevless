import { connect } from 'cloudflare:sockets';
const userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const proxyIP = '';
export default {
  async fetch(request, env) {
    try {
      const { UUID = userID, PROXYIP = proxyIP } = env;
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWebSocketRequest(request, UUID, PROXYIP)
        : handleHttpRequest(request, UUID);
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};
const handleHttpRequest = (request, userID) => {
  const { pathname } = new URL(request.url);
  const host = request.headers.get("Host"); 
  if (pathname === "/") return new Response(JSON.stringify(request.cf, null, 4));
  if (pathname === `/${userID}`) {
    return new Response(getConfig(userID, host), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleWebSocketRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(webSocket, earlyDataHeader);
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  const processChunk = async (chunk) => {
    if (isDns && udpStreamWrite) {
      return udpStreamWrite(chunk);
    }
    if (remoteSocket.value) {
      return writeToRemote(remoteSocket.value, chunk);
    }
    const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processWebSocketHeader(chunk, userID);
    if (hasError) return;
    const responseHeader = new Uint8Array([Version[0], 0]);
    const rawClientData = chunk.slice(rawDataIndex);
    if (isUDP) {
      isDns = portRemote === 53;
      udpStreamWrite = isDns ? await handleUdpRequest(webSocket, responseHeader, rawClientData) : null;
    } else {
      handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP);
    }
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
  } catch (err) {
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
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      const onMessage = (event) => controller.enqueue(event.data);
      const onClose = () => controller.close();
      const onError = (err) => controller.error(err);
      webSocket.addEventListener('message', onMessage);
      webSocket.addEventListener('close', onClose);
      webSocket.addEventListener('error', onError);
      this.cleanup = () => {
        webSocket.removeEventListener('message', onMessage);
        webSocket.removeEventListener('close', onClose);
        webSocket.removeEventListener('error', onError);
      };
    },
    cancel() {
      if (this.cleanup) this.cleanup();
      closeWebSocket(webSocket);
    }
  });
};
const processWebSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  const userIDMatch = stringify(new Uint8Array(buffer.slice(1, 17))) === userID;
  if (!userIDMatch) return { hasError: true };
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
  if (!isWebSocketOpen(webSocket)) return closeWebSocket(webSocket);
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
  if (retry && !hasData) retry();
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
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const udpPackets = [];
  for (let index = 0; index < rawClientData.byteLength; ) {
    const udpPacketLength = new DataView(rawClientData.buffer, index, 2).getUint16(0);
    udpPackets.push({ length: udpPacketLength, data: rawClientData.slice(index + 2, index + 2 + udpPacketLength) });
    index += 2 + udpPacketLength;
  }
  const dnsResults = await Promise.all(udpPackets.map(packet =>
    fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: packet.data
    }).then(response => response.arrayBuffer())
  ));
  if (!isWebSocketOpen(webSocket)) return;
  dnsResults.forEach((dnsResult, i) => {
    const response = new Uint8Array(dnsResult);
    const packetLength = response.byteLength;
    webSocket.send(new Uint8Array([...responseHeader, packetLength, ...response]));
  });
};
const isWebSocketOpen = (webSocket) => webSocket.readyState === WebSocket.OPEN;
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
