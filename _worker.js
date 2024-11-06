import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      return isWebSocket ? handleWsRequest(request, userID, proxyIP) : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttpRequest = (request, userID) => {
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
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [clientSocket, serverSocket] = new WebSocketPair();
  serverSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(serverSocket, earlyDataHeader);
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  const responseHeader = new Uint8Array(2);
  const writableStream = new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      if (remoteSocket.value) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) return;
      responseHeader[0] = passVersion[0];
      responseHeader[1] = 0;
      const rawClientData = chunk.slice(rawDataIndex);
      isDns = isUDP && port === 53;
      if (isDns) {
        const { write } = await handleUdpRequest(serverSocket, responseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTcpRequest(remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP);
    }
  });
  readableStream.pipeTo(writableStream);
  return new Response(null, { status: 101, webSocket: clientSocket });
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (remoteSocket.value?.closed === false) {
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return remoteSocket.value;
  }
  const socket = await Promise.race([
    connect({
      hostname: address,
      port,
      allowHalfOpen: true,
      secureTransport: "on"
    }),
    new Promise((resolve, reject) => setTimeout(() => reject(), 3000))
  ]);
  remoteSocket.value = socket;
  const writer = socket.writable.getWriter();
  await writer.write(rawClientData);
  writer.releaseLock();
  return socket;
};
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
  const tryConnect = async (address, port) => {
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
      return await forwardToData(tcpSocket, serverSocket, responseHeader);
    } catch (error) {
      return false;
    }
  };
  if (!(await tryConnect(address, port) || await tryConnect(proxyIP, port))) {
    closeWebSocket(serverSocket);
  }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => { 
  const handleEvent = (event, controller) => {
    switch (event.type) {
      case 'message':
        controller.enqueue(event.data);
        break;
      case 'close':
        closeWebSocket(serverSocket);
        controller.close();
        break;
      case 'error':
        controller.error(event);
        break;
    }
  };
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      ['message', 'close', 'error'].forEach(type => 
        serverSocket.addEventListener(type, event => handleEvent(event, controller))
      );
    },
    cancel() {
      closeWebSocket(serverSocket);
    }
  });
};
class WebSocketHeader {
  constructor(hasError, address, port, rawDataIndex, passVersion, isUDP) {
    this.hasError = hasError;
    this.address = address;
    this.port = port;
    this.rawDataIndex = rawDataIndex;
    this.passVersion = passVersion;
    this.isUDP = isUDP;
  }
}
const processWebSocketHeader = (buffer, userID) => {
  const bytes = new Uint8Array(buffer);
  const receivedID = stringify(bytes.subarray(1, 17));
  if (receivedID !== userID) return new WebSocketHeader(true); 
  const optLength = bytes[17];
  const commandStartIndex = 18 + optLength;
  const command = bytes[commandStartIndex];
  const isUDP = command === 2;
  const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
  const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
  return new WebSocketHeader(false, address, port, rawDataIndex, bytes.subarray(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
  const addressType = bytes[startIndex];
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
  const addressValue = addressType === 1
    ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
    : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');
  return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const bufferPool = [];
const defaultBufferSize = 4096;
const getBuffer = (requiredSize) => {
  let buffer;
  for (let i = 0; i < bufferPool.length; i++) {
    if (bufferPool[i].byteLength >= requiredSize) {
      buffer = bufferPool.splice(i, 1)[0];
      break;
    }
  }
  if (!buffer) {
    buffer = new Uint8Array(requiredSize);
  }
  return buffer;
};
const returnBuffer = (buffer) => {
  bufferPool.push(buffer);
};
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
  let hasData = false;
  let headerSent = responseHeader !== null;
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (serverSocket.readyState !== WebSocket.OPEN) {
        controller.error('serverSocket is closed');
      }
      const buffer = getBuffer();
      if (headerSent) {
        const combinedLength = responseHeader.byteLength + chunk.byteLength;
        if (buffer.byteLength < combinedLength) {
          returnBuffer(buffer); // Release buffer if insufficient size
          buffer = new Uint8Array(combinedLength); // Allocate new buffer
        }
        buffer.set(responseHeader);
        buffer.set(new Uint8Array(chunk), responseHeader.byteLength);
      } else {
        buffer.set(chunk);
      }
      serverSocket.send(buffer);
      headerSent = false;
      hasData = true;
      returnBuffer(buffer); // Return buffer to pool after use
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(serverSocket);
  }
  return hasData;
};
const base64ToBuffer = (base64Str) => {
    try {
        if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
            return { earlyData: base64Str, error: null };
        }
        const binaryStr = atob(base64Str.replace(/[-_]/g, (match) => (match === '-' ? '+' : '/')));
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
};
const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};
const byteToHexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    const result = [];
    for (const len of segments) {
        let str = '';
        for (let i = 0; i < len; i++) {
            str += byteToHexTable[arr[offset++]];
        }
        result.push(str);
    }
    return result.join('-').toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        const dnsQueryResult = await handleDNSRequest(udpData);
        const udpSize = dnsQueryResult.byteLength;
        const combinedLength = responseHeader.byteLength + 2 + udpSize;
        const buffer = getBuffer(combinedLength);
        buffer.set(responseHeader);
        const sizeBufferOffset = responseHeader.byteLength;
        buffer.set([ (udpSize >> 8) & 0xff, udpSize & 0xff ], sizeBufferOffset);
        buffer.set(new Uint8Array(dnsQueryResult), sizeBufferOffset + 2);
        serverSocket.send(buffer);
        headerSent = true;
        returnBuffer(buffer);
      }
      controller.close();
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      controller.enqueue(chunk);
    }
  }));
  const writer = transformStream.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};
const handleDNSRequest = async (queryPacket) => {
  const response = await fetch("https://1.1.1.1/dns-query", {
    method: "POST",
    headers: {
      accept: "application/dns-message",
      "content-type": "application/dns-message",
    },
    body: queryPacket,
  });
  return response.arrayBuffer();
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
