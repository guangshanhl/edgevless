import { connect } from 'cloudflare:sockets';
const WS_READY_STATES = {
  OPEN: WebSocket.OPEN,
  CLOSING: WebSocket.CLOSING
};
const BASE64_REGEX = /[-_]/g;
const BASE64_REPLACE_MAP = {
  '-': '+',
  '_': '/'
};
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';   
    try {
      return request.headers.get('Upgrade') === 'websocket' 
        ? handleWs(request, userID, proxyIP)
        : handleHttp(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttp = (request, userID) => {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === "/") {
    return new Response(JSON.stringify(request.cf, null, 4));
  }
  if (path === `/${userID}`) {
    return new Response(
      getConfig(userID, request.headers.get("Host")), 
      {headers: {"Content-Type": "text/plain;charset=utf-8"}}
    );
  }
  return new Response("Not found", {status: 404});
};

const handleWs = async (request, userID, proxyIP) => {
  const [client, webSocket] = new WebSocketPair();
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWSStream(webSocket, earlyHeader);
  const context = {
    remoteSocket: null,
    udpWrite: null,
    isDns: false
  };
  const resHeader = new Uint8Array(2);
  const writableStream = new WritableStream({
    async write(chunk) {
      if (context.isDns && context.udpWrite) {
        return context.udpWrite(chunk);
      }
      if (context.remoteSocket) {
        const writer = context.remoteSocket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const result = processWSHeader(chunk, userID);
      if (result.hasError) return;
      resHeader[0] = result.passVersion[0];
      resHeader[1] = 0;
      const clientData = chunk.slice(result.rawDataIndex);
      context.isDns = result.isUDP && result.port === 53;
      if (context.isDns) {
        const { write } = await handleUdp(webSocket, resHeader);
        context.udpStreamWrite = write;
        context.udpStreamWrite(clientData);
        return;
      }
      handleTcp(context, result.address, result.port, clientData, webSocket, resHeader, proxyIP);
    }
  });
  readableStream.pipeTo(writableStream).catch(() => closeWebSocket(webSocket));
  return new Response(null, {status: 101, webSocket: client});
};
const connectAndWrite = async (context, addr, port, clientData) => {
  if (context.remoteSocket?.closed === false) {
    const writer = context.remoteSocket.writable.getWriter();
    await writer.write(clientData);
    writer.releaseLock();
    return context.remoteSocket;
  }
  context.remoteSocket = connect({
    hostname: addr,
    port,
    allowHalfOpen: false,
    secureTransport: 'on'
  });
  const writer = context.remoteSocket.writable.getWriter();
  await writer.write(clientData);
  writer.releaseLock();
  return context.remoteSocket;
};
const handleTcp = async (context, address, port, clientData, webSocket, resHeader, proxyIP) => {
  const tryConnect = async (addr) => {
    const tcpSocket = await connectAndWrite(context, addr, port, clientData);
    return tcpSocket ? forwardToData(tcpSocket, webSocket, resHeader) : false;
  };
  if (!(await tryConnect(address) || await tryConnect(proxyIP))) {
    closeWebSocket(webSocket);
  }
};
const createWSStream = (webSocket, earlyHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);     
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      const eventHandlers = {
        message: event => controller.enqueue(event.data),
        close: () => {
          closeWebSocket(webSocket);
          controller.close();
        },
        error: event => controller.error(event)
      };
      Object.entries(eventHandlers).forEach(([type, handler]) => 
        webSocket.addEventListener(type, handler)
      );
    },
    cancel() {
      closeWebSocket(webSocket);
    }
  });
};
const processWSHeader = (buffer, userID) => {
  const bytes = new Uint8Array(buffer);
  const receivedID = stringify(bytes.subarray(1, 17)); 
  if (receivedID !== userID) {
    return { hasError: true };
  }
  const optLength = bytes[17];
  const commandStartIndex = 18 + optLength;
  const command = bytes[commandStartIndex];
  const port = new DataView(bytes.buffer).getUint16(commandStartIndex + 1);
  return {
    hasError: false,
    isUDP: command === 2,
    port,
    ...getAddressInfo(bytes, commandStartIndex + 3),
    passVersion: bytes.subarray(0, 1)
  };
};
const addressTypeHandlers = new Map([
  [1, bytes => Array.from(bytes).join('.')],
  [2, bytes => new TextDecoder().decode(bytes)],
  [3, bytes => Array.from(bytes).map(b => byteToHexTable[b]).join(':')]
]);
const getAddressInfo = (bytes, startIndex) => {
  const addressType = bytes[startIndex];
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
  const addressBytes = bytes.subarray(addressValueIndex, addressValueIndex + addressLength); 
  const handler = addressTypeHandlers.get(addressType);
  return {
    address: handler(addressBytes),
    rawDataIndex: addressValueIndex + addressLength
  };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  let headerSent = resHeader !== null;
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (webSocket.readyState !== WS_READY_STATES.OPEN) {
        controller.error('WebSocket is closed');
      }
      if (headerSent) {
        const combined = new Uint8Array(resHeader.byteLength + chunk.byteLength);
        combined.set(resHeader);
        combined.set(new Uint8Array(chunk), resHeader.byteLength);
        webSocket.send(combined);
        headerSent = false;
      } else {
        webSocket.send(chunk);
      }
      hasData = true;
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(webSocket);
  }
  return hasData;
};
const base64ToBuffer = (base64Str) => {
  if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
    return { earlyData: base64Str, error: null };
  }
  try {
    const binaryStr = atob(base64Str.replace(BASE64_REGEX, match => BASE64_REPLACE_MAP[match]));
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      buffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = (webSocket) => {
  if (webSocket.readyState === WS_READY_STATES.OPEN || 
      webSocket.readyState === WS_READY_STATES.CLOSING) {
    webSocket.close();
  }
};
const byteToHexTable = new Uint8Array(256).map((_, i) => 
  ((i + 0x100).toString(16).substr(1))).join('');
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
const handleUdp = async (webSocket, resHeader) => {
  const buffer = [];
  let headerSent = false;
  const processUdpChunks = async (chunks, socket, header, sentHeader) => {
    for (const chunk of chunks) {
      const dnsResponse = await dnsClient.query(chunk);
      if (!dnsResponse) continue;
      const responseSize = dnsResponse.byteLength;
      const sizeBuffer = new Uint8Array([(responseSize >> 8) & 0xff, responseSize & 0xff]);     
      const dataToSend = !sentHeader
        ? Buffer.concat([header, sizeBuffer, new Uint8Array(dnsResponse)])
        : Buffer.concat([sizeBuffer, new Uint8Array(dnsResponse)]);
      if (socket.readyState === WS_READY_STATES.OPEN) {
        socket.send(dataToSend);
      }
    }
  };
  return {
    async write(chunk) {
      buffer.push(chunk);
      if (buffer.length >= 64) {
        await processUdpChunks(buffer, webSocket, resHeader, headerSent);
        headerSent = true;
        buffer.length = 0;
      }
    }
  };
};
const dnsClient = {
  controller: null,
  cache: new Map(),
  async query(packet) {
    const key = new Uint8Array(packet).join(',');
    if (this.cache.has(key)) {
      return this.cache.get(key);
    }
    if (this.controller) {
      this.controller.abort();
    }
    this.controller = new AbortController();
    try {
      const response = await fetch("https://cloudflare-dns.com/dns-query", {
        method: "POST",
        headers: {
          accept: "application/dns-message",
          "content-type": "application/dns-message",
        },
        body: packet,
        signal: this.controller.signal
      });     
      const result = await response.arrayBuffer();
      this.cache.set(key, result);     
      if (this.cache.size > 1000) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
      }     
      return result;
    } catch (error) {
      if (error.name === 'AbortError') return null;
      throw error;
    }
  }
};
const getConfig = (userID, host) => {
  return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
