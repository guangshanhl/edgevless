import { connect } from 'cloudflare:sockets';

const CONSTANTS = {
  BUFFER_SIZE: 65536,
  WS_READY_STATE_OPEN: 1,
  WS_READY_STATE_CLOSING: 2,
  DEFAULT_UUID: 'd342d11e-d424-4583-b36e-524ab1f0afa4'
};

export default {
  async fetch(request, env, ctx) {
    const userID = env.UUID || CONSTANTS.DEFAULT_UUID;
    const proxyIP = env.PROXYIP || '';

    try {
      if (request.headers.get('Upgrade') === 'websocket') {
        return await handleWebSocket(request, userID, proxyIP);
      }

      const url = new URL(request.url);
      switch (url.pathname) {
        case '/':
          return new Response(JSON.stringify(request.cf), {
            headers: { 'Content-Type': 'application/json' }
          });
        case `/${userID}`:
          return new Response(
            `vless://${userID}@${request.headers.get('Host')}:8443?encryption=none&security=tls&sni=${request.headers.get('Host')}&fp=randomized&type=ws&host=${request.headers.get('Host')}&path=%2F%3Fed%3D2560#${request.headers.get('Host')}`,
            { headers: { 'Content-Type': 'text/plain;charset=utf-8' } }
          );
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      return new Response(err.toString());
    }
  }
};

async function handleWebSocket(request, userID, proxyIP) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  let remoteSocket = { value: null };
  let udpWriter = null;
  let isDns = false;

  const stream = makeReadableStream(server, earlyDataHeader);
  
  stream.pipeTo(new WritableStream({
    async write(chunk) {
      if (isDns && udpWriter) {
        for (const data of chunkData(chunk)) {
          udpWriter(data);
        }
        return;
      }

      if (remoteSocket.value) {
        await writeToSocket(remoteSocket.value, chunk);
        return;
      }

      const { hasError, portRemote = 8443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = 
        parseHeader(chunk, userID);

      if (hasError) return;

      const header = new Uint8Array([ressVersion, 0]);
      const data = chunk.slice(rawDataIndex);

      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
          const { write } = await setupUDPConnection(server, header);
          udpWriter = write;
          udpWriter(data);
        }
        return;
      }

      await setupTCPConnection(addressRemote, portRemote, data, server, header, proxyIP);
    }
  })).catch(() => closeWebSocket(server));

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

// 实用函数
function makeReadableStream(webSocket, earlyData) {
  let active = true;
  
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', event => {
        if (!active) return;
        const chunks = chunkData(event.data);
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
      });

      webSocket.addEventListener('close', () => {
        if (!active) return;
        controller.close();
        active = false;
      });

      webSocket.addEventListener('error', err => {
        if (!active) return;
        controller.error(err);
        active = false;
      });

      if (earlyData) {
        try {
          const data = base64ToArrayBuffer(earlyData);
          if (data) controller.enqueue(data);
        } catch (e) {
          controller.error(e);
        }
      }
    },
    cancel() {
      active = false;
      closeWebSocket(webSocket);
    }
  });
}

function chunkData(data, size = CONSTANTS.BUFFER_SIZE) {
  const chunks = [];
  for (let i = 0; i < data.byteLength; i += size) {
    chunks.push(new Uint8Array(data.slice(i, i + size)));
  }
  return chunks;
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function closeWebSocket(socket) {
  if (socket.readyState < CONSTANTS.WS_READY_STATE_CLOSING) {
    socket.close();
  }
}

async function writeToSocket(socket, data) {
  const writer = socket.writable.getWriter();
  try {
    for (const chunk of chunkData(data)) {
      await writer.write(chunk);
    }
  } finally {
    writer.releaseLock();
  }
}

// 解析请求头
function parseHeader(ressBuffer, userID) {
  if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new DataView(ressBuffer, 0, 1).getUint8(0);
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = Uint8Array.from(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer, 1, 16);
    if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
        return { hasError: true };
    }
    const optLength = new DataView(ressBuffer, 17, 1).getUint8(0);
    const command = new DataView(ressBuffer, 18 + optLength, 1).getUint8(0);
    if (command === 2) {
        isUDP = true;
    } else if (command !== 1) {
        return { hasError: false };
    }
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer, portIndex, 2).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(ressBuffer, addressIndex, 1).getUint8(0);
    let addressValue = '';
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer, addressValueIndex, addressLength).join('.');
            break;
        case 2:
            addressLength = new DataView(ressBuffer, addressValueIndex, 1).getUint8(0);
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                new Uint8Array(ressBuffer, addressValueIndex, addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const ipv6Parts = new Uint16Array(ressBuffer, addressValueIndex, addressLength / 2);
            addressValue = Array.from(ipv6Parts, part => part.toString(16)).join(':');
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
}

// TCP连接处理
async function setupTCPConnection(address, port, data, webSocket, header, proxyIP) {
  async function connectAndWrite(addr) {
    const socket = connect({
      hostname: addr,
      port: port,
      secureTransport: "on",
      allowHalfOpen: true
    });
    await writeToSocket(socket, data);
    return socket;
  }

  let socket;
  try {
    socket = await connectAndWrite(address);
  } catch {
    if (proxyIP) {
      socket = await connectAndWrite(proxyIP);
    }
  }

  if (!socket) {
    closeWebSocket(webSocket);
    return;
  }

  let hasData = false;
  try {
    await socket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (webSocket.readyState === CONSTANTS.WS_READY_STATE_OPEN) {
          const finalChunk = header ? concatArrayBuffers(header, chunk) : chunk;
          header = null;
          
          for (const subChunk of chunkData(finalChunk)) {
            webSocket.send(subChunk);
          }
          hasData = true;
        }
      }
    }));
  } catch {
    closeWebSocket(webSocket);
  }

  return hasData;
}

async function setupUDPConnection(webSocket, header) {
  let headerSent = false;
  let partialData = null;
  
  const transform = new TransformStream({
    transform(chunk, controller) {
      if (partialData) {
        chunk = concatArrayBuffers(partialData, chunk);
        partialData = null;
      }
      
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (chunk.byteLength < offset + 2) {
          partialData = chunk.slice(offset);
          break;
        }

        const size = new DataView(chunk.buffer).getUint16(chunk.byteOffset + offset);
        const end = offset + 2 + size;
        
        if (chunk.byteLength < end) {
          partialData = chunk.slice(offset);
          break;
        }

        controller.enqueue(chunk.slice(offset + 2, end));
        offset = end;
      }
    }
  });

  transform.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const response = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/dns-message',
          'Accept': 'application/dns-message'
        },
        body: chunk
      });

      const result = await response.arrayBuffer();
      const sizeBuffer = new Uint8Array([
        (result.byteLength >> 8) & 0xff,
        result.byteLength & 0xff
      ]);

      const payload = headerSent 
        ? concatArrayBuffers(sizeBuffer, result)
        : concatArrayBuffers(header, sizeBuffer, result);
      
      headerSent = true;

      if (webSocket.readyState === CONSTANTS.WS_READY_STATE_OPEN) {
        webSocket.send(payload);
      }
    }
  })).catch(() => closeWebSocket(webSocket));

  const writer = transform.writable.getWriter();
  
  return {
    write(chunk) {
      for (const data of chunkData(chunk)) {
        writer.write(data);
      }
    }
  };
}

// 工具函数
function concatArrayBuffers(...buffers) {
  const total = buffers.reduce((len, buf) => len + buf.byteLength, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  
  for (const buffer of buffers) {
    result.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  
  return result;
}

