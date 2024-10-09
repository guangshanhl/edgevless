import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWsRequest(request, userID, proxyIP)
        : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttpRequest = (request, userID) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/") return new Response(JSON.stringify(request.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, request.headers.get("Host")), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const readableStream = createWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  readableStream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        await udpStreamWrite(chunk);
        return;
      }
      if (remoteSocket.value) {
        await writeToRemote(remoteSocket.value, chunk);
        return;
      }
      const { hasError, addressRemote, portRemote, rawDataIndex, vlessVersion, isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) return;
      const responseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      isDns = isUDP && portRemote === 53;
      if (isDns) {
        udpStreamWrite = await handleUdpRequest(webSocket, responseHeader, rawClientData);
      } else {
        handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP);
      }
    }
  }));
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
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  let socket = remoteSocket.value;
  if (!socket || socket.closed) {
    socket = await connect({ hostname: address, port });
    remoteSocket.value = socket;
  }
  await writeToRemote(socket, rawClientData);
  return socket;
};
const handleTcpRequest = async (remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader, proxyIP) => {
  const connectAndForward = async (address) => {
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, address, portRemote, rawClientData);
      await forwardToData(tcpSocket, webSocket, responseHeader);
    } catch (error) {
      return null;
    }
  };
  try {
    const primaryTcpSocket = await connectAndForward(addressRemote);
    if (!primaryTcpSocket) {
	primaryTcpSocket.closed.catch(() => {}).finally(() => closeWebSocket(webSocket));    
	await connectAndForward(proxyIP);
    }
  } catch (error) {
    closeWebSocket(webSocket);
  }
};
const eventHandlers = new WeakMap();
const createWebSocketStream = (webSocket, earlyDataHeader) => {
  const readableStream = new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);    
      const handleMessage = event => controller.enqueue(event.data);
      const handleClose = () => {
        controller.close();
        removeWebSocketListeners(webSocket);
      };
      const handleError = err => {
        controller.error(err);
        removeWebSocketListeners(webSocket);
      };
      eventHandlers.set(webSocket, { handleMessage, handleClose, handleError });
      webSocket.addEventListener('message', handleMessage);
      webSocket.addEventListener('close', handleClose);
      webSocket.addEventListener('error', handleError);
    },
    cancel() {
      removeWebSocketListeners(webSocket);
      closeWebSocket(webSocket);
    }
  });
  return readableStream;
};
const removeWebSocketListeners = (webSocket) => {
  const handlers = eventHandlers.get(webSocket);
  if (handlers) {
    webSocket.removeEventListener('message', handlers.handleMessage);
    webSocket.removeEventListener('close', handlers.handleClose);
    webSocket.removeEventListener('error', handlers.handleError);
    eventHandlers.delete(webSocket);
  }
};
const processWebSocketHeader = (buffer, userID) => {
  const view = new DataView(buffer);
  const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
  if (receivedID !== userID) return { hasError: true };
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const version = new Uint8Array(buffer.slice(0, 1));
  const isUDP = command === 2;
  const portRemote = view.getUint16(18 + optLength + 1);
  const { addressRemote, rawDataIndex } = getAddressInfo(view, buffer, 18 + optLength + 3);
  return { hasError: false, addressRemote, portRemote, rawDataIndex, vlessVersion: version, isUDP };
};
const getAddressInfo = (view, buffer, startIndex) => {
  const addressType = view.getUint8(startIndex);
  const addressLength = addressType === 2 ? view.getUint8(startIndex + 1) : (addressType === 1 ? 4 : 16);
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
  const addressValue = addressType === 1
    ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
    : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
  return { addressRemote: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const forwardToData = async (remoteSocket, webSocket, responseHeader) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return;
  }
  let hasData = false;
  const writableStream = new WritableStream({
    async write(chunk) {
      hasData = true;
      const dataToSend = responseHeader 
        ? new Uint8Array([...responseHeader, ...chunk]).buffer 
        : chunk;
      webSocket.send(dataToSend);
      responseHeader = null;
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(webSocket);
  }
  return hasData;
};
const base64ToBuffer = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/[-_]/g, (match) => (match === '-' ? '+' : '/')));
    const buffer = Uint8Array.from(binaryStr, (char) => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = (webSocket) => {
  if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
    webSocket.close();
  }
};
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
};
const handleUdpRequest = async (webSocket, responseHeader, rawClientData) => {
  const batchSize = 10;
  let index = 0;
  let batch = [];
  const udpPackets = new Uint8Array(new DataView(rawClientData.buffer).getUint16(0));
  const dnsFetch = async (chunks) => {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: concatenateChunks(chunks)
    });
    return response.arrayBuffer();
  };
  const processBatch = async (controller) => {
    const dnsResults = await Promise.all(batch.map(dnsFetch));
    dnsResults.forEach(dnsResult => {
      index = processDnsResult(dnsResult, udpPackets, index);
    });
    controller.enqueue(udpPackets.slice(0, index));
    index = 0;
    batch = [];
  };
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, offset, 2).getUint16(0);
        batch.push(chunk.slice(offset + 2, offset + 2 + udpPacketLength));
        if (batch.length >= batchSize) {
          await processBatch(controller);
        }
        offset += 2 + udpPacketLength;
      }
    },
    async flush(controller) {
      if (batch.length) {
        await processBatch(controller);
      }
    }
  });
  const writer = transformStream.writable.getWriter();
  await writer.write(rawClientData);
  writer.close();
  const finalMessage = await transformStream.readable.getReader().read();
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(finalMessage.value.buffer);
  }
};
const concatenateChunks = (chunks) => {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  chunks.forEach(chunk => {
    result.set(new Uint8Array(chunk), offset);
    offset += chunk.byteLength;
  });
  return result.buffer;
};
const processDnsResult = (dnsResult, udpPackets, index) => {
  const responseArray = new Uint8Array(dnsResult);
  let offset = 0;
  while (offset < responseArray.byteLength) {
    const responseLength = new DataView(responseArray.buffer, offset, 2).getUint16(0);
    udpPackets.set(responseArray.slice(offset, offset + responseLength), index);
    index += responseLength;
    offset += responseLength;
  }
  return index;
};
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
