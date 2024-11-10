import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      const isSocket = request.headers.get('Upgrade') === 'websocket';
      return isSocket ? handleWs(request, userID, proxyIP) : handleHttp(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttp = (request, userID) => {
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
const handleWs = async (request, userID, proxyIP) => {
  const [clientSocket, serverSocket] = new WebSocketPair();
  serverSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWSStream(serverSocket, earlyHeader);
  let remoteSocket = { value: null };
  let udpWrite = null;
  let isDns = false;
  const resHeader = new Uint8Array(2);
  const writableStream = new WritableStream({
    async write(chunk) {
      if (isDns && udpWrite) {
        return udpWrite(chunk);
      }
      if (remoteSocket.value) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const { hasError, address, port, rawDataIndex, passVersion, isUDP } = processWSHeader(chunk, userID);
      if (hasError) return;
      resHeader[0] = passVersion[0];
      resHeader[1] = 0;
      const clientData = chunk.slice(rawDataIndex);
      isDns = isUDP && port === 53;
      if (isDns) {
        const { write } = await handleUdp(serverSocket, resHeader);
        udpStreamWrite = write;
        udpStreamWrite(clientData);
        return;
      }
      handleTcp(remoteSocket, address, port, clientData, serverSocket, resHeader, proxyIP);
    }
  });
  readableStream.pipeTo(writableStream);
  return new Response(null, { status: 101, webSocket: clientSocket });
};
const connectAndWrite = async (remoteSocket, addr, port, clientData) => {
  if (remoteSocket.value?.closed === false) {
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(clientData);
    writer.releaseLock();
    return remoteSocket.value;
  } else {
    remoteSocket.value = connect({
      hostname: addr,
      port,
      allowHalfOpen: false,
      secureTransport: 'on'
    });
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(clientData);
    writer.releaseLock();
    return remoteSocket.value;
  }
};
const handleTcp = async (remoteSocket, address, port, clientData, serverSocket, resHeader, proxyIP) => {
  const tryConnect = async (addr) => {
    const tcpSocket = await connectAndWrite(remoteSocket, addr, port, clientData);
    if (tcpSocket) {
      return forwardToData(tcpSocket, serverSocket, resHeader);
    } else {
      return false;
    }
  };
  if (!(await tryConnect(address) || await tryConnect(proxyIP))) {
    closeWS(serverSocket);
  }
};
const createWSStream = (serverSocket, earlyHeader) => {
  const handleEvent = (event, controller) => {
    switch (event.type) {
      case 'message':
        controller.enqueue(event.data);
        break;
      case 'close':
        closeWS(serverSocket);
        controller.close();
        break;
      case 'error':
        controller.error(event);
        break;
    }
  };
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyHeader);
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
      closeWS(serverSocket);
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
const processWSHeader = (buffer, userID) => {
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
const forwardToData = async (remoteSocket, serverSocket, resHeader) => {
  let hasData = false;
  let headerSent = resHeader !== null;
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (serverSocket.readyState !== WebSocket.OPEN) {
        controller.error('serverSocket is closed');
      }
      if (headerSent) {
        const combined = new Uint8Array(resHeader.byteLength + chunk.byteLength);
        combined.set(resHeader);
        combined.set(new Uint8Array(chunk), resHeader.byteLength);
        serverSocket.send(combined);
        headerSent = false;
      } else {
        serverSocket.send(chunk);
      }
      hasData = true;
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWS(serverSocket);
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
const closeWS = (serverSocket) => {
  if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
    serverSocket.close();
  }
};
const byteToHex = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
  const segments = [4, 2, 2, 2, 6];
  const result = [];
  for (const len of segments) {
    let str = '';
    for (let i = 0; i < len; i++) {
      str += byteToHex[arr[offset++]];
    }
    result.push(str);
  }
  return result.join('-').toLowerCase();
};
const handleUdp = async (serverSocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      let index = 0;
      while (index < chunk.byteLength) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        const dnsQueryResult = await handleDNS(udpData);
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        let dataToSend;
        if (!headerSent) {
          dataToSend = new Uint8Array(resHeader.byteLength + udpSizeBuffer.byteLength + udpSize);
          dataToSend.set(resHeader);
          dataToSend.set(udpSizeBuffer, resHeader.byteLength);
          dataToSend.set(new Uint8Array(dnsQueryResult), resHeader.byteLength + udpSizeBuffer.byteLength);
          headerSent = true;
        } else {
          dataToSend = new Uint8Array(udpSizeBuffer.byteLength + udpSize);
          dataToSend.set(udpSizeBuffer);
          dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.byteLength);
        }
        if (serverSocket.readyState === WebSocket.OPEN) {
          serverSocket.send(dataToSend);
        }
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
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
};
const handleDNS = async (queryPacket) => {
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
