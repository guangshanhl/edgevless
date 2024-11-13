import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';

    return request.headers.get('Upgrade') === 'websocket'
      ? handleWs(request, userID, proxyIP)
      : handleHttp(request, userID);
  }
};

const handleHttp = async (request, userID) => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/':
      return new Response(JSON.stringify(request.cf, null, 4), { status: 200 });
    case `/${userID}`:
      return new Response(getConfig(userID, request.headers.get('Host')), {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    default:
      return new Response('Not found', { status: 404 });
  }
};

const handleWs = async (request, userID, proxyIP) => {
  const pair = new WebSocketPair();
  const { 0: client, 1: server } = pair;
  server.accept();

  const remoteSocket = { value: null };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

  let readableStreamController;
  const readableStream = new ReadableStream({
    start(controller) {
      readableStreamController = controller;
      
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
        return;
      }
      
      if (earlyData) {
        controller.enqueue(earlyData);
      }

      server.addEventListener('message', (event) => {
        const chunk = new Uint8Array(event.data);
        controller.enqueue(chunk);
      });

      server.addEventListener('close', () => controller.close());
      server.addEventListener('error', (err) => controller.error(err));
    },
    pull(controller) {
      // 按需实现
    },
    cancel() {
      closeWebSocket(server);
    }
  });

  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      if (!chunk?.byteLength) return;
      
      const { hasError, addressRemote, portRemote, rawDataIndex, isVersion, isUDP } = processHeader(chunk);
      if (hasError) return;

      const responseHeader = new Uint8Array([isVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);

      if (isUDP && portRemote === 53) {
        await handleUDP(server, responseHeader, clientData);
        return;
      }

      if (remoteSocket.value) {
        await writeToRemote(remoteSocket.value, clientData);
        return;
      }

      await handleTCP(remoteSocket, addressRemote, proxyIP, portRemote, clientData, server, responseHeader);
    }
  });

  const writableStream = new WritableStream({
    async write(chunk) {
      if (server.readyState === WebSocket.OPEN) {
        server.send(chunk);
      }
    },
    close() {
      closeWebSocket(server);
    }
  });

  try {
    await readableStream
      .pipeThrough(transformStream)
      .pipeTo(writableStream);
  } catch (err) {
    closeWebSocket(server);
  }

  return new Response(null, {
    status: 101,
    webSocket: client
  });
};

// 其他辅助函数保持不变
const handleUDP = async (webSocket, responseHeader, clientData) => {
  let index = 0;
  while (index < clientData.byteLength) {
    const udpPacketLength = new DataView(clientData.buffer, index, 2).getUint16(0);
    const dnsResult = await fetchDNS(clientData.slice(index + 2, index + 2 + udpPacketLength));
    
    if (webSocket.readyState === WebSocket.OPEN) {
      const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
      webSocket.send(new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsResult)]));
    }
    
    index += 2 + udpPacketLength;
  }
};

const handleTCP = async (remoteSocket, addressRemote, proxyIP, portRemote, clientData, webSocket, responseHeader) => {
  const tryConnect = async (address, port) => {
    try {
      if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({
          hostname: address,
          port: Number(port)
        });
      }
      
      await writeToRemote(remoteSocket.value, clientData);
      return await forwardToData(remoteSocket.value, webSocket, responseHeader);
    } catch (err) {
      return false;
    }
  };

  if (!(await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote))) {
    closeWebSocket(webSocket);
  }
};

const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};

const forwardToData = async (remoteSocket, webSocket, responseHeader) => {
  if (webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return false;
  }

  let hasData = false;
  try {
    const reader = remoteSocket.readable.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      hasData = true;
      const dataToSend = responseHeader
        ? new Uint8Array([...responseHeader, ...new Uint8Array(value)])
        : value;
      
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.send(dataToSend);
      }
      responseHeader = null;
    }
  } catch {
    closeWebSocket(webSocket);
  }
  return hasData;
};

const fetchDNS = async (chunk) => {
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: chunk
  });
  return response.arrayBuffer();
};

const closeWebSocket = webSocket => {
  if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CLOSING) {
    webSocket.close();
  }
};

// 其他工具函数
const base64ToBuffer = base64Str => {
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64Str);
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const processHeader = (buffer) => {
  if (!buffer?.byteLength || buffer.byteLength < 24) return { hasError: true };

  const view = new DataView(buffer);
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  const version = new Uint8Array(buffer.slice(0, 1));
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressIndex = 18 + optLength + 3;
  const addressType = view.getUint8(addressIndex);
  const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : addressType === 1 ? 4 : 16;
  const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);

  let addressValue;
  switch (addressType) {
    case 1:
      addressValue = Array.from(new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 4))).join('.');
      break;
    case 2:
      addressValue = new TextDecoder().decode(new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + addressLength)));
      break;
    case 3:
      addressValue = Array.from(new Uint8Array(buffer.slice(addressValueIndex, addressValueIndex + 16)))
        .map(b => b.toString(16).padStart(2, '0'))
        .join(':');
      break;
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    isVersion: version,
    isUDP
  };
};

const getConfig = (userID, hostName) => 
  `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
