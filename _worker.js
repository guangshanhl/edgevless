import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      const isWebSocket = request.headers.get('Upgrade') === 'websocket';
      return isWebSocket ? handleWs(request, userID, proxyIP) : handleHttp(request, userID);
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
  const [client, server] = new WebSocketPair();
  server.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableStream = createWSStream(server, earlyHeader);
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
      const { hasError, address, port, dataIndex, version, isUDP } = processWSHeader(chunk, userID);
      if (hasError) return;
      resHeader[0] = version[0];
      resHeader[1] = 0;
      const clientData = chunk.slice(dataIndex);
      isDns = isUDP && port === 53;
      if (isDns) {
        const { write } = await handleUdp(server, resHeader);
        udpWrite = write;
        udpWrite(clientData);
        return;
      }
      handleTcp(remoteSocket, address, proxyIP, port, clientData, server, resHeader);
    }
  });
  readableStream.pipeTo(writableStream);
  return new Response(null, { status: 101, webSocket: client });
};
const connectWrite = async (remoteSocket, address, port, clientData) => {
    if (remoteSocket.value?.closed === false) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(clientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    remoteSocket.value = await connect({ 
        address, 
        port,
        allowHalfOpen: false,
        secureTransport: 'on'
    });
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(clientData);
    writer.releaseLock();    
    return remoteSocket.value;
};
const handleTcp = async (remoteSocket, address, proxyIP, port, clientData, server, resHeader) => {
  const trynet = async (addr) => {
    try {
      const tcpSocket = await connectWrite(remoteSocket, addr, port, clientData);
      return await forwardData(tcpSocket, server, resHeader);
    } catch (error) {
      return false;
    }
  };
  if (!(await trynet(address) || await trynet(proxyIP))) {
    closeWS(server);
  }
};
const createWSStream = (server, earlyHeader) => { 
  const handleEvent = (event, controller) => {
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
        server.addEventListener(type, event => handleEvent(event, controller))
      );
    },
    cancel() {
      closeWS(server);
    }
  });
};
class webSocketHeader {
  constructor(hasError, address, port, dataIndex, version, isUDP) {
    this.hasError = hasError;
    this.address = address;
    this.port = port;
    this.dataIndex = dataIndex;
    this.version = version;
    this.isUDP = isUDP;
  }
}
const processWSHeader = (buffer, userID) => {
  const bytes = new Uint8Array(buffer);
  const dateID = stringify(bytes.subarray(1, 17));
  if (dateID !== userID) return new webSocketHeader(true); 
  const optLength = bytes[17];
  const commandIndex = 18 + optLength;
  const command = bytes[commandIndex];
  const isUDP = command === 2;
  const port = (bytes[commandIndex + 1] << 8) | bytes[commandIndex + 2];
  const { address, dataIndex } = getAddressInfo(bytes, commandIndex + 3);
  return new webSocketHeader(false, address, port, dataIndex, bytes.subarray(0, 1), isUDP);
};
const getAddressInfo = (bytes, startIndex) => {
  const addressType = bytes[startIndex];
  const addressLength = addressType === 2 ? bytes[startIndex + 1] : (addressType === 1 ? 4 : 16);
  const addressIndex = startIndex + (addressType === 2 ? 2 : 1);
  const addressValue = addressType === 1
    ? Array.from(bytes.subarray(addressIndex, addressIndex + addressLength)).join('.')
    : addressType === 2
    ? new TextDecoder().decode(bytes.subarray(addressIndex, addressIndex + addressLength))
    : Array.from(bytes.subarray(addressIndex, addressIndex + addressLength)).map(b => b.toString(16).padStart(2, '0')).join(':');
  return { address: addressValue, dataIndex: addressIndex + addressLength };
};
const forwardData = async (remoteSocket, server, resHeader) => {
  let hasData = false;
  let headerSent = resHeader !== null;
  const writableStream = new WritableStream({
    async write(chunk, controller) {
      if (server.readyState !== WebSocket.OPEN) {
        controller.error('serverSocket is closed');
      }
      if (headerSent) {
        const combined = new Uint8Array(resHeader.byteLength + chunk.byteLength);
        combined.set(resHeader);
        combined.set(new Uint8Array(chunk), resHeader.byteLength);
        server.send(combined);
        headerSent = false;
      } else {
        server.send(chunk);
      }
      hasData = true;
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWS(server);
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
const closeWS = (server) => {
    if (server.readyState === WebSocket.OPEN || server.readyState === WebSocket.CLOSING) {
        server.close();
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
const handleUdp = async (server, resHeader) => {
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
        if (server.readyState === WebSocket.OPEN) {
          server.send(dataToSend);
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
