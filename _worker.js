import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      return isWebSocket ? handleWsRequest(request, userID, proxyIP) : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response('Internal Server Error', { status: 500 });
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
  const [client, server] = new WebSocketPair();
  server.accept();
  const cleanup = () => {
    closeWebSocket(server);
    closeWebSocket(client);
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(server, earlyDataHeader);
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
        await writeToRemote(remoteSocket.value, chunk);
        return;
      }
      const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) {
        cleanup();
        return;
      }
      responseHeader[0] = passVersion[0];
      responseHeader[1] = 0;
      const rawClientData = chunk.slice(rawDataIndex);
      isDns = isUDP && port === 53;
      if (isDns) {
        const { write } = await handleUdpRequest(server, responseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTcpRequest(remoteSocket, address, port, rawClientData, server, responseHeader, proxyIP);
    }
  });
  readableStream.pipeTo(writableStream).catch(cleanup);
  return new Response(null, { status: 101, webSocket: client });
};
const handleUdpRequest = async (server, responseHeader) => {
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
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        let dataToSend;
        if (!headerSent) {
          dataToSend = new Uint8Array(responseHeader.byteLength + udpSizeBuffer.byteLength + udpSize);
          dataToSend.set(responseHeader);
          dataToSend.set(udpSizeBuffer, responseHeader.byteLength);
          dataToSend.set(new Uint8Array(dnsQueryResult), responseHeader.byteLength + udpSizeBuffer.byteLength);
          headerSent = true;
        } else {
          dataToSend = new Uint8Array(udpSizeBuffer.byteLength + udpSize);
          dataToSend.set(udpSizeBuffer);
          dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
        }

        if (server.readyState === WebSocket.OPEN) {
          server.send(dataToSend);
        }
      }
      controller.close();
    }
  });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
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
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = await connect({ hostname: address, port });
  }
  await writeToRemote(remoteSocket.value, rawClientData);
  return remoteSocket.value;
};
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, server, responseHeader, proxyIP) => {
  const tryConnect = async (address, port) => {
    try {
      const tcpSocket = await connectAndWrite(remoteSocket, address, port, rawClientData);
      return await forwardToData(tcpSocket, server, responseHeader);
    } catch (error) {
      return false;
    }
  };

  if (!(await tryConnect(address, port) || await tryConnect(proxyIP, port))) {
    closeWebSocket(server);
  }
};
const forwardToData = async (remoteSocket, server, responseHeader) => {
  let hasData = false;
  let headerSent = responseHeader !== null;
  const writableStream = new WritableStream({
    async write(chunk) {
      if (server.readyState !== WebSocket.OPEN) {
        controller.error('server is closed');
      }
      if (headerSent) {
        const combinedBuffer = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
        combinedBuffer.set(responseHeader);
        combinedBuffer.set(new Uint8Array(chunk), responseHeader.byteLength);
        server.send(combinedBuffer);
        headerSent = false;
      } else {
        server.send(chunk);
      }
      hasData = true;
    },
    close() {
      closeWebSocket(server);
    },
    abort(reason) {
      closeWebSocket(server);
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(server);
  }
  return hasData;
};
const createWebSocketStream = (server, earlyDataHeader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      ['message', 'close', 'error'].forEach(type =>
        server.addEventListener(type, event => {
          switch (event.type) {
            case 'message':
              controller.enqueue(event.data);
              break;
            case 'close':
              closeWebSocket(server);
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
      closeWebSocket(server);
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
  if (!buffer || buffer.byteLength < 18) {
    return new WebSocketHeader(true);
  }
  const bytes = new Uint8Array(buffer);
  const receivedID = stringify(bytes.subarray(1, 17)); 
  if (receivedID !== userID) return new WebSocketHeader(true);
  const optLength = bytes[17];
  const commandStartIndex = 18 + optLength;  
  if (commandStartIndex >= bytes.length) {
    return new WebSocketHeader(true);
  }
  const command = bytes[commandStartIndex];
  const isUDP = command === 2;
  const port = (bytes[commandStartIndex + 1] << 8) | bytes[commandStartIndex + 2];
  const { address, rawDataIndex } = getAddressInfo(bytes, commandStartIndex + 3);
  return new WebSocketHeader(false, address, port, rawDataIndex, bytes.subarray(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
  if (startIndex >= bytes.length) {
    throw new Error('Invalid address info start index');
  }
  const addressType = bytes[startIndex];
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
  const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
  if (addressValueIndex + addressLength > bytes.length) {
    throw new Error('Invalid address length');
  }
  const addressValue = addressType === 1
    ? Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
    : Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
        .map(b => b.toString(16).padStart(2, '0')).join(':');

  return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const closeWebSocket = (socket) => {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING)) {
    socket.close();
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
const base64ToBuffer = (base64Str) => {
    if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
        return { earlyData: base64Str, error: null };
    }
    if (!base64Str || typeof base64Str !== 'string') {
        return { earlyData: null, error: null };
    }
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);       
        const buffer = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
            buffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: buffer.buffer, error: null };
    } catch (error) {
        return { error: new Error('Invalid base64 string') };
    }
};
const getConfig = (userID, host) => {
  return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
