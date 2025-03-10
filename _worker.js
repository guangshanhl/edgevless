import { connect } from 'cloudflare:sockets';

const WS_OPEN = 1, WS_CLOSING = 2;

export default {
  fetch: async (request, env) => {
    const myID = env.MYID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const ownIP = env.OWNIP ?? '';
    return request.headers.get('Upgrade') === 'websocket'
      ? handlerWs(request, myID, ownIP)
      : handlerHttp(request, myID);
  },
};

const handlerHttp = (request, myID) => {
  const url = new URL(request.url).pathname;
  if (url === '/') {
    return new Response(JSON.stringify(request.cf), { status: 200 });
  } else if (url === `/${myID}`) {
    return new Response(getConfig(myID, request.headers.get('Host')), {
      status: 200,
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  } else {
    return new Response('Not found', { status: 404 });
  }
};

const handlerWs = async (request, myID, ownIP) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  webSocket.accept();
  const readableWstream = handlerStream(webSocket, request.headers.get('sec-websocket-protocol') || '');
  const remoteSocket = { value: null };
  let udpWrite = null, isDns = false;

  const writableStream = new WritableStream({
    write: async (chunk) => {
      if (isDns && udpWrite) {
        return udpWrite(chunk);
      }
      if (remoteSocket.value) {
        return writeToSocket(remoteSocket.value, chunk);
      }
      const { hasError, portRemote = 443, addressRemote = '', rawDataIndex, resVersion = new Uint8Array([0, 0]), isUDP } = processResHeader(chunk, myID);
      if (hasError) {
        closeWebSocket(webSocket);
        return;
      }
      const resHeader = new Uint8Array([resVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);
      if (isUDP) {
        if (portRemote !== 53) {
          closeWebSocket(webSocket);
          return;
        }
        isDns = true;
        const { write } = await handleUDP(webSocket, resHeader);
        udpWrite = write;
        udpWrite(clientData);
      } else {
        handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, ownIP);
      }
    },
  });

  readableWstream.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  return new Response(null, { status: 101, webSocket: client });
};

const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};

const handleTCP = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, ownIP) => {
  const connectAndWrite = async (address, port) => {
    try {
      remoteSocket.value = connect({ hostname: address, port });
      await writeToSocket(remoteSocket.value, clientData);
      return await forwardToData(remoteSocket.value, webSocket, resHeader);
    } catch (error) {
      return false;
    }
  };
  const connected = await connectAndWrite(addressRemote, portRemote) || await connectAndWrite(ownIP, portRemote);
  if (!connected) {
    closeWebSocket(webSocket);
  }
};

const handlerStream = (webSocket, earlyHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) {
        controller.error(error);
        return;
      }
      if (earlyData) {
        controller.enqueue(earlyData);
      }
      webSocket.addEventListener('message', ({ data }) => {
        try {
          controller.enqueue(data);
        } catch (err) {
          controller.error(err);
        }
      });
      webSocket.addEventListener('close', () => controller.close());
      webSocket.addEventListener('error', (err) => {
        controller.error(err);
      });
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
};

const processResHeader = (resBuffer, myID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };
  const version = new Uint8Array(resBuffer.slice(0, 1));
  const cachedUserID = Uint8Array.from(myID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
  const bufferUserID = new Uint8Array(resBuffer.slice(1, 17));
  if (!cachedUserID.every((byte, index) => byte === bufferUserID[index])) return { hasError: true };
  const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
  const command = new Uint8Array(resBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: false };
  const portIndex = 18 + optLength + 1;
  const portBuffer = resBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressBuffer = new Uint8Array(resBuffer.slice(addressIndex, addressIndex + 1));
  const addressType = addressBuffer[0];
  let addressLength = 0, addressValueIndex = addressIndex + 1, addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
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
    resVersion: version,
    isUDP,
  };
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  if (webSocket.readyState !== WS_OPEN) {
    return false;
  }
  let hasData = false;
  let firstChunk = true;
  const writableStream = new WritableStream({
    write: async (chunk, controller) => {
      try {
        if (firstChunk && resHeader) {
          const combinedChunk = new Uint8Array(resHeader.length + chunk.length);
          combinedChunk.set(resHeader, 0);
          combinedChunk.set(chunk, resHeader.length);
          webSocket.send(combinedChunk);
          firstChunk = false;
        } else {
          webSocket.send(chunk);
        }
        hasData = true;
      } catch (error) {
        controller.error(error);
      }
    },
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
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const arrayBuffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const closeWebSocket = (socket) => {
  if ([WS_OPEN, WS_CLOSING].includes(socket.readyState)) socket.close();
};

const handleUDP = async (webSocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    transform: (chunk, controller) => {
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        controller.enqueue(udpData);
        index += 2 + udpPacketLength;
      }
    },
  });
  const writableStream = new WritableStream({
    write: async (chunk) => {
      const resp = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await resp.arrayBuffer();
      const udpSizeBuffer = new Uint8Array(2);
      new DataView(udpSizeBuffer.buffer).setUint16(0, dnsQueryResult.byteLength, false);
      if (webSocket.readyState === WS_OPEN) {
        webSocket.send(headerSent
          ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
          : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]));
        headerSent = true;
      }
    }
  });
  transformStream.readable.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};

const getConfig = (myID, hostName) => `res://${myID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
