import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = (env && env.UUID) ? env.UUID : 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = (env && env.PROXYIP) ? env.PROXYIP : '';
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
  const processChunk = async (chunk) => {
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
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote);
    await writeToRemote(tcpSocket, rawClientData);
    await forwardToData(tcpSocket, webSocket, responseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote);
      await writeToRemote(fallbackSocket, rawClientData);
      fallbackSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, responseHeader);
    });
  } catch (error) {
    closeWebSocket(webSocket);
  }
};
const connectAndWrite = async (remoteSocket, address, port) => {
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = await connect({ hostname: address, port });
  }
  return remoteSocket.value;
};
const createSocketStream = (webSocket, earlyHeader) => {
  let reuseStream = null;
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
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1); 
  const addressValue = addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
    : (addressType === 2
      ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
      : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':'));  
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);  
  let hasData = false;
  let combinedHeader = responseHeader ? new Uint8Array(responseHeader) : null;  
  const writable = new WritableStream({
    write: async (chunk) => {
      hasData = true;
      if (combinedHeader) {
        const combinedData = new Uint8Array(combinedHeader.length + chunk.length);
        combinedData.set(combinedHeader);
        combinedData.set(chunk, combinedHeader.length);
        webSocket.send(combinedData);
        combinedHeader = null;
      } else {
        webSocket.send(chunk);
      }
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
    const binaryStr = atob(formattedStr);
    const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
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
  const dataView = new DataView(rawClientData.buffer);
  const dnsQueryBatches = [];
  for (let index = 0; index < rawClientData.byteLength;) {
    const udpPacketLength = dataView.getUint16(index);
    const dnsQuery = rawClientData.slice(index + 2, index + 2 + udpPacketLength);
    dnsQueryBatches.push(dnsQuery);
    index += 2 + udpPacketLength;
  }
  const dnsResponses = await Promise.all(
    dnsQueryBatches.map(dnsQuery =>
      fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/dns-message' },
        body: dnsQuery
      }).then(response => response.arrayBuffer())
      .catch(() => null)
    )
  );
  return (chunk) => {
    if (dnsResponses.every(response => response === null)) {
      closeWebSocket(webSocket);
      return;
    }
    dnsResponses.forEach((response, idx) => {
      if (response) {
        const combinedData = new Uint8Array(responseHeader.length + response.byteLength);
        combinedData.set(responseHeader);
        combinedData.set(new Uint8Array(response), responseHeader.length);
        webSocket.send(combinedData);
      }
    });
  };
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
