import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
  throw new Error('UUID is not valid');
}
export default {
  async fetch(request, env, ctx) {
    try {
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return handleHttpRequest(request);
      } else {
        return await vlessOverWSHandler(request);
      }
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttpRequest = (request) => {
  const url = new URL(request.url);
  switch (url.pathname) {
    case '/':
      return new Response(JSON.stringify(request.cf), { status: 200 });
    case `/${userID}`:
      const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
      return new Response(`${vlessConfig}`, {
        status: 200,
        headers: { "Content-Type": "text/plain;charset=utf-8" }
      });
    default:
      return new Response('Not found', { status: 404 });
  }
};
async function vlessOverWSHandler(request) {
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  let address = '';
  let portWithRandomLog = '';
  const log = (info, event) => {
    console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
  };
  const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
  const remoteSocketWrapper = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  const handleChunk = async (chunk) => {
    if (isDns && udpStreamWrite) {
      await udpStreamWrite(chunk);
      return;
    }
    if (remoteSocketWrapper.value) {
      const writer = remoteSocketWrapper.value.writable.getWriter();
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
      vlessVersion = new Uint8Array([0, 0]),
      isUDP,
    } = processVlessHeader(chunk, userID);
    address = addressRemote;
    portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '}`;
    if (hasError) throw new Error(message);
    if (isUDP && portRemote !== 53) throw new Error('UDP proxy only enable for DNS which is port 53');
    isDns = isUDP;
    const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
    const rawClientData = chunk.slice(rawDataIndex);
    if (isDns) {
      const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
      udpStreamWrite = write;
      await udpStreamWrite(rawClientData);
    } else {
      handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
    }
  };
  readableWebSocketStream.pipeTo(new WritableStream({
    write: handleChunk,
    close() {
      log('readableWebSocketStream is close');
    },
    abort(reason) {
      log('readableWebSocketStream is abort', JSON.stringify(reason));
    },
  })).catch(err => {
    log('readableWebSocketStream pipeTo error', err);
  });
  return new Response(null, { status: 101, webSocket: client });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
  const connectAndWrite = async (address, port) => {
    const tcpSocket = await connect({ hostname: address, port });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);

    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  };
  const retry = async () => {
    const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
    tcpSocket.closed.catch(error => {
      console.error('retry tcpSocket closed error', error);
    }).finally(() => {
      safeCloseWebSocket(webSocket);
    });
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
  };
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
  let readableStreamCancel = false;
  const handleEvent = (controller, type, event) => {
    if (readableStreamCancel) return;
    switch (type) {
      case 'message':
        controller.enqueue(event.data);
        break;
      case 'close':
        safeCloseWebSocket(webSocketServer);
        controller.close();
        break;
      case 'error':
        log('webSocketServer has error');
        controller.error(event);
        break;
    }
  };
  const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
  const stream = new ReadableStream({
    start(controller) {
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
      webSocketServer.addEventListener('message', event => handleEvent(controller, 'message', event));
      webSocketServer.addEventListener('close', event => handleEvent(controller, 'close', event));
      webSocketServer.addEventListener('error', event => handleEvent(controller, 'error', event));
    },
    pull(controller) {},
    cancel(reason) {
      if (readableStreamCancel) return;
      log(`ReadableStream was canceled, due to ${reason}`);
      readableStreamCancel = true;
      safeCloseWebSocket(webSocketServer);
    }
  });
  return stream;
}
function processVlessHeader(vlessBuffer, userID) {
  if (vlessBuffer.byteLength < 24) {
    return { hasError: true, message: 'invalid data' };
  }
  const view = new DataView(vlessBuffer);
  const version = new Uint8Array(vlessBuffer.slice(0, 1));
  const receivedID = stringify(new Uint8Array(vlessBuffer.slice(1, 17)));
  if (receivedID !== userID) {
    return { hasError: true, message: 'invalid user' };
  }
  const optLength = view.getUint8(17);
  const command = view.getUint8(18 + optLength);
  const isUDP = command === 2;
  if (command !== 1 && command !== 2) {
    return { hasError: true, message: `command ${command} is not support, command 01-tcp,02-udp,03-mux` };
  }
  const portRemote = view.getUint16(18 + optLength + 1);
  const addressType = view.getUint8(20 + optLength);
  let addressValue, addressLength;
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = Array.from(new Uint8Array(vlessBuffer.slice(21 + optLength, 25 + optLength))).join('.');
      break;
    case 2:
      addressLength = view.getUint8(21 + optLength);
      addressValue = new TextDecoder().decode(vlessBuffer.slice(22 + optLength, 22 + optLength + addressLength));
      break;
    case 3:
      addressLength = 16;
      addressValue = Array.from({ length: 8 }, (_, i) => view.getUint16(21 + optLength + 2 * i).toString(16)).join(':');
      break;
    default:
      return { hasError: true, message: `invalid addressType ${addressType}` };
  }
  if (!addressValue) {
    return { hasError: true, message: `addressValue is empty, addressType is ${addressType}` };
  }
  return {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: 21 + optLength + addressLength,
    vlessVersion: version,
    isUDP
  };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
  let vlessHeader = vlessResponseHeader;
  let hasIncomingData = false;
  try {
    await remoteSocket.readable.pipeTo(new WritableStream({
      async write(chunk, controller) {
        hasIncomingData = true;
        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
          controller.error('webSocket.readyState is not open, maybe close');
        }
        const data = vlessHeader ? await new Blob([vlessHeader, chunk]).arrayBuffer() : chunk;
        webSocket.send(data);
        vlessHeader = null;
      },
      close() {
        log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
      },
      abort(reason) {
        console.error('remoteConnection!.readable abort', reason);
      }
    }));
  } catch (error) {
    console.error('remoteSocketToWS has exception', error.stack || error);
    safeCloseWebSocket(webSocket);
  }
  if (!hasIncomingData && retry) {
    log('retry');
    retry();
  }
}
function base64ToArrayBuffer(base64Str) {
  if (!base64Str) return { error: null };

  try {
    const formattedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(formattedStr);
    const arrayBuffer = Uint8Array.from(binaryStr, c => c.charCodeAt(0));
    return { earlyData: arrayBuffer.buffer, error: null };
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
  if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
    try {
      socket.close();
    } catch (error) {
      console.error('safeCloseWebSocket error', error);
    }
  }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
  return Array.from(arr.slice(offset, offset + 16), (byte, index) =>
    index === 4 || index === 6 || index === 8 || index === 10 ? `-${byteToHex[byte]}` : byteToHex[byte]
  ).join('').toLowerCase();
}
function stringify(arr, offset = 0) {
  const uuid = unsafeStringify(arr, offset);
  if (!isValidUUID(uuid)) throw new TypeError("Stringified UUID is invalid");
  return uuid;
}
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
  let isVlessHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index += 2 + udpPacketLength;
        controller.enqueue(udpData);
      }
    }
  });
  const writableStream = new WritableStream({
    async write(chunk) {
      try {
        const response = await fetch('https://1.1.1.1/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: chunk
        });
        const dnsQueryResult = await response.arrayBuffer();
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

        if (webSocket.readyState === WebSocket.OPEN) {
          log(`doh success and dns message length is ${udpSize}`);
          const message = isVlessHeaderSent
            ? [udpSizeBuffer, dnsQueryResult]
            : [vlessResponseHeader, udpSizeBuffer, dnsQueryResult];

          webSocket.send(await new Blob(message).arrayBuffer());
          isVlessHeaderSent = true;
        }
      } catch (error) {
        log(`dns udp has error: ${error}`);
      }
    }
  });
  transformStream.readable.pipeTo(writableStream).catch(error => log(`Stream piping error: ${error}`));
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
}
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
