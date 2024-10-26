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
const wsCache = new Map();
const handleWsRequest = async (request, userID, proxyIP) => {
  let cachedSocket = wsCache.get(userID);
  if (cachedSocket && cachedSocket.readyState === WebSocket.OPEN) {
    return new Response(null, { status: 101, webSocket: cachedSocket.clientSocket });
  }
  const [clientSocket, serverSocket] = new WebSocketPair();
  serverSocket.accept();
  wsCache.set(userID, { clientSocket, serverSocket });
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(serverSocket, earlyDataHeader, userID);
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
const writeToRemote = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
  if (!remoteSocket.value || remoteSocket.value.closed) {
    remoteSocket.value = await connect({ hostname: address, port });
  }
  await writeToRemote(remoteSocket.value, rawClientData);
  return remoteSocket.value;
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
  if (!(await tryConnect(address, port)) && !(await tryConnect(proxyIP, port))) {
    closeWebSocket(serverSocket);
  }
};
const createWebSocketStream = (serverSocket, earlyDataHeader, userID) => {
  const handleEvent = (type, event, controller) => {
    switch (type) {
      case 'message':
        controller.enqueue(event.data);
        break;
      case 'close':
        closeWebSocket(serverSocket);
        controller.close();
        wsCache.delete(userID);
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
      serverSocket.addEventListener('message', event => handleEvent('message', event, controller));
      serverSocket.addEventListener('close', event => handleEvent('close', event, controller));
      serverSocket.addEventListener('error', event => handleEvent('error', event, controller));
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
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
  let hasData = false;
  let vlessHeader = responseHeader;
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      hasData = true;
      if (serverSocket.readyState !== WebSocket.OPEN) {
        controller.error('serverSocket is closed');
        return;
      }
      const dataToSend = vlessHeader 
        ? new Uint8Array([...vlessHeader, ...new Uint8Array(chunk)])
        : chunk;
      serverSocket.send(dataToSend);
      vlessHeader = null;
    },
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
    const formattedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(formattedStr);
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
  return segments.map(len => {
    const str = Array.from({ length: len }, () => byteToHexTable[arr[offset++]]).join('');
    return str;
  }).join('-').toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      const tasks = [];
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        tasks.push(
          handleDNSRequest(udpData).then(response => {
            const length = response.byteLength;
            const udpBuffer = new Uint8Array(2 + length);
            udpBuffer.set([length >> 8, length & 0xff]);
            udpBuffer.set(new Uint8Array(response), 2);
            const dataToSend = !headerSent
              ? new Uint8Array([...responseHeader, ...udpBuffer])
              : udpBuffer;
            serverSocket.send(dataToSend);
            headerSent = true;
          })
        );
      }
      await Promise.all(tasks);
      controller.terminate();
    },
  });
  return {
    write: (chunk) => transformStream.writable.getWriter().write(chunk)
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
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
