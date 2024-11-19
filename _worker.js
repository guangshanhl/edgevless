import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
let cachedUserID;
export default {
  async fetch(request, env, ctx) {
    try {
      userID = env.UUID || userID;
      proxyIP = env.PROXYIP || proxyIP;      
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader === 'websocket') {
        return await resOverWSHandler(request);
      }
      const url = new URL(request.url);
      switch (url.pathname) {
        case '/':
          return new Response(JSON.stringify(request.cf), { status: 200 });
        case `/${userID}`:
          return new Response(
            getConfig(userID, request.headers.get('Host')),
            {
              status: 200,
              headers: {
                "Content-Type": "text/plain;charset=utf-8"
              }
            }
          );
        default:
          return new Response('Not found', { status: 404 });
      }
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const resOverWSHandler = async (request) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  webSocket.accept();
  const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWebStream = makeWebStream(webSocket, earlyHeader);  
  let remoteSocket = { value: null };
  let udpWrite = null;
  let isDns = false;
  readableWebStream.pipeTo(new WritableStream({
    async write(chunk, controller) {
      if (isDns && udpWrite) {
        return udpWrite(chunk);
      }
      if (remoteSocket.value) {
        const writer = remoteSocket.value.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const {
        hasError,
        portRemote = 443,
        addressRemote = '',
        rawDataIndex,
        resVersion = new Uint8Array([0, 0]),
        isUDP,
      } = processResHeader(chunk, userID);
      if (hasError) return;
      if (isUDP && portRemote === 53) {
        isDns = true;
      } else if (isUDP) {
        return;
      }
      const resHeader = new Uint8Array([resVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);
      if (isDns) {
        const { write } = await handleUDPOutBound(webSocket, resHeader);
        udpWrite = write;
        udpWrite(clientData);
        return;
      }
      handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
    }
  })).catch(() => closeWebSocket(webSocket));
  return new Response(null, {
    status: 101,
    webSocket: client
  });
};
const handleTCPOutBound = async (remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) => {
  const connectAndWrite = async (address, port) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
      remoteSocket.value = connect({
        hostname: address,
        port: port
      });
    }
    const writer = remoteSocket.value.writable.getWriter();
    await writer.write(clientData);
    writer.releaseLock();
    return remoteSocket.value;
  };
  const tryConnect = async (address, port) => {
    const tcpSocket = await connectAndWrite(address, port);
    return forwardToData(tcpSocket, webSocket, resHeader);
  };
  if (!await tryConnect(addressRemote, portRemote)) {
    if (!await tryConnect(proxyIP, portRemote)) {
      closeWebSocket(webSocket);
    }
  }
};
const makeWebStream = (webSocket, earlyHeader) => {
  let isCancel = false; 
  return new ReadableStream({
    start: controller => {
      webSocket.addEventListener('message', ({data}) => {
        if (!isCancel) controller.enqueue(data);
      });
      webSocket.addEventListener('close', () => {
        closeWebSocket(webSocket);
        if (!isCancel) controller.close();
      });
      webSocket.addEventListener('error', err => controller.error(err));
      const {earlyData, error} = base64ToBuffer(earlyHeader);
      if (error) {
        controller.error(error);
      } else if (earlyData) {
        controller.enqueue(earlyData);
      }
    },
    cancel: () => {
      if (!isCancel) {
        isCancel = true;
        closeWebSocket(webSocket);
      }
    }
  });
};
const processResHeader = (resBuffer, userID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };
  const version = new Uint8Array(resBuffer.slice(0, 1));
  let isUDP = false;
  if (!cachedUserID) {
    cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
  }
  const bufferUserID = new Uint8Array(resBuffer.slice(1, 17));
  const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
  if (hasError) return { hasError: true };
  const optLength = new Uint8Array(resBuffer.slice(17, 18))[0];
  const command = new Uint8Array(resBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
  if (command === 2) {
    isUDP = true;
  } else if (command !== 1) {
    return { hasError: false };
  }
  const portIndex = 18 + optLength + 1;
  const portBuffer = resBuffer.slice(portIndex, portIndex + 2);
  const portRemote = new DataView(portBuffer).getUint16(0);
  let addressIndex = portIndex + 2;
  const addressType = new Uint8Array(resBuffer.slice(addressIndex, addressIndex + 1))[0];  
  let addressLength = 0;
  let addressValueIndex = addressIndex + 1;
  let addressValue = '';
  switch (addressType) {
    case 1:
      addressLength = 4;
      addressValue = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
      break;
    case 2:
      addressLength = new Uint8Array(resBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
      addressValueIndex += 1;
      addressValue = new TextDecoder().decode(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      break;
    case 3:
      addressLength = 16;
      const dataView = new DataView(resBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
      addressValue = Array.from({length: 8}, (_, i) => dataView.getUint16(i * 2).toString(16)).join(':');
      break;
    default:
      return { hasError: true };
  }
  return addressValue ? {
    hasError: false,
    addressRemote: addressValue,
    addressType,
    portRemote,
    rawDataIndex: addressValueIndex + addressLength,
    resVersion: version,
    isUDP,
  } : { hasError: true };
};
const forwardToData = async (remoteSocket, webSocket, resHeader) => {
  let hasData = false;
  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk) {
      if (webSocket.readyState !== WebSocket.OPEN) {
        controller.error('WebSocket is closed');
      }
      const bufferToSend = resHeader
        ? (() => {
            const buffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
            buffer.set(resHeader);
            buffer.set(chunk, resHeader.byteLength);
            resHeader = null;
            return buffer;
          })()
        : chunk;
      webSocket.send(bufferToSend);
      hasData = true;
    }
  })).catch(() => closeWebSocket(webSocket));
  return hasData;
};
const base64ToBuffer = (base64Str) => {
  if (!base64Str) return { error: null };

  try {
    const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(normalizedStr);
    const arrayBuffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      arrayBuffer[i] = binaryStr.charCodeAt(i);
    }
    return { earlyData: arrayBuffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWebSocket = (socket) => {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
    socket.close();
  }
};
const handleUDPOutBound = async (webSocket, resHeader) => {
  let headerSent = false;
  const writer = new WritableStream({
    async write(chunk) {
      try {
        const dnsResponse = await queryDNS(chunk);
        if (dnsResponse && webSocket.readyState === WebSocket.OPEN) {
          const resPayload = queryDNSResponse(resHeader, dnsResponse, headerSent);
          webSocket.send(resPayload);
          headerSent = true;
        }
      } catch {
        closeWebSocket(webSocket);
      }
    }
  }).getWriter();
  return { 
    write: chunk => writer.write(chunk).catch(console.error) 
  };
};
const queryDNS = async (dnsRequest) => {
  const response = await fetch('https://cloudflare-dns.com/dns-query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/dns-message' },
    body: dnsRequest
  });
  return await response.arrayBuffer();
};
const queryDNSResponse = (resHeader, dnsResponse, headerSent) => {
  const sizeBuffer = new Uint8Array([
    (dnsResponse.byteLength >> 8) & 0xff,
    dnsResponse.byteLength & 0xff
  ]);
  const resPayload = new Uint8Array(
    (headerSent ? 0 : resHeader.byteLength) + 
    sizeBuffer.byteLength + 
    dnsResponse.byteLength
  );
  let offset = 0;
  if (!headerSent) {
    resPayload.set(resHeader, offset);
    offset += resHeader.byteLength;
  }
  resPayload.set(sizeBuffer, offset);
  resPayload.set(new Uint8Array(dnsResponse), offset + sizeBuffer.byteLength);
  return resPayload;
};
const getConfig = (userID, hostName) => 
  `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
