import { connect } from 'cloudflare:sockets';

const WS_OPEN = 1;
const WS_CLOSING = 2;
const DEFAULT_MYID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const CONTENT_TYPE_TEXT = { "Content-Type": "text/plain;charset=utf-8" };
const STATUS_200 = { status: 200 };
const STATUS_404 = { status: 404 };
const STATUS_101 = { status: 101 };

export default {
  async fetch(request, env) {
    const myID = env.MYID || DEFAULT_MYID;
    const worldIP = env.WORLDIP || '';
    return request.headers.get('Upgrade') === 'websocket'
      ? handlerWs(request, myID, worldIP)
      : handlerHttp(request, myID);
  },
};

const handlerHttp = (request, myID) => {
  const { pathname } = new URL(request.url);
  if (pathname === '/') {
    return new Response(JSON.stringify(request.cf), STATUS_200);
  }
  if (pathname === `/${myID}`) {
    return new Response(getConfig(myID, request.headers.get('Host')), {
      ...STATUS_200,
      headers: CONTENT_TYPE_TEXT,
    });
  }
  return new Response('Not found', STATUS_404);
};

const handlerWs = async (request, myID, worldIP) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWstream = handlerStream(webSocket, earlyHeader);
  const remoteSocket = { value: null };
  let udpWrite = null;
  let isDns = false;

  readableWstream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpWrite) return udpWrite(chunk);
      if (remoteSocket.value) return writeToSocket(remoteSocket.value, chunk);

      const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, resVersion = new Uint8Array([0, 0]), isUDP } = processResHeader(chunk, myID);
      if (hasError) return;

      const resHeader = new Uint8Array([resVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);

      if (isUDP) {
        if (portRemote !== 53) return;
        isDns = true;
        udpWrite = (await handleUDP(webSocket, resHeader)).write;
        udpWrite(clientData);
      } else {
        handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, worldIP);
      }
    },
  }));

  return new Response(null, { ...STATUS_101, webSocket: client });
};

const writeToSocket = (socket, chunk) => socket.writable.getWriter().write(chunk).then(w => w.releaseLock());

const handleTCP = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, worldIP) => {
  const connectAndWrite = async (address, port) => {
    remoteSocket.value = connect({ hostname: address, port });
    await writeToSocket(remoteSocket.value, clientData);
    return forwardToData(remoteSocket.value, webSocket, resHeader);
  };

  const connected = await connectAndWrite(addressRemote, portRemote) || await connectAndWrite(worldIP, portRemote);
  if (!connected) closeWebSocket(webSocket);
};

const handlerStream = (webSocketServer, earlyHeader) => {
  const { earlyData, error } = base64ToBuffer(earlyHeader);
  return new ReadableStream({
    start(controller) {
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      webSocketServer.addEventListener('message', ({ data }) => controller.enqueue(data), { passive: true });
      webSocketServer.addEventListener('close', () => controller.close(), { once: true });
      webSocketServer.addEventListener('error', (err) => controller.error(err), { once: true });
    },
    cancel: () => closeWebSocket(webSocketServer),
  });
};

const processResHeader = (resBuffer, myID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };

  const view = new DataView(resBuffer);
  const cachedUserID = Uint8Array.from(myID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));

  for (let i = 0; i < 16; i++) if (resBuffer[1 + i] !== cachedUserID[i]) return { hasError: true };

  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: true };

  const portIndex = 18 + optLength + 1;
  const portRemote = view.getUint16(portIndex);
  const addressIndex = portIndex + 2;
  const addressType = view.getUint8(addressIndex);
  let addressLength, addressValueIndex = addressIndex + 1, addressValue;

  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = `${view.getUint8(addressValueIndex)}.${view.getUint8(addressValueIndex + 1)}.${view.getUint8(addressValueIndex + 2)}.${view.getUint8(addressValueIndex + 3)}`;
      break;
    case 2:
      addressLength = view.getUint8(addressValueIndex);
      addressValue = new TextDecoder().decode(resBuffer.slice(addressValueIndex + 1, addressValueIndex + 1 + addressLength));
      break;
    case 3:
      addressLength = 16;
      const ipv6 = [];
      for (let i = 0; i < 8; i++) ipv6.push(view.getUint16(addressValueIndex + i * 2).toString(16));
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
    rawDataIndex: addressValueIndex + addressLength,
    resVersion: new Uint8Array([view.getUint8(0), 0]),
    isUDP,
  };
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  const writableStream = new WritableStream({
    write(chunk) {
      if (webSocket.readyState !== WS_OPEN) throw new Error('webSocket is not open');
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
    return { earlyData: Uint8Array.from(binaryStr, c => c.charCodeAt(0)).buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const closeWebSocket = (socket) => {
  if (socket.readyState === WS_OPEN || socket.readyState === WS_CLOSING) socket.close();
};

const handleUDP = async (webSocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const view = new DataView(chunk);
      for (let index = 0; index < chunk.byteLength;) {
        const udpPacketLength = view.getUint16(index);
        controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength)));
        index += 2 + udpPacketLength;
      }
    },
  });

  const dnsWriter = new WritableStream({
    async write(chunk) {
      const resp = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSizeBuffer = new Uint8Array(2);
      new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength);
      if (webSocket.readyState === WS_OPEN) {
        webSocket.send(headerSent
          ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
          : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
        headerSent = true;
      }
    },
  });

  transformStream.readable.pipeTo(dnsWriter);
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};

const getConfig = (myID, hostName) =>
  `res://${myID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
