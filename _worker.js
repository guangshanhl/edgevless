import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
    throw new Error('UUID is not valid');
}
export default {
    async fetch(request, env) {
        userID = env.UUID || userID;
        proxyIP = env.PROXYIP || proxyIP;

        const upgradeHeader = request.headers.get('Upgrade');
        if (upgradeHeader !== 'websocket') {
            return handleHttpRequest(request, userID);
        }
        try {
            return await resOverWSHandler(request);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf), { status: 200 });
        case `/${userID}`:
            const resConfig = getConfig(userID, request.headers.get('Host'));
            return new Response(resConfig, {
                status: 200,
                headers: {
                    'Content-Type': 'text/plain;charset=utf-8',
                }
            });
        default:
            return new Response('Not found', { status: 404 });
    }
};
async function resOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWsStream = makeWsStream(webSocket, earlyDataHeader);
  let remoteSocket = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  readableWsStream.pipeTo(new WritableStream({
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
      const {
        hasError,
        message,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        resVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processResHeader(chunk, userID);
      if (hasError) {
        return;
      }
      if (isUDP) {
        if (portRemote === 53) {
          isDns = true;
        } else {
          return;
        }
      }
      const responseHeader = new Uint8Array([resVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);
      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, responseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }
      handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader);
    }
  })).catch((err) => {
  });
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, responseHeader) {
  async function connectAndWrite(address, port) {
    const tcpSocket = await connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;   
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }
  async function retry() {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    tcpSocket.closed.finally(() => {
      safeCloseWebSocket(webSocket);
    });
    remoteSocketToWS(tcpSocket, webSocket, responseHeader, null);
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, responseHeader, retry);
}
function makeWsStream(webSocketServer, earlyDataHeader) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      const onMessage = (event) => {
        if (!readableStreamCancel) {
          controller.enqueue(event.data);
        }
      };
      const onClose = () => {
        if (!readableStreamCancel) {
          controller.close();
        }
        safeCloseWebSocket(webSocketServer);
      };
      const onError = (err) => {
        controller.error(err);
      };
      webSocketServer.addEventListener('message', onMessage);
      webSocketServer.addEventListener('close', onClose);
      webSocketServer.addEventListener('error', onError);
      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      stream.cancel = () => {
        if (!readableStreamCancel) {
          readableStreamCancel = true;
          webSocketServer.removeEventListener('message', onMessage);
          webSocketServer.removeEventListener('close', onClose);
          webSocketServer.removeEventListener('error', onError);
          safeCloseWebSocket(webSocketServer);
        }
      };
    }
  });
  return stream;
}
function processResHeader(resBuffer, userID) {
  if (resBuffer.byteLength < 24) {
    return { hasError: true };
  }
  const version = new Uint8Array(resBuffer.slice(0, 1));
  const userIdBuffer = new Uint8Array(resBuffer.slice(1, 17)); 
  if (stringify(userIdBuffer) !== userID) {
    return { hasError: true };
  }
  const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
  const command = new Uint8Array(resBuffer.slice(18 + optLength, 19 + optLength))[0];
  const isUDP = (command === 2);
  if (command !== 1 && !isUDP) {
    return { hasError: true };
  }
  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(resBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  const addressIndex = portIndex + 2;
  const addressType = new Uint8Array(resBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressValue = Array.from(new Uint8Array(resBuffer.slice(addressIndex + 1, addressIndex + 5))).join('.');
      break;
    case 2:
      const addressLength = new Uint8Array(resBuffer.slice(addressIndex + 1, addressIndex + 2))[0];
      addressValue = new TextDecoder().decode(resBuffer.slice(addressIndex + 2, addressIndex + 2 + addressLength));
      break;
    case 3:
      addressValue = Array.from({ length: 8 }, (_, i) => 
        new DataView(resBuffer.slice(addressIndex + 1 + i * 2, addressIndex + 3 + i * 2)).getUint16(0).toString(16)
      ).join(':');
      break;
    default:
      return { hasError: true };
  }
  if (!addressValue) {
    return { hasError: true };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressIndex + 1 + (addressType === 2 ? 1 : addressType === 3 ? 16 : 4),
    resVersion: version,
    isUDP,
  };
}
async function remoteSocketToWS(remoteSocket, webSocket, responseHeader, retry) {
  let hasData = false;
  await remoteSocket.readable.pipeTo(
    new WritableStream({
      async write(chunk, controller) {
        hasData = true;
        if (webSocket.readyState !== WebSocket.OPEN) {
          return controller.error('webSocket is closed');
        }
        if (responseHeader) {
          const combined = new Uint8Array(responseHeader.length + chunk.byteLength);
          combined.set(responseHeader, 0);
          combined.set(new Uint8Array(chunk), responseHeader.length);
          webSocket.send(combined.buffer);
          responseHeader = null;
        } else {
          webSocket.send(chunk);
        }
      }
    })
  ).catch(() => {
    safeCloseWebSocket(webSocket);
  });

  if (!hasData && retry) {
    retry();
  }
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64);
    const arrBuffer = Uint8Array.from(binaryStr, (c) => c.charCodeAt(0));
    return { earlyData: arrBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}
function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
    console.error("Failed to close WebSocket:", error);
  }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return `${byteToHex[arr[offset + 0]]}${byteToHex[arr[offset + 1]]}${byteToHex[arr[offset + 2]]}${byteToHex[arr[offset + 3]]}-${byteToHex[arr[offset + 4]]}${byteToHex[arr[offset + 5]]}-${byteToHex[arr[offset + 6]]}${byteToHex[arr[offset + 7]]}-${byteToHex[arr[offset + 8]]}${byteToHex[arr[offset + 9]]}-${byteToHex[arr[offset + 10]]}${byteToHex[arr[offset + 11]]}${byteToHex[arr[offset + 12]]}${byteToHex[arr[offset + 13]]}${byteToHex[arr[offset + 14]]}${byteToHex[arr[offset + 15]]}`.toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError("Stringified UUID is invalid");
  return uuid;
}
async function handleUDPOutBound(webSocket, responseHeader) {
  let headerSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const response = await fetch('https://1.1.1.1/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk,
      });
      const dnsQueryResult = await response.arrayBuffer();
      const udpSize = dnsQueryResult.byteLength;
      const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
      let combined;
      if (webSocket.readyState === WebSocket.OPEN) {
        if (headerSent) {
          combined = new Uint8Array(udpSizeBuffer.length + dnsQueryResult.byteLength);
          combined.set(udpSizeBuffer, 0);
          combined.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.length);
        } else {
          combined = new Uint8Array(responseHeader.length + udpSizeBuffer.length + dnsQueryResult.byteLength);
          combined.set(responseHeader, 0);
          combined.set(udpSizeBuffer, responseHeader.length);
          combined.set(new Uint8Array(dnsQueryResult), responseHeader.length + udpSizeBuffer.length);
          headerSent = true;
        }
        webSocket.send(combined.buffer);
      }
    }
  })).catch((error) => {
    console.error('Stream error:', error);
  });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
}
function getConfig(userID, hostName) {
  return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
