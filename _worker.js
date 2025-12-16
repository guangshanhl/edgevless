import { connect } from 'cloudflare:sockets';

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get('Upgrade');
    const myID = env.MYID || DEFAULT_UUID;

    if (upgradeHeader === 'websocket') {
      return handleWebSocket(request, myID, env.OWNIP);
    }

    const url = new URL(request.url);
    switch (url.pathname) {
      case '/':
        return new Response(JSON.stringify(request.cf), { status: 200 });
      case `/${myID}`:
        return new Response(getConfig(myID, request.headers.get('Host')), {
          status: 200,
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        });
      default:
        return new Response('Not found', { status: 404 });
    }
  },
};

async function handleWebSocket(request, myID, ownIP) {
  const { 0: client, 1: server } = new WebSocketPair();
  server.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const { earlyData, error } = base64ToBuffer(earlyDataHeader);

  if (error) {
    server.close(1002, 'Invalid Early Data');
    return new Response(null, { status: 101, webSocket: client });
  }

  const readableStream = makeReadableWebSocketStream(server, earlyData);
  let vlessHeaderProcessed = false;
  let remoteConnection = null;

  const vlessTransformer = new WritableStream({
    async write(chunk, controller) {
      if (vlessHeaderProcessed) {
        if (remoteConnection) {
          await remoteConnection.write(chunk);
        }
        return;
      }

      const headerInfo = parseVlessHeader(chunk, myID);
      if (headerInfo.error) {
        console.error(`[VLESS] Header parsing failed: ${headerInfo.error}`);
        server.close();
        return;
      }

      vlessHeaderProcessed = true;
      const { address, port, isUDP, rawDataIndex, version } = headerInfo;
      
      const responseHeader = new Uint8Array([version, 0]); 
      const remainingData = chunk.subarray(rawDataIndex);

      if (isUDP) {
        if (port !== 53) {
          console.log(`[VLESS] UDP blocked for port ${port}`);
          server.close(); 
          return;
        }
        await handleUDP(server, remainingData, responseHeader);
        return; 
      }

      try {
        remoteConnection = await establishTcpConnection(address, port, remainingData, server, responseHeader, ownIP);
      } catch (err) {
        console.error(`[VLESS] TCP Connect failed: ${err.message}`);
        server.close();
      }
    },
    close() {
       if (remoteConnection) remoteConnection.close();
    },
    abort(reason) {
       console.error(`[VLESS] Stream aborted: ${reason}`);
       if (remoteConnection) remoteConnection.close();
    }
  });

  readableStream.pipeTo(vlessTransformer).catch((err) => {
    console.error(`[PipeTo Error] ${err}`);
    server.close();
  });

  return new Response(null, { status: 101, webSocket: client });
}

function parseVlessHeader(buffer, myID) {
  if (buffer.byteLength < 24) return { error: 'Data too short' };

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const version = view.getUint8(0);
  
  const providedUuidBytes = new Uint8Array(buffer.buffer, buffer.byteOffset + 1, 16);
  if (!isValidUUID(providedUuidBytes, myID)) {
    return { error: 'Invalid UUID' };
  }

  const addonLength = view.getUint8(17);
  const command = view.getUint8(18 + addonLength); 
  const isUDP = command === 2;
  
  if (command !== 1 && command !== 2) {
    return { error: `Unsupported command: ${command}` };
  }

  const port = view.getUint16(19 + addonLength, false); // Big Endian
  
  let addrIndex = 21 + addonLength;
  const addrType = view.getUint8(addrIndex++);
  let address = '';
  let addrEndIndex = 0;

  try {
    switch (addrType) {
      case 1: // IPv4
        address = `${view.getUint8(addrIndex)}.${view.getUint8(addrIndex+1)}.${view.getUint8(addrIndex+2)}.${view.getUint8(addrIndex+3)}`;
        addrEndIndex = addrIndex + 4;
        break;
      case 2: // Domain
        const domainLen = view.getUint8(addrIndex);
        addrIndex++;
        address = new TextDecoder().decode(buffer.subarray(addrIndex, addrIndex + domainLen));
        addrEndIndex = addrIndex + domainLen;
        break;
      case 3: // IPv6
        const parts = [];
        for (let i = 0; i < 8; i++) {
          parts.push(view.getUint16(addrIndex + i * 2, false).toString(16));
        }
        address = parts.join(':');
        addrEndIndex = addrIndex + 16;
        break;
      default:
        return { error: `Unknown address type: ${addrType}` };
    }
  } catch (e) {
    return { error: 'Address parse error' };
  }

  return {
    version,
    isUDP,
    port,
    address,
    rawDataIndex: addrEndIndex
  };
}

async function establishTcpConnection(address, port, initialData, webSocket, responseHeader, ownIP) {
  const connectWithRetry = async (host) => {
    const socket = connect({ hostname: host, port: port });
    const writer = socket.writable.getWriter();
    await writer.write(initialData);
    writer.releaseLock();
    return socket;
  };

  let socket;
  try {
    socket = await connectWithRetry(address);
  } catch (error) {
    if (ownIP) {
      try {
        socket = await connectWithRetry(ownIP);
      } catch (e) {
        throw error;
      }
    } else {
      throw error;
    }
  }

  let headerSent = false;
  
  socket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== WS_READY_STATE_OPEN) return;
      
      if (!headerSent) {
        const combined = new Uint8Array(responseHeader.length + chunk.length);
        combined.set(responseHeader);
        combined.set(chunk, responseHeader.length);
        webSocket.send(combined);
        headerSent = true;
      } else {
        webSocket.send(chunk);
      }
    }
  })).catch(() => {
  }).finally(() => {
    safeCloseWebSocket(webSocket);
  });

  const remoteWriter = socket.writable.getWriter();
  return {
    write: async (chunk) => {
       if (socket.writable.locked) return;
       await remoteWriter.write(chunk);
    },
    close: () => {
        try { remoteWriter.close(); } catch(e){}
    }
  };
}

async function handleUDP(webSocket, initialData, responseHeader) {
  let headerSent = false;

  let buffer = initialData;
  
  const processChunk = async (chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (chunk.byteLength - offset < 2) break;
      const view = new DataView(chunk.buffer, chunk.byteOffset + offset, chunk.byteLength - offset);
      const packetLen = view.getUint16(0);
      
      if (chunk.byteLength - offset < 2 + packetLen) break;
      
      const dnsPayload = chunk.subarray(offset + 2, offset + 2 + packetLen);
      offset += 2 + packetLen;

      try {
        const dohResp = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: dnsPayload,
        });
        
        const dnsResult = new Uint8Array(await dohResp.arrayBuffer());
        
        const lenHeader = new Uint8Array(2);
        new DataView(lenHeader.buffer).setUint16(0, dnsResult.byteLength, false);
        
        const totalLen = (headerSent ? 0 : responseHeader.length) + 2 + dnsResult.byteLength;
        const resultBuffer = new Uint8Array(totalLen);
        
        let writeOffset = 0;
        if (!headerSent) {
          resultBuffer.set(responseHeader, 0);
          writeOffset += responseHeader.length;
          headerSent = true;
        }
        resultBuffer.set(lenHeader, writeOffset);
        resultBuffer.set(dnsResult, writeOffset + 2);

        if (webSocket.readyState === WS_READY_STATE_OPEN) {
          webSocket.send(resultBuffer);
        }
      } catch (e) {
        console.error('DNS Query failed', e);
      }
    }
  };

  await processChunk(buffer);

}

function makeReadableWebSocketStream(webSocket, earlyData) {
  return new ReadableStream({
    start(controller) {
      if (earlyData) controller.enqueue(earlyData);
      
      webSocket.addEventListener('message', (event) => {
        try {
          const data = event.data;
          if (data instanceof ArrayBuffer) {
            controller.enqueue(new Uint8Array(data));
          } else if (typeof data === 'string') {
             controller.enqueue(new TextEncoder().encode(data));
          }
        } catch (e) {
          controller.error(e);
        }
      });

      webSocket.addEventListener('close', () => {
         try { controller.close(); } catch(e) {}
      });
      webSocket.addEventListener('error', (e) => controller.error(e));
    },
    cancel() {
      safeCloseWebSocket(webSocket);
    }
  });
}

let uuidCache = null;
let uuidStringCache = null;

function isValidUUID(bytes, uuidString) {
  if (uuidString !== uuidStringCache) {
    uuidStringCache = uuidString;
    uuidCache = new Uint8Array(uuidString.replace(/-/g, '').match(/../g).map(b => parseInt(b, 16)));
  }
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== uuidCache[i]) return false;
  }
  return true;
}

function base64ToBuffer(base64Str) {
  if (!base64Str) return { earlyData: null, error: null };
  try {
    const formatted = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(formatted);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: bytes, error: null };
  } catch (e) {
    return { error: e };
  }
}

function safeCloseWebSocket(ws) {
  try {
    if (ws.readyState === WS_READY_STATE_OPEN || ws.readyState === WS_READY_STATE_CLOSING) {
      ws.close();
    }
  } catch (e) {}
}

function getConfig(myID, hostName) {
  return `vless://${myID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
}
