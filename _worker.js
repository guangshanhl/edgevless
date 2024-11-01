import { connect } from 'cloudflare:sockets';
const WS_READY_STATES = {
  OPEN: 1,
  CLOSING: 2
};
const BASE64_REGEX = /[-_]/g;
const BASE64_REPLACE_MAP = { '-': '+', '_': '/' };
const byteToHexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';    
    try {
      return request.headers.get('Upgrade') === 'websocket'
        ? handleWsRequest(request, userID, proxyIP)
        : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
function handleHttpRequest(request, userID) {
  const path = new URL(request.url).pathname; 
  if (path === "/") {
    return new Response(JSON.stringify(request.cf, null, 4));
  }  
  if (path === `/${userID}`) {
    const vlessConfig = getConfig(userID, request.headers.get("Host"));
    return new Response(vlessConfig, {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }  
  return new Response("Not found", { status: 404 });
}
async function handleWsRequest(request, userID, proxyIP) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWSStream(webSocket, earlyHeader);  
  const state = {
    remoteSocket: null,
    udpWrite: null
  };
  const writableStream = createWritableStream(webSocket, state, userID, proxyIP);
  readableStream.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  return new Response(null, { status: 101, webSocket: client });
}
function createWSStream(webSocket, earlyHeader) {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      ['message', 'close', 'error'].forEach(type =>
        webSocket.addEventListener(type, event => {
          switch (event.type) {
            case 'message':
              controller.enqueue(event.data);
              break;
            case 'close':
              closeWebSocket(webSocket);
              controller.close();
              break;
            case 'error':
              controller.error(event);
              break;
          }
        })
      );
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
}
function createWritableStream(webSocket, state, userID, proxyIP) {
  return new WritableStream({
    async write(chunk) {
      if (state.udpWrite) {
        return state.udpWrite(chunk);
      }
      if (state.remoteSocket) {
        return writeToRemote(state.remoteSocket, chunk);
      }
      const header = processWebSocketHeader(chunk, userID);
      if (header.hasError) return;
      const resHeader = new Uint8Array([header.passVersion[0], 0]);
      const clientData = chunk.slice(header.rawDataIndex);
      if (header.isUDP && header.port === 53) {
        const { write } = await handleUdpRequest(webSocket, resHeader);
        state.udpWrite = write;
        state.udpWrite(clientData);
        return;
      }
      await handleTcpRequest(state, header.address, header.port, clientData, webSocket, resHeader, proxyIP);
    }
  });
}
async function writeToRemote(socket, chunk) {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
async function handleTcpRequest(state, address, port, clientData, webSocket, resHeader, proxyIP) {
  const tryConnect = async (addr) => {
    try {
      if (!state.remoteSocket || state.remoteSocket.closed) {
        state.remoteSocket = await connect({ hostname: addr, port });
      }
      await writeToRemote(state.remoteSocket, clientData);
      return await forwardToData(state.remoteSocket, webSocket, resHeader);
    } catch {
      return false;
    }
  };
  if (!(await tryConnect(address)) && proxyIP && !(await tryConnect(proxyIP))) {
    closeWebSocket(webSocket);
  }
}
function processWebSocketHeader(buffer, userID) {
  const bytes = new Uint8Array(buffer);
  const receivedID = stringify(bytes.subarray(1, 17)); 
  if (receivedID !== userID) {
    return { hasError: true };
  }
  const optLength = bytes[17];
  const commandStartIndex = 18 + optLength;
  const command = bytes[commandStartIndex];
  const isUDP = command === 2;
  const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2]; 
  const addressInfo = getAddressInfo(bytes, commandStartIndex + 3); 
  return {
    hasError: false,
    address: addressInfo.address,
    port,
    rawDataIndex: addressInfo.rawDataIndex,
    passVersion: bytes.subarray(0, 1),
    isUDP
  };
}
function getAddressInfo(bytes, startIndex) {
  const addressType = bytes[startIndex];
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1); 
  let address;
  if (addressType === 1) {
    address = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.');
  } else if (addressType === 2) {
    address = new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength));
  } else {
    address = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
      .map(b => b.toString(16).padStart(2, '0'))
      .join(':');
  } 
  return {
    address,
    rawDataIndex: addressValueIndex + addressLength
  };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
  let hasData = false;
  let hasSent = Boolean(resHeader); 
  const writableStream = new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== WS_READY_STATES.OPEN) {
        throw new Error("WebSocket is closed.");
      }
      if (hasSent) {
        const combinedBuffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
        combinedBuffer.set(resHeader);
        combinedBuffer.set(new Uint8Array(chunk), resHeader.byteLength);
        webSocket.send(combinedBuffer);
        hasSent = false;
      } else {
        webSocket.send(chunk);
      }
      hasData = true;
    },
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch {
    closeWebSocket(webSocket);
  }

  return hasData;
}
function base64ToBuffer(base64Str) {
  try {
    if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
      return { earlyData: base64Str, error: null };
    }
    const binaryStr = atob(base64Str.replace(BASE64_REGEX, match => BASE64_REPLACE_MAP[match]));
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}
function closeWebSocket(webSocket) {
  if (webSocket.readyState === WS_READY_STATES.OPEN || webSocket.readyState === WS_READY_STATES.CLOSING) {
    webSocket.close();
  }
}
function stringify(arr, offset = 0) {
  const segments = [4, 2, 2, 2, 6];
  let pos = offset;
  return segments
    .map(len => {
      const segment = Array.from(arr.slice(pos, pos + len))
        .map(b => byteToHexTable[b])
        .join('');
      pos += len;
      return segment;
    })
    .join('-')
    .toLowerCase();
}
async function handleUdpRequest(webSocket, resHeader) {
  let hasSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        const dnsQueryResult = await handleDNSRequest(udpData);
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        const combinedLength = hasSent
          ? udpSizeBuffer.byteLength + udpSize
          : resHeader.byteLength + udpSizeBuffer.byteLength + udpSize;
        const dataToSend = new Uint8Array(combinedLength);
        if (!hasSent) {
          dataToSend.set(resHeader);
          dataToSend.set(udpSizeBuffer, resHeader.byteLength);
          dataToSend.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + udpSizeBuffer.byteLength);
          hasSent = true;
        } else {
          dataToSend.set(udpSizeBuffer);
          dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
        }
        if (webSocket.readyState === WS_READY_STATES.OPEN) {
          webSocket.send(dataToSend);
        }
      }
    }
  });
  return {
    write(chunk) {
      const writer = transformStream.writable.getWriter();
      writer.write(chunk).catch(() => {});
      writer.releaseLock();
    }
  };
}
async function handleDNSRequest(queryPacket) {
  const response = await fetch("https://1.1.1.1/dns-query", {
    method: "POST",
    headers: {
      accept: "application/dns-message",
      "content-type": "application/dns-message",
    },
    body: queryPacket,
  });
  return response.arrayBuffer();
}
function getConfig(userID, host) {
  return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
}


