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
    const [client, websocket] = new WebSocketPair();
    websocket.accept();
    const earlyheader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWSStream(websocket, earlyheader);
    let tcpSocket = { value: null };
    let udpWrite = null;
    let isDns = false;
    const writableStream = new WritableStream({
        async write(chunk) {
            if (isDns && udpWrite) {
                return udpWrite(chunk);
            }
            if (tcpSocket.value) {
                await writeToRemote(tcpSocket.value, chunk);
                return;
            }
            const { hasError, address, port, rawDataIndex, version, isUDP } = processWSHeader(chunk, userID);
            if (hasError) return;
            const resHeader = new Uint8Array([version[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            isDns = isUDP && port === 53;
            if (isDns) {
                const { write } = await handleUdp(websocket, resHeader);
                udpWrite = write;
                udpWrite(rawClientData);
                return;
            }
            handleTcp(tcpSocket, address, port, rawClientData, websocket, resHeader, proxyIP);
        }
    });
    readableStream.pipeTo(writableStream);
    return new Response(null, { status: 101, webSocket: client });
};
const writeToRemote = async (socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async (tcpSocket, address, port, rawClientData) => {
    if (!tcpSocket.value || tcpSocket.value.closed) {
        tcpSocket.value = connect({
            hostname: address,
            port,
        });
    }
    await writeToRemote(tcpSocket.value, rawClientData);
    return tcpSocket.value;
};
const handleTcp = async (tcpSocket, address, port, rawClientData, websocket, resHeader, proxyIP) => {
    const tryConnect = async (addr) => {
        try {
            const tcpData = await connectAndWrite(tcpSocket, addr, port, rawClientData);
            return await forwardToData(tcpData, websocket, resHeader);
        } catch (error) {
            return false;
        }
    };
    if (!(await tryConnect(address) || await tryConnect(proxyIP))) {
        closeWS(websocket);
    }
};
const createWSStream = (websocket, earlyHeader) => {
    const handleEvent = (event, controller) => {
        switch (event.type) {
            case 'message':
                controller.enqueue(event.data);
                break;
            case 'close':
                closeWS(websocket);
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
                websocket.addEventListener(type, event => handleEvent(event, controller))
            );
        },
        cancel() {
            closeWS(websocket);
        }
    });
};
class WebSocketHeader {
    constructor(hasError, address, port, rawDataIndex, version, isUDP) {
        this.hasError = hasError;
        this.address = address;
        this.port = port;
        this.rawDataIndex = rawDataIndex;
        this.version = version;
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
    let addressValue;
    if (addressType === 1) {
        addressValue = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength)).join('.');
    } else if (addressType === 2) {
        addressValue = new TextDecoder().decode(bytes.subarray(addressValueIndex, addressValueIndex + addressLength));
    } else {
        addressValue = Array.from(bytes.subarray(addressValueIndex, addressValueIndex + addressLength))
            .map(b => b.toString(16).padStart(2, '0'))
            .join(':')
            .replace(/(:0{1,3}){2,}:/, '::');
    }
    return { address: addressValue, rawDataIndex: addressValueIndex + addressLength };
};
const forwardToData = async (tcpSocket, websocket, resHeader) => {
    let hasData = false;
    let headerSent = !!resHeader;
    const writableStream = new WritableStream({
        async write(chunk, controller) {
            if (websocket.readyState !== WebSocket.OPEN) {
                controller.error('websocket is closed');
            }
            if (headerSent) {
                const combinedBuffer = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                combinedBuffer.set(resHeader);
                combinedBuffer.set(new Uint8Array(chunk), resHeader.byteLength);
                websocket.send(combinedBuffer);
                headerSent = false;
            } else {
                websocket.send(chunk);
            }
            hasData = true;
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        closeWS(websocket);
    }
    return hasData;
};
const base64ToBuffer = (base64Str) => {
  try {
    if (base64Str instanceof ArrayBuffer || base64Str instanceof Uint8Array) {
      return { earlyData: base64Str, error: null };
    }
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
    return { earlyData: buffer.buffer, error: null };
  } catch (error) {
    return { error };
  }
};
const closeWS = (websocket) => {
    if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CLOSING) {
        websocket.close();
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
const dnsCache = new Map();
const getCachedDnsResponse = async (queryPacket) => {
  const cacheKey = new TextDecoder().decode(queryPacket);
  const cachedEntry = dnsCache.get(cacheKey);
  if (cachedEntry && cachedEntry.expires > Date.now()) {
    return cachedEntry.result;
  }
  const response = await fetchDns(queryPacket);
  dnsCache.set(cacheKey, { result: response, expires: Date.now() + 300000 });
  return response;
};
const fetchDns = async (queryPacket) => {
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
const handleUdp = async (websocket, resHeader) => {
  let headerSent = false;
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      for (let index = 0; index < chunk.byteLength;) {
        const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
        const udpData = chunk.subarray(index + 2, index + 2 + udpPacketLength);
        index += 2 + udpPacketLength;
        const dnsQueryResult = await getCachedDnsResponse(udpData);
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        const dataToSend = headerSent
          ? new Uint8Array(udpSizeBuffer.byteLength + udpSize)
          : new Uint8Array(resHeader.byteLength + udpSizeBuffer.byteLength + udpSize);
        if (!headerSent) {
          dataToSend.set(resHeader);
          headerSent = true;
        }
        const offset = headerSent ? 0 : resHeader.byteLength;
        dataToSend.set(udpSizeBuffer, offset);
        dataToSend.set(new Uint8Array(dnsQueryResult), offset + udpSizeBuffer.byteLength);
        if (websocket.readyState === WebSocket.OPEN) {
          websocket.send(dataToSend);
        }
      }
      controller.close();
    }
  });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
};
const getConfig = (userID, host) => {
    return `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
};
