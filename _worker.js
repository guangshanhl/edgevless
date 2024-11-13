import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env) {
    try {
      const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
      const proxyIP = env.PROXYIP || '';
      
      if(request.headers.get('Upgrade') === 'websocket') {
        return handleWs(request, userID, proxyIP);
      }
      return handleHttp(request, userID);
    } catch (err) {
      return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
    }
  }
};

const handleHttp = async (request, userID) => {
  const url = new URL(request.url);
  try {
    switch (url.pathname) {
      case '/':
        return new Response(JSON.stringify(request.cf, null, 4), { 
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      case `/${userID}`:
        return new Response(getConfig(userID, request.headers.get('Host')), {
          status: 200,
          headers: { "Content-Type": "text/plain;charset=utf-8" }
        });
      default:
        return new Response('Not found', { status: 404 });
    }
  } catch (err) {
    return new Response('Server Error', { status: 500 });
  }
};

const handleWs = async (request, userID, proxyIP) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  
  try {
    webSocket.accept();
    
    const protocol = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWstream(webSocket, protocol);
    let remoteSocket = { value: null };

    await readableStream.pipeTo(new WritableStream({
      async write(chunk) {
        if (!chunk || !chunk.byteLength) return;
        
        if (remoteSocket.value) {
          return await writeToRemote(remoteSocket.value, chunk);
        }

        const headerInfo = processHeader(chunk, userID);
        if (headerInfo.hasError) {
          throw new Error('Invalid header');
        }

        const responseHeader = new Uint8Array([headerInfo.isVersion[0], 0]);
        const clientData = chunk.slice(headerInfo.rawDataIndex);

        if (headerInfo.isUDP && headerInfo.portRemote === 53) {
          await handleUDP(webSocket, responseHeader, clientData);
        } else {
          await handleTCP(remoteSocket, headerInfo.addressRemote, proxyIP, 
                         headerInfo.portRemote, clientData, webSocket, responseHeader);
        }
      },
      close() {
        closeWebSocket(webSocket);
        if (remoteSocket.value) {
          remoteSocket.value.close();
        }
      }
    }));

    return new Response(null, { 
      status: 101, 
      webSocket: client 
    });

  } catch (err) {
    closeWebSocket(webSocket);
    return new Response(`WebSocket Error: ${err.message}`, { status: 500 });
  }
};

const writeToRemote = async (socket, chunk) => {
  if (!socket || socket.closed) return;
  
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};

const handleTCP = async (remoteSocket, addressRemote, proxyIP, portRemote, clientData, webSocket, responseHeader) => {
  const tryConnect = async (address, port) => {
    if (!address || !port) return false;
    
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, address, port, clientData);
      return tcpSocket ? await forwardToData(tcpSocket, webSocket, responseHeader) : false;
    } catch {
      return false;
    }
  };

  if (!(await tryConnect(addressRemote, portRemote) || await tryConnect(proxyIP, portRemote))) {
    closeWebSocket(webSocket);
  }
};

const connectAndWrite = async (remoteSocket, address, port, clientData) => {
  try {
    if (!remoteSocket.value || remoteSocket.value.closed) {
      remoteSocket.value = await connect({ 
        hostname: address, 
        port,
        timeout: 5000
      });
    }
    
    await writeToRemote(remoteSocket.value, clientData);
    return remoteSocket.value;
  } catch {
    return null;
  }
};

const createWstream = (webSocket, earlyDataHeader) => {
  let isCancelled = false;

  return new ReadableStream({
    start(controller) {
      try {
        const { earlyData, error } = base64ToBuffer(earlyDataHeader);
        if (error) throw error;
        if (earlyData) controller.enqueue(earlyData);

        webSocket.addEventListener('message', event => {
          if (!isCancelled && event.data) {
            controller.enqueue(event.data);
          }
        });

        webSocket.addEventListener('close', () => {
          controller.close();
        });

        webSocket.addEventListener('error', err => {
          controller.error(err);
        });
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      isCancelled = true;
      closeWebSocket(webSocket);
    }
  });
};

const processHeader = (buffer, userID) => {
  const data = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
  
  if (!data?.byteLength || data.byteLength < 24) {
    return { hasError: true };
  }

  try {
    const view = new DataView(data);
    const headerUserID = stringify(new Uint8Array(data.slice(1, 17)));
    
    if (headerUserID !== userID) {
      return { hasError: true };
    }

    const optLength = view.getUint8(17);
    const command = view.getUint8(18 + optLength);
    const version = new Uint8Array(data.slice(0, 1));
    const portRemote = view.getUint16(18 + optLength + 1);
    const addressIndex = 18 + optLength + 3;
    const addressType = view.getUint8(addressIndex);
    const addressLength = addressType === 2 ? view.getUint8(addressIndex + 1) : 
                         addressType === 1 ? 4 : 16;
    const addressValueIndex = addressIndex + (addressType === 2 ? 2 : 1);

    let addressValue;
    switch (addressType) {
      case 1:
        addressValue = Array.from(new Uint8Array(data, addressValueIndex, 4)).join('.');
        break;
      case 2:
        addressValue = new TextDecoder().decode(new Uint8Array(data, addressValueIndex, addressLength));
        break;
      case 3:
        addressValue = Array.from(new Uint8Array(data, addressValueIndex, 16))
          .map(b => b.toString(16).padStart(2, '0')).join(':');
        break;
      default:
        return { hasError: true };
    }

    return {
      hasError: false,
      addressRemote: addressValue,
      portRemote,
      rawDataIndex: addressValueIndex + addressLength,
      isVersion: version,
      isUDP: command === 2
    };
  } catch {
    return { hasError: true };
  }
};

const forwardToData = async (remoteSocket, webSocket, responseHeader) => {
  if (!remoteSocket || remoteSocket.closed || webSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(webSocket);
    return false;
  }

  let hasData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (!chunk || !chunk.byteLength) return;
        
        hasData = true;
        const dataToSend = responseHeader
          ? new Uint8Array([...responseHeader, ...new Uint8Array(chunk)]).buffer
          : chunk;
        
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(dataToSend);
        }
        responseHeader = null;
      }
    }));
  } catch {
    closeWebSocket(webSocket);
  }

  return hasData;
};

const handleUDP = async (webSocket, responseHeader, clientData) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const dnsFetch = async (chunk) => {
    try {
      const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
        signal: controller.signal
      });
      return response.arrayBuffer();
    } finally {
      clearTimeout(timeout);
    }
  };

  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        try {
          const dnsResult = await dnsFetch(chunk.slice(index + 2, index + 2 + udpPacketLength));
          const udpSizeBuffer = new Uint8Array([
            (dnsResult.byteLength >> 8) & 0xff, 
            dnsResult.byteLength & 0xff
          ]);

          if (webSocket.readyState === WebSocket.OPEN) {
            webSocket.send(new Uint8Array([
              ...responseHeader, 
              ...udpSizeBuffer, 
              ...new Uint8Array(dnsResult)
            ]).buffer);
          }
        } catch (err) {
          console.error('DNS query failed:', err);
        }
        index += 2 + udpPacketLength;
      }
    }
  });

  const writer = transformStream.writable.getWriter();
  await writer.write(clientData);
  writer.close();
};

const base64ToBuffer = base64Str => {
  if (!base64Str) return { earlyData: null, error: null };
  
  try {
    const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(normalizedStr);
    const buffer = new Uint8Array(binaryStr.length);
    
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};

const closeWebSocket = socket => {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING)) {
    try {
      socket.close();
    } catch {}
  }
};

const byteToHex = Array.from({ length: 256 }, (_, i) => 
  (i + 256).toString(16).slice(1)
);

const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  return segments
    .map(len => Array.from({ length: len }, () => 
      byteToHex[arr[offset++]]).join('')
    )
    .join('-')
    .toLowerCase();
};

const getConfig = (userID, hostName) => 
  `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
