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
  const path = new URL(request.url).pathname;
  if (path === "/") {
    return new Response(JSON.stringify(request.cf, null, 4));
  }
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
  await writer.write(chunk);
  writer.releaseLock();
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
  const connectAndForward = async (address, port) => {
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
      const success = await forwardToData(tcpSocket, webSocket, responseHeader);
      if (!success) {
        closeWebSocket(webSocket);
      }
      return success;
    } catch (error) {
      return false;
    }
  };
  const main = await connectAndForward(addressRemote, portRemote);
  if (!main) {
    await connectAndForward(proxyIP, portRemote);
  }
};
const eventHandlers = new WeakMap();
const createWebSocketStream = (webSocket, earlyDataHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
        return;
      }
      if (earlyData) controller.enqueue(earlyData);
      const handleEvent = (event) => {
        switch (event.type) {
          case 'message':
            controller.enqueue(event.data);
            break;
          case 'close':
          case 'error':
            eventHandlers.delete(webSocket);
            controller[event.type === 'close' ? 'close' : 'error'](event);
            webSocket.removeEventListener('message', handleEvent);
            webSocket.removeEventListener('close', handleEvent);
            webSocket.removeEventListener('error', handleEvent);
            break;
        }
      };
      eventHandlers.set(webSocket, handleEvent);
      webSocket.addEventListener('message', handleEvent);
      webSocket.addEventListener('close', handleEvent);
      webSocket.addEventListener('error', handleEvent);
    },
    cancel() {
      const handleEvent = eventHandlers.get(webSocket);
      if (handleEvent) {
        eventHandlers.delete(webSocket);
        webSocket.removeEventListener('message', handleEvent);
        webSocket.removeEventListener('close', handleEvent);
        webSocket.removeEventListener('error', handleEvent);
      }
      closeWebSocket(webSocket);
    }
  });
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
  const batchSize = 3;
  const udpPackets = new Uint8Array(new DataView(rawClientData.buffer).getUint16(0));
  const batch = new Uint8Array(batchSize * rawClientData.byteLength / batchSize);
  const dnsFetch = async (chunk) => {
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: chunk
    });
    return response.arrayBuffer();
  };
  const processBatch = async (controller) => {
    const dnsResults = await Promise.all(batch.slice(0, batch.length).map(dnsFetch));
    let index = 0;
    for (const dnsResult of dnsResults) {
      const responseArray = new Uint8Array(dnsResult);
      index = processDnsResult(responseArray, udpPackets, index);
    }
    controller.enqueue(udpPackets.slice(0, index));
  };
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, offset, 2).getUint16(0);
        batch.set(chunk.slice(offset + 2, offset + 2 + udpPacketLength), offset);
        offset += 2 + udpPacketLength;
        if (batch.length >= batchSize) {
          await processBatch(controller);
          offset = 0;
          batch.fill(0);
        }
      }
      if (offset > 0) {
        await processBatch(controller);
      }
    },
    async flush(controller) {
      if (batch.length > 0) {
        await processBatch(controller, batch);
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
const processDnsResult = (dnsResult, udpPackets, index) => {
  const responseArray = new Uint8Array(dnsResult);
  let offset = 0;
  while (offset < responseArray.byteLength) {
    const responseLength = new DataView(responseArray.buffer, offset, 2).getUint16(0);
    udpPackets.set(responseArray.subarray(offset, offset + responseLength), index);
    index += responseLength;
    offset += responseLength;
  }
  return index;
};
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
