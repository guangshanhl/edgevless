import { connect } from 'cloudflare:sockets';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
export default {
  fetch: async (request, env) => {
    const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP ?? '';
    if (request.headers.get('Upgrade') === 'websocket') {
      return handleWebSocket(request, userID, proxyIP);
    }
    return handleRequest(request, userID);
  },
};
const handleRequest = (request, userID) => {
  const url = new URL(request.url);
  const handler = {
    '/': () => new Response(JSON.stringify(request.cf), { status: 200 }),
    [`/${userID}`]: () => new Response(getConfig(userID, request.headers.get('Host')), {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    })
  }[url.pathname] || (() => new Response('Not found', { status: 404 }));  
  return handler();
};
const handleWebSocket = async (request, userID, proxyIP) => {
  const { 0: client, 1: webSocket } = Object.values(new WebSocketPair());
  webSocket.accept();
  const readableWebStream = streamHandler(webSocket, request.headers.get('sec-websocket-protocol') || '');
  const remoteSocket = { value: null };
  let udpWrite = null;
  let isDns = false;
  readableWebStream.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (isDns && udpWrite) return udpWrite(chunk);
      if (remoteSocket.value) return writeToSocket(remoteSocket.value, chunk);
      const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = processRessHeader(chunk, userID);
      if (hasError) return;
      const resHeader = new Uint8Array([ressVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        if (portRemote !== 53) return;
        isDns = true;
        const { write } = await handleUDP(webSocket, resHeader);
        udpWrite = write;
        udpWrite(clientData);
      } else {
        handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP);
      }
    },
  }));
  return new Response(null, { status: 101, webSocket: client });
};
const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const handleTCP = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) => {
  const connectAndWrite = async (address, port) => {
    remoteSocket.value = connect({ hostname: address, port: port });
    await writeToSocket(remoteSocket.value, clientData);
    return forwardToData(remoteSocket.value, webSocket, resHeader);
  };
  const connected = await connectAndWrite(addressRemote, portRemote) || await connectAndWrite(proxyIP, portRemote);
  if (!connected) closeWebSocket(webSocket);
};
const streamHandler = (webSocketServer, earlyHeader) => {
  let isCancel = false;
  const stream = new ReadableStream({
    start: (controller) => {
      webSocketServer.addEventListener('message', (event) => {
        if (isCancel) return;
        const message = event.data;
        controller.enqueue(message.buffer);
      });
      webSocketServer.addEventListener('close', () => {
        closeWebSocket(webSocketServer);
        if (isCancel) return;
        controller.close();
      });
      webSocketServer.addEventListener('error', (err) => {
        controller.error(err);
      });
      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData.buffer);
      }
    },
    cancel(reason) {
      if (isCancel) return;
      isCancel = true;
      closeWebSocket(webSocketServer);
    }
  });
  return stream;
};
const processRessHeader = (ressBuffer, userID) => {
  if (ressBuffer.byteLength < 24) return { hasError: true };
  const version = new Uint8Array(ressBuffer.slice(0, 1));
  let isUDP = false;
  const cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
  const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
  const hasUserID = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
  if (hasUserID) return { hasError: true };
  const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
  const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  if (command === 2) isUDP = true;
  else if (command !== 1) return { hasError: false };
  const portIndex = 18 + optLength + 1;
  const portBuffer = ressBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      const ipv6 = [];
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
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
    ressVersion: version,
    isUDP,
  };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  const writableStream = new WritableStream({
    write: async (chunk, controller) => {
      if (webSocket.readyState !== WS_READY_STATE_OPEN) {
        controller.error('webSocket is not open');
      }
      const dataToSend = resHeader ? new Uint8Array([...resHeader, ...chunk]).buffer : chunk;
      webSocket.send(dataToSend);
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
  if ([WS_READY_STATE_OPEN, WS_READY_STATE_CLOSING].includes(socket.readyState)) {
    socket.close();
  }
};
const handleUDP = async (webSocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    transform: (chunk, controller) => {
      for (let index = 0; index < chunk.byteLength;) {
        const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        controller.enqueue(udpData);
        index += 2 + udpPacketLength;
      }
    },
  });
  await transformStream.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      const resp = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSizeBuffer = new Uint8Array(2);
      new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength, false);
      if (webSocket.readyState === WS_READY_STATE_OPEN) {
        const combined = headerSent
          ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]).buffer
          : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]).buffer;
        webSocket.send(combined);
        headerSent = true;
      }
    }
  }));
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};
const getConfig = (userID, hostName) => {
  return `ress://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
};
