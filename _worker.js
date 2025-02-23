import { connect } from 'cloudflare:sockets';

const WebSocketStates = {
  OPEN: 1,
  CLOSING: 2,
};

export default {
  fetch: async (request, env) => {
    const myID = env.MYID;
    const worldIP = env.WORLDIP;
    return request.headers.get('Upgrade') === 'websocket'
      ? handlerWs(request, myID, worldIP)
      : handlerHttp(request, myID);
  },
};

const handlerHttp = (request, myID) => {
  const url = new URL(request.url).pathname;
  const hostName = request.headers.get('Host');
  const routes = {
    '/': () => new Response(JSON.stringify(request.cf), { status: 200 }),
    [`/${myID}`]: () => new Response(getConfig(myID, hostName), {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    }),
  };
  return (routes[url] || (() => new Response('Not found', { status: 404 })))();
};

const handlerWs = async (request, myID, worldIP) => {
  try {
    const [client, webSocket] = Object.values(new WebSocketPair());
    webSocket.accept();
    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    if (!/^[A-Za-z0-9+/=_-]+$/.test(earlyHeader)) throw new Error('Invalid earlyHeader');
    const readableWstream = handlerStream(webSocket, earlyHeader);
    const remoteSocket = { value: null };
    let udpWrite = null, isDns = false;
    await readableWstream.pipeTo(new WritableStream({
      write: async (chunk) => {
        if (isDns && udpWrite) return udpWrite(chunk);
        if (remoteSocket.value) return writeToSocket(remoteSocket.value, chunk);
        const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, resVersion = new Uint8Array([0, 0]), isUDP } = processResHeader(chunk, myID);
        if (hasError) return;
        const resHeader = new Uint8Array([resVersion[0], 0]);
        const clientData = chunk.slice(rawDataIndex);
        if (isUDP) {
          if (portRemote !== 53) return;
          isDns = true;
          const { write } = await handleUDP(webSocket, resHeader);
          udpWrite = write;
          udpWrite(clientData);
        } else {
          handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, worldIP);
        }
      },
      close() {
        if (remoteSocket.value) remoteSocket.value.close();
      }
    }));
    return new Response(null, { status: 101, webSocket: client });
  } catch (error) {
    console.error('WebSocket处理失败:', error);
    return new Response('Internal Server Error', { status: 500 });
  }
};

const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};

const handleTCP = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, worldIP) => {
  const connectAndWrite = async (address, port) => {
    remoteSocket.value = connect({ hostname: address, port });
    try {
      await writeToSocket(remoteSocket.value, clientData);
      return await forwardToData(remoteSocket.value, webSocket, resHeader);
    } catch (e) {
      remoteSocket.value.close();
      remoteSocket.value = null;
      throw e;
    }
  };
  try {
    return await connectAndWrite(addressRemote, portRemote) || await connectAndWrite(worldIP, portRemote);
  } catch (e) {
    closeWebSocket(webSocket);
    return false;
  } finally {
    if (remoteSocket.value && remoteSocket.value.readyState > 1) {
      remoteSocket.value.close();
      remoteSocket.value = null;
    }
  }
};

const handlerStream = (webSocketServer, earlyHeader) => {
  const { earlyData, error } = base64ToBuffer(earlyHeader);
  if (error) {
    closeWebSocket(webSocketServer);
    return new ReadableStream({ start: (c) => c.error(error) });
  }
  let isCanceled = false;
  return new ReadableStream({
    start(controller) {
      if (earlyData) controller.enqueue(earlyData);
      const messageHandler = ({ data }) => controller.enqueue(data);
      const closeHandler = () => controller.close();
      const errorHandler = (err) => controller.error(err);
      webSocketServer.addEventListener('message', messageHandler);
      webSocketServer.addEventListener('close', closeHandler);
      webSocketServer.addEventListener('error', errorHandler);
      controller.cancel = () => {
        if (!isCanceled) {
          isCanceled = true;
          webSocketServer.removeEventListener('message', messageHandler);
          webSocketServer.removeEventListener('close', closeHandler);
          webSocketServer.removeEventListener('error', errorHandler);
          closeWebSocket(webSocketServer);
        }
      };
    },
    cancel() {
      if (!isCanceled) closeWebSocket(webSocketServer);
    }
  });
};

const processResHeader = (resBuffer, myID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };
  const view = new DataView(resBuffer);
  const version = new Uint8Array([view.getUint8(0)]);
  const cachedUserID = Uint8Array.from(myID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
  for (let i = 0; i < 16; i++) {
    if (view.getUint8(1 + i) !== cachedUserID[i]) return { hasError: true };
  }
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: true };
  const portRemote = view.getUint16(19 + optLength);
  const addressType = view.getUint8(21 + optLength);
  let addressValue = '', addressLength = 0, addressIndex = 22 + optLength;
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = `${view.getUint8(addressIndex)}.${view.getUint8(addressIndex + 1)}.${view.getUint8(addressIndex + 2)}.${view.getUint8(addressIndex + 3)}`;
      break;
    case 2:
      addressLength = view.getUint8(addressIndex);
      addressValue = new TextDecoder().decode(resBuffer.slice(addressIndex + 1, addressIndex + 1 + addressLength));
      break;
    case 3:
      addressLength = 16;
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(view.getUint16(addressIndex + i * 2).toString(16));
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressIndex + addressLength,
    resVersion: version,
    isUDP,
  };
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  const writableStream = new WritableStream({
    write: async (chunk, controller) => {
      if (webSocket.readyState !== WebSocketStates.OPEN) controller.error('webSocket is not open');
      webSocket.send(resHeader ? new Uint8Array([...resHeader, ...chunk]) : chunk);
      resHeader = null;
      hasData = true;
    },
  });
  await remoteSocket.readable.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  return hasData;
};

const base64ToBuffer = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const arrayBuffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const closeWebSocket = (socket) => {
  if ([WebSocketStates.OPEN, WebSocketStates.CLOSING].includes(socket.readyState)) socket.close();
};

const handleUDP = async (webSocket, resHeader) => {
  const dnsCache = new Map();
  const transformStream = new TransformStream({
    transform: (chunk, controller) => {
      const view = new DataView(chunk);
      const udpPacketLength = view.getUint16(0);
      controller.enqueue(new Uint8Array(chunk.slice(2, 2 + udpPacketLength)));
    },
  });
  await transformStream.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      const cacheKey = new TextDecoder().decode(chunk);
      if (dnsCache.has(cacheKey)) {
        const cachedResult = dnsCache.get(cacheKey);
        webSocket.send(new Uint8Array([...resHeader, ...cachedResult]));
        return;
      }
      const resp = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await resp.arrayBuffer();
      dnsCache.set(cacheKey, new Uint8Array(dnsQueryResult));
      const udpSizeBuffer = new Uint8Array(2);
      new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength);
      webSocket.send(new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
    }
  }));
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};

const getConfig = (myID, hostName) => `res://${myID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
