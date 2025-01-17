import { connect } from 'cloudflare:sockets';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const DNS_CACHE_TTL = 300000;
const DNS_CACHE = new Map();
export default {
  fetch: async (request, env) => {
    const userID = env.UUID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP ?? '';   
    return request.headers.get('Upgrade') === 'websocket'
      ? handlerWs(request, userID, proxyIP)
      : handlerHttp(request, userID);
  },
};
const handlerHttp = (request, userID) => {
  const url = new URL(request.url);
  const routes = {
    '/': () => new Response(JSON.stringify(request.cf), { 
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60'
      }
    }),
    [`/${userID}`]: () => new Response(
      getConfig(userID, request.headers.get('Host')), 
      {
        status: 200,
        headers: {
          'Content-Type': 'text/plain;charset=utf-8',
          'Cache-Control': 'private, no-cache'
        }
      }
    )
  };
  return routes[url.pathname]?.() ?? new Response('Not found', { status: 404 });
};
const handlerWs = async (request, userID, proxyIP) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  webSocket.accept();
  const protocol = request.headers.get('sec-websocket-protocol') || '';
  const stream = createStream(webSocket, protocol); 
  const remoteSocket = { value: null };
  let udpWriter = null;
  let isDns = false;
  await stream.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (isDns && udpWriter) {
        return udpWriter(chunk);
      }
      if (remoteSocket.value) {
        return writeToSocket(remoteSocket.value, chunk);
      }
      const result = processHeader(chunk, userID);
      if (result.hasError) return;
      const { portRemote, addressRemote, rawDataIndex, resVersion, isUDP } = result;
      const clientData = chunk.slice(rawDataIndex);
      const resHeader = new Uint8Array([resVersion[0], 0]);
      if (isUDP && portRemote === 53) {
        isDns = true;
        const { write } = await handleDNS(webSocket, resHeader);
        udpWriter = write;
        udpWriter(clientData);
      } else {
        await handleTCP(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader, proxyIP);
      }
    }
  }));
  return new Response(null, { 
    status: 101, 
    webSocket: client 
  });
};
const handleDNS = async (webSocket, resHeader) => {
  let headerSent = false; 
  const transformStream = new TransformStream({
    transform: (chunk, controller) => {
      for (let i = 0; i < chunk.byteLength;) {
        const length = new DataView(chunk.slice(i, i + 2)).getUint16(0);
        controller.enqueue(new Uint8Array(chunk.slice(i + 2, i + 2 + length)));
        i += 2 + length;
      }
    }
  });
  const handleDNSQuery = async (chunk) => {
    const cacheKey = Array.from(chunk).join(',');
    const cachedResponse = DNS_CACHE.get(cacheKey);    
    if (cachedResponse && Date.now() - cachedResponse.timestamp < DNS_CACHE_TTL) {
      return cachedResponse.data;
    }
    const response = await fetch('https://cloudflare-dns.com/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: chunk
    });
    const dnsResult = await response.arrayBuffer();
    DNS_CACHE.set(cacheKey, {
      data: dnsResult,
      timestamp: Date.now()
    });
    return dnsResult;
  };
  await transformStream.readable.pipeTo(new WritableStream({
    write: async (chunk) => {
      if (webSocket.readyState !== WS_READY_STATE_OPEN) return;     
      const dnsResult = await handleDNSQuery(chunk);
      const sizeBuffer = new Uint8Array(2);
      new DataView(sizeBuffer.buffer).setUint16(0, dnsResult.byteLength);     
      const response = headerSent 
        ? new Uint8Array([...sizeBuffer, ...new Uint8Array(dnsResult)])
        : new Uint8Array([...resHeader, ...sizeBuffer, ...new Uint8Array(dnsResult)]);     
      webSocket.send(response);
      headerSent = true;
    }
  }));
  return {
    write: (chunk) => transformStream.writable.getWriter().write(chunk)
  };
};
const handleTCP = async (remoteSocket, address, port, data, webSocket, resHeader, proxyIP) => {
  const connectWithRetry = async (addr, p) => {
    try {
      remoteSocket.value = connect({ hostname: addr, port: p });
      await writeToSocket(remoteSocket.value, data);
      return forwardData(remoteSocket.value, webSocket, resHeader);
    } catch {
      return false;
    }
  };
  const connected = await connectWithRetry(address, port) || 
                   (proxyIP && await connectWithRetry(proxyIP, port));                  
  if (!connected) closeWebSocket(webSocket);
};
const forwardData = async (socket, webSocket, resHeader) => {
  let hasData = false; 
  try {
    await socket.readable.pipeTo(new WritableStream({
      write: (chunk) => {
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          throw new Error('WebSocket closed');
        }       
        const data = resHeader 
          ? new Uint8Array([...resHeader, ...chunk])
          : chunk;         
        webSocket.send(data);
        resHeader = null;
        hasData = true;
      }
    }));
  } catch {
    closeWebSocket(webSocket);
  }
  return hasData;
};
const writeToSocket = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};
const createStream = (webSocket, earlyDataHeader) => {
  let cancelled = false; 
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', event => {
        if (!cancelled) controller.enqueue(event.data);
      });
      webSocket.addEventListener('close', () => {
        closeWebSocket(webSocket);
        if (!cancelled) controller.close();
      });
      webSocket.addEventListener('error', err => controller.error(err));
      const { earlyData, error } = parseBase64(earlyDataHeader);
      if (error) controller.error(error);
      else if (earlyData) controller.enqueue(earlyData);
    },
    cancel() {
      cancelled = true;
      closeWebSocket(webSocket);
    }
  });
};
const processHeader = (buffer, userID) => {
  if (buffer.byteLength < 24) return { hasError: true };
  const version = new Uint8Array(buffer.slice(0, 1));
  const userIDBytes = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
  const bufferUserID = new Uint8Array(buffer.slice(1, 17));
  if (bufferUserID.some((byte, index) => byte !== userIDBytes[index])) {
    return { hasError: true };
  }
  const optLength = new Uint8Array(buffer.slice(17, 18))[0];
  const command = new Uint8Array(buffer.slice(18 + optLength, 18 + optLength + 1))[0];
  const isUDP = command === 2;
  if (!isUDP && command !== 1) return { hasError: true };
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(buffer.slice(portIndex, portIndex + 2)).getUint16(0);
  const addressIndex = portIndex + 2;
  const addressType = new Uint8Array(buffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1: // IPv4
      addressLength = 4;
      addressValue = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2: // Domain
      addressLength = new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3: // IPv6
      addressLength = 16;
      const ipv6Parts = [];
      const ipv6View = new DataView(buffer.slice(addressValueIndex, addressValueIndex + addressLength));
      for (let i = 0; i < 8; i++) {
        ipv6Parts.push(ipv6View.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6Parts.join(':');
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
    isUDP
  };
};
const parseBase64 = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: bytes.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = (socket) => {
  if ([WS_READY_STATE_OPEN, WS_READY_STATE_CLOSING].includes(socket.readyState)) {
    socket.close();
  }
};
const getConfig = (userID, hostName) => 
  `res://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
