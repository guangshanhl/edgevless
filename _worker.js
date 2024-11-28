import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

export default {
  async fetch(request, env, ctx) {
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
    }
    return await vlessOverWSHandler(request);
  }
};

async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();

  const earlyDataHeader = request.headers.get('sec-websocket-protocol');
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
  
  let remoteConnection = null;
  let udpStreamWrite = null;
  let isDns = false;

  const writer = new WritableStream({
    async write(chunk) {
      if (isDns && udpStreamWrite) {
        return udpStreamWrite(chunk);
      }
      
      if (remoteConnection) {
        const writer = remoteConnection.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }

      const {
        hasError,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        vlessVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processVlessHeader(chunk, userID);

      if (hasError || (isUDP && portRemote !== 53)) return;

      const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
      const rawClientData = chunk.slice(rawDataIndex);

      if (isUDP && portRemote === 53) {
        isDns = true;
        const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
        udpStreamWrite = write;
        udpStreamWrite(rawClientData);
        return;
      }

      remoteConnection = await handleTCPOutBound(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
    }
  });

  readableWebSocketStream.pipeTo(writer).catch(() => {
    safeCloseWebSocket(webSocket);
  });

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
  return new ReadableStream({
    start(controller) {
      webSocketServer.binaryType = "arraybuffer";
      
      webSocketServer.addEventListener('message', (event) => {
        controller.enqueue(event.data);
      });

      if (earlyDataHeader) {
        const { earlyData } = base64ToArrayBuffer(earlyDataHeader);
        if (earlyData) controller.enqueue(earlyData);
      }

      webSocketServer.addEventListener('close', () => {
        controller.close();
        safeCloseWebSocket(webSocketServer);
      });

      webSocketServer.addEventListener('error', () => {
        controller.error();
        safeCloseWebSocket(webSocketServer);
      });
    },
    cancel() {
      safeCloseWebSocket(webSocketServer);
    }
  });
}

async function handleTCPOutBound(addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
  const tcpSocket = await connect({
    hostname: addressRemote,
    port: portRemote,
  }).catch(() => connect({
    hostname: proxyIP,
    port: portRemote,
  }));

  if (!tcpSocket) {
    safeCloseWebSocket(webSocket);
    return;
  }

  const writer = tcpSocket.writable.getWriter();
  await writer.write(rawClientData);
  writer.releaseLock();

  const transformStream = new TransformStream({
    transform(chunk, controller) {
      if (vlessResponseHeader) {
        controller.enqueue(new Uint8Array([...vlessResponseHeader, ...chunk]));
        vlessResponseHeader = null;
      } else {
        controller.enqueue(chunk);
      }
    }
  });

  tcpSocket.readable
    .pipeThrough(transformStream)
    .pipeTo(new WritableStream({
      write(chunk) {
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(chunk);
        }
      }
    })).catch(() => {
      safeCloseWebSocket(webSocket);
    });

  return tcpSocket;
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
  let isVlessHeaderSent = false;
  
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const udpSize = chunk.byteLength;
      const data = new Uint8Array(udpSize + 2);
      data.set([udpSize >> 8, udpSize & 0xff]);
      data.set(new Uint8Array(chunk), 2);
      controller.enqueue(data);
    }
  });

  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      const response = await fetch('https://dns.google/dns-query', {
        method: 'POST',
        headers: { 'content-type': 'application/dns-message' },
        body: chunk
      });

      const dnsData = await response.arrayBuffer();
      if (webSocket.readyState === WebSocket.OPEN) {
        const data = isVlessHeaderSent ? 
          new Uint8Array([...new Uint8Array(dnsData)]) :
          new Uint8Array([...vlessResponseHeader, ...new Uint8Array(dnsData)]);
        webSocket.send(data);
        isVlessHeaderSent = true;
      }
    }
  }));

  return {
    write(chunk) {
      transformStream.writable.getWriter().write(chunk);
    }
  };
}

function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24 || 
      stringify(new Uint8Array(vlessBuffer.slice(1, 17))) !== userID) {
    return { hasError: true };
  }

  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
  const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

  if (command !== 1 && command !== 2) {
    return { hasError: true };
  }

  const portIndex = 18 + optLength + 1;
  const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
  
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1))[0];
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';

  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const ipv6 = [];
      const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      for (let i = 0; i < 8; i++) {
        ipv6.push(dataView.getUint16(i * 2).toString(16));
      }
      addressValue = ipv6.join(':');
      break;
    default:
      return { hasError: true };
  }

  return {
    hasError: false,
    addressRemote: addressValue,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    vlessVersion: version,
    isUDP: command === 2
  };
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
  try {
    if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
      socket.close();
    }
  } catch (error) {
  }
}

function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
}

function stringify(arr, offset = 0) {
  const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
  return (byteToHex[arr[offset]] + byteToHex[arr[offset + 1]] + 
          byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + 
          byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + 
          byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + 
          byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + 
          byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + 
          byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + 
          byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}

function getVLESSConfig(userID, hostName) {
  return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
