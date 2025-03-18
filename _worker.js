import { connect } from 'cloudflare:sockets';

const WS_OPEN = 1,
      WS_CLOSING = 2;

let cachedMyIDBuffer = null;
let cachedMyID = null;
const getCachedMyIDBuffer = (myID) => {
  if (cachedMyID !== myID) {
    cachedMyID = myID;
    cachedMyIDBuffer = new Uint8Array(
      myID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16))
    );
  }
  return cachedMyIDBuffer;
};

export default {
  fetch: async (request, env) => {
    try {
      const myID = env.MYID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const ownIP = env.OWNIP ?? '';
      if (request.headers.get('Upgrade') === 'websocket') {
        return handlerWs(request, myID, ownIP);
      } else {
        return handlerHttp(request, myID);
      }
    } catch (error) {
      return new Response('Internal Server Error', { status: 500 });
    }
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
  const protocolHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWstream = handlerStream(webSocket, protocolHeader);
  const remoteSocket = { value: null };
  let udpWrite = null, isDns = false;

  const writableStream = new WritableStream({
    write: async (chunk) => {
      try {
        if (isDns && udpWrite) {
          return udpWrite(chunk);
        }
        if (remoteSocket.value) {
          return writeToSocket(remoteSocket.value, chunk);
        }
        const headerResult = processResHeader(chunk, myID);
        if (headerResult.hasError) {
          closeWebSocket(webSocket);
          return;
        }
        const { portRemote = 443, addressRemote = '', rawDataIndex, resVersion, isUDP } = headerResult;
        const resHeader = new Uint8Array(2);
        resHeader[0] = resVersion[0];
        resHeader[1] = 0;
        const clientData = chunk.slice(rawDataIndex);
        if (isUDP) {
          if (portRemote !== 53) {
            closeWebSocket(webSocket);
            return;
          }
          isDns = true;
          const { write } = await handleUDP(webSocket, resHeader);
          udpWrite = write;
          await udpWrite(clientData);
        } else {
          await handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, ownIP);
        }
      } catch (error) {
        closeWebSocket(webSocket);
      }
    },
  });

  readableWstream.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  return new Response(null, { status: 101, webSocket: client });
};

const writeToSocket = async (socket, chunk) => {
  try {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
  } catch (error) {
    throw error;
  }
};

const handleTCP = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, ownIP) => {
  const connectAndWrite = async (address, port) => {
    try {
      const socket = connect({ hostname: address, port });
      remoteSocket.value = socket;
      await writeToSocket(socket, clientData);
      return await forwardToData(socket, webSocket, resHeader);
    } catch (err) {
      return false;
    }
  };
  const connected = await connectAndWrite(addressRemote, portRemote) ||
                    await connectAndWrite(ownIP, portRemote);
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
      webSocket.addEventListener('error', (err) => controller.error(err));
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
};

const processResHeader = (resBuffer, myID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };
  const dv = new DataView(resBuffer);
  const version = new Uint8Array([dv.getUint8(0)]);
  const cachedBuffer = getCachedMyIDBuffer(myID);
  for (let i = 0; i < 16; i++) {
    if (cachedBuffer[i] !== dv.getUint8(1 + i)) return { hasError: true };
  }
  const optLength = dv.getUint8(17);
  const command = dv.getUint8(18 + optLength);
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: true };
  const portRemote = dv.getUint16(18 + optLength + 1, false);
  let addressIndex = 18 + optLength + 1 + 2;
  const addressType = dv.getUint8(addressIndex++);
  let addressValue = '';
  let addressLength = 0;
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = `${dv.getUint8(addressIndex)}.${dv.getUint8(addressIndex + 1)}.${dv.getUint8(addressIndex + 2)}.${dv.getUint8(addressIndex + 3)}`;
      break;
    case 2:
      addressLength = dv.getUint8(addressIndex);
      addressIndex++;
      addressValue = new TextDecoder().decode(new Uint8Array(resBuffer, addressIndex, addressLength));
      break;
    case 3:
      addressLength = 16;
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(dv.getUint16(addressIndex + i * 2, false).toString(16));
      }
      addressValue = parts.join(':');
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
    const binaryStr = atob(
      base64Str.replace(/-/g, '+').replace(/_/g, '/')
    );
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
      try {
        const resp = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: chunk,
        });
        const dnsQueryResult = await resp.arrayBuffer();
        const dnsResultArray = new Uint8Array(dnsQueryResult);
        const udpSizeBuffer = new Uint8Array(2);
        new DataView(udpSizeBuffer.buffer).setUint16(0, dnsResultArray.byteLength, false);
        const resultBuffer = headerSent
          ? new Uint8Array(2 + dnsResultArray.byteLength)
          : new Uint8Array(resHeader.length + 2 + dnsResultArray.byteLength);
        let offset = 0;
        if (!headerSent) {
          resultBuffer.set(resHeader, offset);
          offset += resHeader.length;
        }
        resultBuffer.set(udpSizeBuffer, offset);
        offset += 2;
        resultBuffer.set(dnsResultArray, offset);
        if (webSocket.readyState === WS_OPEN) {
          webSocket.send(resultBuffer);
          headerSent = true;
        }
      } catch (e) {
        closeWebSocket(webSocket);
      }
    }
  });
  transformStream.readable.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};

const getConfig = (myID, hostName) =>
  `res://${myID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
