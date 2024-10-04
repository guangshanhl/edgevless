import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      return isWebSocket 
        ? handlewsRequest(request, userID, proxyIP) 
        : handlehttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handlehttpRequest = (request, userID) => {
  const path = new URL(request.url).pathname;
  switch (path) {
    case "/":
      return new Response(JSON.stringify(request.cf, null, 4));
    case `/${userID}`:
      return new Response(getConfig(userID, request.headers.get("Host")), {
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    default:
      return new Response("Not found", { status: 404 });
  }
};
const handlewsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(webSocket, earlyDataHeader);
  let remoteSocket = { value: null }, udpStreamWrite = null, isDns = false;
  const processChunk = async (chunk) => {
    if (isDns && udpStreamWrite) {
      return udpStreamWrite(chunk);
    }
    if (remoteSocket.value) {
      return writeToRemote(remoteSocket.value, chunk);
    }
    const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processWebSocketHeader(chunk, userID); 
    if (hasError) return;
    const responseHeader = new Uint8Array([vlessVersion[0], 0]);
    const rawClientData = chunk.slice(rawDataIndex);
    if (isUDP) {
      isDns = (portRemote === 53);
      if (isDns) {
        udpStreamWrite = await handleUdpRequest(webSocket, responseHeader, rawClientData);
      }
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
    let mainSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    let dataForward = await forwardToData(mainSocket, webSocket, responseHeader);  
    if (!dataForward) {
      mainSocket = await connectAndWrite(remoteSocket, proxyIP, portRemote, rawClientData);
      await forwardToData(mainSocket, webSocket, responseHeader);
    }
  } catch (error) {
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
      if (error) {
        controller.error(error);
        return;
      }
      if (earlyData) controller.enqueue(earlyData);
      const onMessage = event => controller.enqueue(event.data);
      const onClose = () => controller.close();
      const onError = err => controller.error(err);
      webSocket.addEventListener('message', onMessage);
      webSocket.addEventListener('close', onClose);
      webSocket.addEventListener('error', onError);
      this._cleanup = () => {
        webSocket.removeEventListener('message', onMessage);
        webSocket.removeEventListener('close', onClose);
        webSocket.removeEventListener('error', onError);
      };
    },
    cancel() {
      this._cleanup();
      closeWebSocket(webSocket);
    }
  });
};
const processWebSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  if (stringify(new Uint8Array(buffer.slice(1, 17))) !== userID) return { hasError: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const version = new Uint8Array(buffer.slice(0, 1));
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : (addressType === 1 ? 4 : 16);
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);
  let addressValue;
  if (addressType === 1) {
    addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.');
  } else if (addressType === 2) {
    addressValue = new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength));
  } else {
    addressValue = Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);
  try {
    const writable = new WritableStream({
      write: async (chunk) => {
        if (responseHeader) {
          const data = new Uint8Array(responseHeader.length + chunk.length);
          data.set(responseHeader);
          data.set(chunk, responseHeader.length);
          webSocket.send(data);
          responseHeader = null;
        } else {
          webSocket.send(chunk);
        }
      }
    });
    await remoteSocket.readable.pipeTo(writable);
  } catch {
    closeWebSocket(webSocket);
  }
};
const base64ToBuffer = base64Str => {
  try {
    const formattedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(formattedStr);
    const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = socket => {
  if ([WebSocket.OPEN, WebSocket.CLOSING].includes(socket.readyState)) socket.close();
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join(''))
    .join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const processAndSendChunk = async (chunk, index) => {
    const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
    const dnsResponse = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/dns-message' },
      body: chunk.slice(index + 2, index + 2 + udpPacketLength)
    }).then(response => response.arrayBuffer()); 
    if (webSocket.readyState === WebSocket.OPEN) {
      const responseLength = dnsResponse.byteLength;
      const combinedData = new Uint8Array(responseHeader.length + 2 + responseLength); 
      combinedData.set(responseHeader, 0);
      combinedData.set(new Uint8Array([responseLength >> 8, responseLength & 0xff]), responseHeader.length);
      combinedData.set(new Uint8Array(dnsResponse), responseHeader.length + 2);  
      webSocket.send(combinedData);
    } 
    return index + 2 + udpPacketLength;
  };
  let index = 0;
  while (index < rawClientData.byteLength) {
    index = await processAndSendChunk(rawClientData, index);
  }
};
const getConfig = (userID, hostName) => `
vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
