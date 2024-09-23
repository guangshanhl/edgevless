import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
  async fetch(request, env) {
    try {
      userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWsRequest(request)
        : handleHttpRequest(request);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttpRequest = (request) => {
  const path = new URL(request.url).pathname;
  const host = request.headers.get('Host');
  if (path === '/') return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, host), {
      headers: { 'Content-Type': 'application/json;charset=utf-8' }
    });
  }
  return new Response('Not found', { status: 404 });
};
const handleWsRequest = async (request) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createSocketStream(webSocket, earlyHeader);
  let remoteSocket = { value: null, isDns: false, udpWrite: null };
  const responseHeader = new Uint8Array([0, 0]);
  const processChunk = async (chunk) => {
    try {
      if (remoteSocket.isDns) {
        return remoteSocket.udpWrite(chunk);
      }
      if (remoteSocket.value) {
        return await writeToRemote(remoteSocket.value, chunk);
      }
      const { hasError, addressRemote, portRemote, rawDataIndex, Version, isUDP } = processSocketHeader(chunk, userID);
      if (hasError) return;
      responseHeader[0] = Version[0];
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        remoteSocket.isDns = (portRemote === 53);
        remoteSocket.udpWrite = remoteSocket.isDns ? await handleUdpRequest(webSocket, responseHeader, rawClientData) : null;
      } else {
        handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader);
      }
    } catch (error) {
      closeWebSocket(webSocket);
    }
  };
  readableStream.pipeTo(new WritableStream({ write: processChunk }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) => {
  try {
    const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
    await forwardToData(tcpSocket, webSocket, responseHeader, async () => {
      const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP || addressRemote, portRemote, rawClientData);
      fallbackSocket.closed.finally(() => closeWebSocket(webSocket));
      await forwardToData(fallbackSocket, webSocket, responseHeader);
    });
  } catch (error) {
    closeWebSocket(webSocket);
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
      const onMessage = event => controller.enqueue(event.data);
      const onClose = () => {
        controller.close();
        webSocket.removeEventListener('message', onMessage);
        webSocket.removeEventListener('error', onError);
      };
      const onError = err => controller.error(err);
      webSocket.addEventListener('message', onMessage);
      webSocket.addEventListener('close', onClose);
      webSocket.addEventListener('error', onError);
    },
    cancel: () => closeWebSocket(webSocket)
  });
};
const processSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  const userIDArray = new Uint8Array(buffer.slice(1, 17));
  if (stringify(new Uint8Array(buffer.slice(1, 17))).toLowerCase() !== userID.toLowerCase()) return { hasError: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : addressType === 1 ? 4 : 16;
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
    Version: [0],
    isUDP
  };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader, retry) => {
  if (webSocket.readyState !== WebSocket.OPEN) return closeWebSocket(webSocket);
  let hasData = false;
  const messageQueue = [];
  let sending = false;
  const sendBatch = async () => {
    if (sending || messageQueue.length === 0) return;
    sending = true;
    const batch = messageQueue.splice(0, messageQueue.length);
    if (responseHeader) {
      webSocket.send(responseHeader);
      responseHeader = null;
    }
    batch.forEach(chunk => webSocket.send(chunk));
    sending = false;
  };
  const writable = new WritableStream({
    write: async (chunk) => {
      hasData = true;
      messageQueue.push(chunk);
      if (!sending) sendBatch();
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
  let index = 0;
  while (index < rawClientData.byteLength) {
    const udpPacketLength = dataView.getUint16(index);
    dnsQueryBatches.push(rawClientData.slice(index + 2, index + 2 + udpPacketLength));
    index += 2 + udpPacketLength;
  }
  try {
    const dnsResponses = await Promise.all(
      dnsQueryBatches.map(dnsQuery =>
        fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/dns-message',
          },
          body: dnsQuery
        }).then(response => response.arrayBuffer())
      )
    );
    return (udpResponse) => {
      const responseData = dnsResponses[udpResponse];
      if (responseData.byteLength) {
        webSocket.send(new Uint8Array(responseData));
      }
    };
  } catch (error) {
    return () => {};
  }
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
