import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

if (!isValidUUID(userID)) {
  throw new Error('uuid is not valid');
}

export default {
  async fetch(request, env) {
    try {
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;

      const upgradeHeader = request.headers.get('Upgrade');
      if (!upgradeHeader || upgradeHeader !== 'websocket') {
        const url = new URL(request.url);
        switch (url.pathname) {
          case '/':
            return new Response(JSON.stringify(request.cf), { status: 200 });
          case `/${userID}`:
            return new Response(getVLESSConfig(userID, request.headers.get('Host')), {
              status: 200,
              headers: { "Content-Type": "text/plain;charset=utf-8" }
            });
          default:
            return new Response('Not found', { status: 404 });
        }
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      return new Response(err.toString());
    }
  }
};

async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = webSocketPair;

  webSocket.accept();
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
  const remoteSocket = { value: null };
  let isDns = false;

  readableWebSocketStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && remoteSocket.value) {
        await remoteSocket.value.writable.getWriter().write(chunk);
        return;
      }
      if (remoteSocket.value) {
        await remoteSocket.value.writable.getWriter().write(chunk);
        return;
      }

      const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, vlessVersion = new Uint8Array([0, 0]), isUDP } = processVlessHeader(chunk, userID);
      if (hasError) throw new Error(message);

      isDns = (isUDP && portRemote === 53);
      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
        write(rawClientData);
      } else {
        handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
      }
    }
  })).catch(err => {});

  return new Response(null, { status: 101, webSocket: client });
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocket.value = tcpSocket;
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);

  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port });
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  async function retry() {
    await connectAndWrite(proxyIP || addressRemote, portRemote);
    remoteSocket.value.closed.catch(error => {}).finally(() => {
      closeWebSocket(webSocket);
    });
  }
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
  let readableStreamCancel = false;
  const stream = new ReadableStream({
    start(controller) {
      webSocketServer.addEventListener('message', event => {
        if (!readableStreamCancel) {
          controller.enqueue(event.data);
        }
      });
      webSocketServer.addEventListener('close', () => {
        closeWebSocket(webSocketServer);
        if (!readableStreamCancel) {
          controller.close();
        }
      });
      webSocketServer.addEventListener('error', err => {
        controller.error(err);
      });

      const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel(reason) {
      readableStreamCancel = true;
      closeWebSocket(webSocketServer);
    }
  });
  return stream;
}

function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) return { hasError: true };

  const version = vlessBuffer.slice(0, 1);
  if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) !== userID) return { hasError: true };

  const optLength = vlessBuffer[17];
  const command = vlessBuffer[18 + optLength];
  if (![1, 2].includes(command)) return { hasError: true };

  const portRemote = new DataView(vlessBuffer.slice(18 + optLength + 1, 20 + optLength)).getUint16(0);
  const addressType = vlessBuffer[19 + optLength];
  let addressValue;

  switch (addressType) {
    case 1:
      addressValue = Array.from(new Uint8Array(vlessBuffer.slice(20 + optLength, 24 + optLength))).join('.');
      break;
    case 2:
      const length = vlessBuffer[20 + optLength + 1];
      addressValue = new TextDecoder().decode(vlessBuffer.slice(21 + optLength, 21 + optLength + length));
      break;
    case 3:
      const ipv6 = Array.from(new Uint8Array(vlessBuffer.slice(20 + optLength + 1, 36 + optLength))).map((byte, i) => (i % 2 === 0 ? ':' : '') + byte.toString(16)).join('');
      addressValue = ipv6;
      break;
    default:
      return { hasError: true };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: 20 + optLength + 1 + (addressType === 2 ? addressValue.length + 1 : 16),
    vlessVersion: version,
    isUDP: command === 2
  };
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
  let hasIncomingData = false;

  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WebSocket.OPEN) {
          controller.error('WebSocket connection is not open');
          return;
        }
        const combinedBuffer = new Uint8Array(vlessResponseHeader.byteLength + chunk.byteLength);
        combinedBuffer.set(vlessResponseHeader);
        combinedBuffer.set(chunk, vlessResponseHeader.byteLength);
        webSocket.send(combinedBuffer);
      }
    }));
  } catch (error) {
    closeWebSocket(webSocket);
  }

  if (!hasIncomingData && retry) retry();
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
function closeWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
  }
}
const byteToHex = [];
for (let i = 0; i < 256; ++i) {
  byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
  return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) {
    throw TypeError("Stringified UUID is invalid");
  }
  return uuid;
}
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    }
  });
  const writableStream = new WritableStream({
    async write(chunk) {
      const dnsQueryResult = await fetchDNSQuery(chunk);
      const udpSizeBuffer = createUDPSizeBuffer(dnsQueryResult.byteLength);
      await sendWebSocketMessage(webSocket, vlessResponseHeader, udpSizeBuffer, dnsQueryResult);
    }
  });
  transformStream.readable.pipeTo(writableStream).catch(err => {});
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
  async function fetchDNSQuery(chunk) {
    const response = await fetch('https://1.1.1.1/dns-query', {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: chunk
    });
    return response.arrayBuffer();
  }
  function createUDPSizeBuffer(size) {
    return new Uint8Array([size >> 8 & 0xff, size & 0xff]);
  }
  async function sendWebSocketMessage(webSocket, header, sizeBuffer, data) {
    if (webSocket.readyState === WebSocket.OPEN) {
      const combinedBuffer = new Uint8Array(header.byteLength + sizeBuffer.byteLength + data.byteLength);
      combinedBuffer.set(header);
      combinedBuffer.set(sizeBuffer, header.byteLength);
      combinedBuffer.set(data, header.byteLength + sizeBuffer.byteLength);
      webSocket.send(combinedBuffer);
    }
  }
}
function getVLESSConfig(userID, hostName) {
  const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
  return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2560"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}
