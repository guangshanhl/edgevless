import { connect } from 'cloudflare:sockets';

// 常量和缓存
const WS_STATES = {
  OPEN: 1,
  CLOSING: 2
};

const HEADERS = {
  CONFIG: { "Content-Type": "text/plain;charset=utf-8" },
  DNS: { 'content-type': 'application/dns-message' }
};

// 缓存解析后的userID
let cachedUserID = null;

const memoizedParseUserID = (userID) => {
  if (!cachedUserID) {
    cachedUserID = Uint8Array.from(
      userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16))
    );
  }
  return cachedUserID;
};

export default {
  fetch: async (request, env) => {
    try {
      const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP ?? '';
      
      if (request.headers.get('Upgrade') === 'websocket') {
        return handleWebSocket(request, userID, proxyIP);
      }

      const url = new URL(request.url);
      const routes = new Map([
        ['/', () => new Response(JSON.stringify(request.cf), { status: 200 })],
        [`/${userID}`, () => new Response(
          getConfig(userID, request.headers.get('Host')), 
          { status: 200, headers: HEADERS.CONFIG }
        )]
      ]);

      const handler = routes.get(url.pathname);
      return handler ? handler() : new Response('Not found', { status: 404 });
    } catch (err) {
      return new Response(err.toString(), { status: 500 });
    }
  }
};

const handleWebSocket = async (request, userID, proxyIP) => {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createStreamHandler(webSocket, earlyHeader);

  const state = {
    remoteSocket: null,
    udpWrite: null,
    isDns: false
  };

  readableStream.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (state.isDns && state.udpWrite) {
        return state.udpWrite(chunk);
      }

      if (state.remoteSocket) {
        const writer = state.remoteSocket.writable.getWriter();
        try {
          await writer.write(chunk);
        } finally {
          writer.releaseLock();
        }
        return;
      }

      const {
        hasError,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        ressVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processRessHeader(chunk, userID);

      if (hasError) return;

      if (isUDP) {
        if (portRemote === 53) {
          state.isDns = true;
          const { write } = await handleUDPOutBound(webSocket, new Uint8Array([ressVersion[0], 0]));
          state.udpWrite = write;
          state.udpWrite(chunk.slice(rawDataIndex));
        }
        return;
      }

      await handleTCPOutBound(
        state,
        addressRemote,
        portRemote,
        chunk.slice(rawDataIndex),
        webSocket,
        new Uint8Array([ressVersion[0], 0]),
        proxyIP
      );
    }
  }));

  return new Response(null, {
    status: 101,
    webSocket: client
  });
};

const createStreamHandler = (webSocket, earlyHeader) => {
  let isCancel = false;

  return new ReadableStream({
    start: (controller) => {
      webSocket.addEventListener('message', (event) => {
        if (!isCancel) controller.enqueue(event.data);
      });

      webSocket.addEventListener('close', () => {
        closeWebSocket(webSocket);
        if (!isCancel) controller.close();
      });

      webSocket.addEventListener('error', (err) => {
        controller.error(err);
      });

      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel: () => {
      if (!isCancel) {
        isCancel = true;
        closeWebSocket(webSocket);
      }
    }
  });
};

const processRessHeader = (ressBuffer, userID) => {
  if (ressBuffer.byteLength < 24) return { hasError: true };

  const version = new Uint8Array(ressBuffer.slice(0, 1));
  const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
  const parsedUserID = memoizedParseUserID(userID);

  if (bufferUserID.some((byte, index) => byte !== parsedUserID[index])) {
    return { hasError: true };
  }

  const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
  const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: false };

  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(ressBuffer.slice(portIndex, portIndex + 2)).getUint16(0);

  const addressIndex = portIndex + 2;
  const addressType = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1))[0];

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
      const ipv6 = [];
      const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
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
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    ressVersion: version,
    isUDP
  };
};

const handleTCPOutBound = async (state, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP) => {
  const connectAndWrite = async (address, port) => {
    try {
      const socket = connect({ hostname: address, port });
      const writer = socket.writable.getWriter();
      await writer.write(clientData);
      writer.releaseLock();
      return socket;
    } catch {
      return null;
    }
  };

  const tryConnect = async (address, port) => {
    const socket = await connectAndWrite(address, port);
    if (socket) {
      state.remoteSocket = socket;
      return forwardToData(socket, webSocket, resHeader);
    }
    return false;
  };

  if (!await tryConnect(addressRemote, portRemote) && !await tryConnect(proxyIP, portRemote)) {
    closeWebSocket(webSocket);
  }
};

const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;

  await remoteSocket.readable.pipeTo(new WritableStream({
    write: (chunk) => {
      if (webSocket.readyState !== WS_STATES.OPEN) {
        throw new Error('WebSocket closed');
      }

      const data = resHeader ? 
        concatUint8Arrays([resHeader, new Uint8Array(chunk)]) :
        chunk;

      webSocket.send(data);
      hasData = true;
      
      if (resHeader) resHeader = null;
    }
  })).catch(() => {
    closeWebSocket(webSocket);
  });

  return hasData;
};

const handleUDPOutBound = async (webSocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    transform: (chunk, controller) => {
      for (let index = 0; index < chunk.byteLength;) {
        const length = new DataView(chunk.slice(index, index + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(index + 2, index + 2 + length)));
        index += 2 + length;
      }
    }
  });

  transformStream.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: HEADERS.DNS,
        body: chunk
      });

      const result = await response.arrayBuffer();
      const sizeBuffer = new Uint8Array(2);
      new DataView(sizeBuffer.buffer).setUint16(0, result.byteLength, false);

      if (webSocket.readyState === WS_STATES.OPEN) {
        const data = headerSent ?
          concatUint8Arrays([sizeBuffer, new Uint8Array(result)]) :
          concatUint8Arrays([resHeader, sizeBuffer, new Uint8Array(result)]);
        
        webSocket.send(data);
        headerSent = true;
      }
    }
  }));

  const writer = transformStream.writable.getWriter();
  return { write: chunk => writer.write(chunk) };
};

const base64ToBuffer = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const arr = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      arr[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: arr.buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const closeWebSocket = (socket) => {
  if (socket.readyState === WS_STATES.OPEN || socket.readyState === WS_STATES.CLOSING) {
    socket.close();
  }
};

const concatUint8Arrays = (arrays) => {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
};

const getConfig = (userID, hostName) => {
  return `ress://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
};
