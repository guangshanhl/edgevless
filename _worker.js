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
  await writer.write(chunk);
  writer.releaseLock();
};
const connectAndWrite = async (remoteSocket, address, port, rawClientData) => {
    if (remoteSocket.value?.closed === false) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return remoteSocket.value;
    }
    remoteSocket.value = await connect({ 
        hostname: address, 
        port,
        allowHalfOpen: false,
        secureTransport: false
    });
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();    
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
  if (!(await tryConnect(address, port) || await tryConnect(proxyIP, port))) {
    closeWebSocket(serverSocket);
  }
};
const createWebSocketStream = (serverSocket, earlyHeader) => {
    return new ReadableStream({
        start(controller) {
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (error) {
                    controller.error(error);
                    return;
                }
                if (earlyData) controller.enqueue(earlyData);
            }
            serverSocket.addEventListener('message', ({ data }) => controller.enqueue(data));            
            serverSocket.addEventListener('close', () => {
                closeWebSocket(serverSocket);
                controller.close();
            });            
            ws.addEventListener('error', e => controller.error(e));
        },        
        cancel() {
            closeWebSocket(serverSocket);
        }
    });
};
const createHeader = (hasError = true, address = '', port = 0, rawDataIndex = 0, passVersion = null, isUDP = false) => ({
    hasError, address, port, rawDataIndex, passVersion, isUDP
});
const processWebSocketHeader = (buffer, userID) => {
    const bytes = new Uint8Array(buffer);
    if (stringify(bytes.subarray(1, 17)) !== userID) {
        return createHeader();
    }   
    const cmdStart = 18 + bytes[17];
    const isUDP = bytes[cmdStart] === 2;
    const port = (bytes[cmdStart + 1] << 8) | bytes[cmdStart + 2];
    const addrStart = cmdStart + 3;
    const addrType = bytes[addrStart];
    const valueStart = addrStart + (addrType === 2 ? 2 : 1);
    const addrLen = addrType === 2 ? bytes[addrStart + 1] : (addrType === 1 ? 4 : 16);   
    let address;
    if (addrType === 1) {
        address = bytes.subarray(valueStart, valueStart + addrLen).join('.');
    } else if (addrType === 2) {
        address = new TextDecoder().decode(bytes.subarray(valueStart, valueStart + addrLen));
    } else {
        address = Array.from(bytes.subarray(valueStart, valueStart + addrLen))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':');
    }
    return createHeader(
        false,
        address,
        port,
        valueStart + addrLen,
        bytes.subarray(0, 1),
        isUDP
    );
};
const forwardToData = async (remoteSocket, serverSocket, responseHeader) => {
    // 使用更高效的标志位
    let hasData = false;
    const needHeader = Boolean(responseHeader);
    
    try {
        await remoteSocket.readable.pipeTo(new WritableStream({
            write(chunk) {
                // 快速检查WebSocket状态
                if (serverSocket.readyState !== WebSocket.OPEN) {
                    throw new Error('WebSocket closed');
                }

                if (needHeader) {
                    // 优化内存分配，只在第一次发送时合并header
                    const combined = new Uint8Array(responseHeader.length + chunk.byteLength);
                    combined.set(responseHeader);
                    combined.set(new Uint8Array(chunk), responseHeader.length);
                    serverSocket.send(combined);
                    responseHeader.length = 0; // 清除header引用
                } else {
                    serverSocket.send(chunk);
                }
                
                hasData = true;
            }
        }));
    } catch {
        if (serverSocket.readyState <= WebSocket.CLOSING) {
            serverSocket.close();
        }
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
