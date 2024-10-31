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
  if (path === '/') {
    return new Response(JSON.stringify(request.cf, null, 4));
  }
  if (path === `/${userID}`) {
    const vlessConfig = getConfig(userID, request.headers.get('Host'));
    return new Response(vlessConfig, {
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }
    });
  }
  return new Response('Not found', { status: 404 });
};
const handleWsRequest = async (request, userID, proxyIP) => {
  const [clientSocket, serverSocket] = new WebSocketPair();
  serverSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWebSocketStream(serverSocket, earlyDataHeader);
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  const writableStream = new WritableStream({
    async write(chunk) {
      if (udpStreamWrite) {
        udpStreamWrite(chunk);
        return;
      }
      if (remoteSocket.value) {
        await writeToRemote(remoteSocket.value, chunk);
        return;
      }
      const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWebSocketHeader(chunk, userID);
      if (hasError) return;
      const responseHeader = new Uint8Array([passVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isUDP && port === 53) {
        const { write } = await handleUdpRequest(serverSocket, responseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTcpRequest(remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP);
    }
  });
  await readableStream.pipeTo(writableStream);
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
const handleTcpRequest = async (remoteSocket, address, port, rawClientData, serverSocket, responseHeader, proxyIP) => {
  const tryConnection = async (addr) => {
    try {
      if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({ hostname: addr, port });
      }
      await writeToRemote(remoteSocket.value, rawClientData);
      return await forwardToData(remoteSocket.value, serverSocket, responseHeader);
    } catch (error) {
      return false;
    }
  };
  const isSuccessful = await tryConnection(address) || await tryConnection(proxyIP);
  if (!isSuccessful) {
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
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : addressType === 1 ? 4 : 16;
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
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (serverSocket.readyState !== WebSocket.OPEN) {
        controller.error('serverSocket is closed');
        return;
      }
      const dataToSend = responseHeader
        ? (() => {
            const combinedBuffer = new Uint8Array(responseHeader.byteLength + chunk.byteLength);
            combinedBuffer.set(responseHeader);
            combinedBuffer.set(new Uint8Array(chunk), responseHeader.byteLength);
            responseHeader = null;
            return combinedBuffer;
          })()
        : chunk;
      serverSocket.send(dataToSend);
      hasData = true;
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
    const formattedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(formattedStr);
    const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
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
const byteToHexTable = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  return [4, 2, 2, 2, 6]
    .map(len => Array.from({ length: len }, () => byteToHexTable[arr[offset++]]).join(''))
    .join('-')
    .toLowerCase();
};
const handleUdpRequest = async (serverSocket, responseHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      const tasks = [];
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        tasks.push(handleDNSRequest(udpData).then(dnsQueryResult => {
          const udpSize = dnsQueryResult.byteLength;
          const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
          const combinedLength = headerSent
            ? udpSizeBuffer.byteLength + udpSize
            : responseHeader.byteLength + udpSizeBuffer.byteLength + udpSize;
          const dataToSend = new Uint8Array(combinedLength);
          if (!headerSent) {
            dataToSend.set(responseHeader);
            dataToSend.set(udpSizeBuffer, responseHeader.byteLength);
            dataToSend.set(new Uint8Array(dnsQueryResult), responseHeader.byteLength + udpSizeBuffer.byteLength);
            headerSent = true;
          } else {
            dataToSend.set(udpSizeBuffer);
            dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
          }
          if (serverSocket.readyState === WebSocket.OPEN) {
            serverSocket.send(dataToSend);
          }
        }));
      }
      await Promise.all(tasks);
      controller.terminate();
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      transformStream.writable.getWriter().write(chunk).finally(() => {
        writer.releaseLock();
      });
    }
  }));
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
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
