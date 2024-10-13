import {
    connect
}
from 'cloudflare:sockets';
export default {
    async fetch(request, env) {
        const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
        const proxyIP = env.PROXYIP || '';
        try {
            const isWebSocket = request.headers.get('Upgrade') === 'websocket';
            if (isWebSocket) {
                return handleWsRequest(request, userID, proxyIP);
            }
            return handleHttpRequest(request, userID);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
const handleHttpRequest = (request, userID) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/")
        return new Response(JSON.stringify(request.cf, null, 4));
    if (path === `/${userID}`) {
        return new Response(getConfig(userID, request.headers.get("Host")), {
            headers: {
                "Content-Type": "text/plain;charset=utf-8"
            }
        });
    }
    return new Response("Not found", {
        status: 404
    });
};
const handleWsRequest = async(request, userID, proxyIP) => {
    const webSocketPair = new WebSocketPair();
    const clientSocket = webSocketPair[0];
    const serverSocket = webSocketPair[1];
    serverSocket.accept();
    const protocols = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = createWebSocketStream(serverSocket, protocols);
    let remoteSocket = {
        value: null
    };
    let udpStreamWrite = null;
    let isDns = false;
    const responseHeader = new Uint8Array(2);
    readableStream.pipeTo(
        new WritableStream({
            async write(chunk) {
                if (isDns && udpStreamWrite) {
                    await udpStreamWrite(chunk);
                    return;
                }
                if (remoteSocket.value) {
                    await writeToRemote(remoteSocket.value, chunk);
                    return;
                }
                const {
                    hasError,
                    addressRemote,
                    portRemote,
                    rawDataIndex,
                    vlessVersion,
                    isUDP
                } = processWebSocketHeader(chunk, userID);
                if (hasError)
                    return;
                responseHeader[0] = vlessVersion[0];
                responseHeader[1] = 0;
                const rawClientData = chunk.slice(rawDataIndex);
                isDns = isUDP && portRemote === 53;
                if (isDns) {
                    udpStreamWrite = await handleUdpRequest(serverSocket, responseHeader, rawClientData);
                } else {
                    handleTcpRequest(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP);
                }
            },
        }));
    return new Response(null, {
        status: 101,
        webSocket: clientSocket,
    });
};
const writeToRemote = async(socket, chunk) => {
    const writer = socket.writable.getWriter();
    await writer.write(chunk);
    writer.releaseLock();
};
const connectAndWrite = async(remoteSocket, address, port, rawClientData) => {
    if (!remoteSocket.value || remoteSocket.value.closed) {
        remoteSocket.value = await connect({
            hostname: address,
            port
        });
    }
    await writeToRemote(remoteSocket.value, rawClientData);
    return remoteSocket.value;
};
const handleTcpRequest = async(remoteSocket, addressRemote, portRemote, rawClientData, serverSocket, responseHeader, proxyIP) => {
    try {
        const tcpSocket = await connectAndWrite(remoteSocket, addressRemote, portRemote, rawClientData);
        await forwardToData(tcpSocket, serverSocket, responseHeader, async(retry) => {
            const fallbackSocket = await connectAndWrite(remoteSocket, proxyIP, portRemote, rawClientData);
            await forwardToData(fallbackSocket, serverSocket, responseHeader);
        });
    } catch {
        closeWebSocket(serverSocket);
    }
};
const createWebSocketStream = (serverSocket, earlyDataHeader) => {
  const eventListeners = new Map();
  const removeWebSocketListeners = (socket) => {
    eventListeners.forEach((handler, event) => {
      socket.removeEventListener(event, handler);
    });
    eventListeners.clear();
  };
  const readableStream = new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyDataHeader);
      if (error) {
        controller.error(error);
        return;
      }
      if (earlyData) {
        controller.enqueue(earlyData);
      }
      const handleMessage = (event) => controller.enqueue(event.data);
      const handleClose = () => {
        controller.close();
        removeWebSocketListeners(serverSocket);
      };
      const handleError = (err) => {
        controller.error(err);
        removeWebSocketListeners(serverSocket);
      };
      eventListeners.set('message', handleMessage);
      eventListeners.set('close', handleClose);
      eventListeners.set('error', handleError);
      eventListeners.forEach((handler, event) => {
        serverSocket.addEventListener(event, handler);
      });
    },
    cancel() {
      removeWebSocketListeners(serverSocket);
      closeWebSocket(serverSocket);
    }
  });
  return readableStream;
};
const processWebSocketHeader = (buffer, userID) => {
    const view = new DataView(buffer);
    const receivedID = stringify(new Uint8Array(buffer.slice(1, 17)));
    if (receivedID !== userID)
        return {
            hasError: true
        };
    const optLength = view.getUint8(17);
    const startIndex = 18 + optLength;
    const command = view.getUint8(startIndex);
    const isUDP = command === 2;
    const portRemote = view.getUint16(startIndex + 1);
    const version = new Uint8Array(buffer.slice(0, 1));
    const {
        addressRemote,
        rawDataIndex
    } = getAddressInfo(view, buffer, 18 + optLength + 3);
    return {
        hasError: false,
        addressRemote,
        portRemote,
        rawDataIndex,
        vlessVersion: version,
        isUDP
    };
};
const getAddressInfo = (view, buffer, startIndex) => {
    const addressType = view.getUint8(startIndex);
    const addressLength = addressType === 2 ? view.getUint8(startIndex + 1) : (addressType === 1 ? 4 : 16);
    const addressValueIndex = startIndex + (addressType === 2 ? 2 : 1);
    const addressValue = addressType === 1
         ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join('.')
         : addressType === 2
         ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
         : Array.from(new Uint8Array(buffer, addressValueIndex, 16)).map(b => b.toString(16).padStart(2, '0')).join(':');
    return {
        addressRemote: addressValue,
        rawDataIndex: addressValueIndex + addressLength
    };
};
const forwardToData = async (remoteSocket, serverSocket, responseHeader, retry) => {
  if (serverSocket.readyState !== WebSocket.OPEN) {
    closeWebSocket(serverSocket);
    return;
  }
  let hasData = false;
  const CHUNK_SIZE = 256 * 1024;
  let reusableBuffer = responseHeader ? new Uint8Array(responseHeader.length + CHUNK_SIZE) : new Uint8Array(CHUNK_SIZE);
  const writableStream = new WritableStream({
    async write(chunk) {
      hasData = true;
      let dataToSend;
      const chunkLength = chunk.byteLength;
      if (responseHeader) {
        reusableBuffer.set(responseHeader);
        reusableBuffer.set(chunk, responseHeader.length);
        dataToSend = reusableBuffer.subarray(0, responseHeader.length + chunkLength);
        responseHeader = null;
      } else {
        dataToSend = chunk;
      }
      for (let offset = 0; offset < dataToSend.byteLength; offset += CHUNK_SIZE) {
        const end = Math.min(offset + CHUNK_SIZE, dataToSend.byteLength);
        serverSocket.send(dataToSend.subarray(offset, end));
      }
    }
  });
  try {
    await remoteSocket.readable.pipeTo(writableStream);
  } catch (error) {
    closeWebSocket(serverSocket);
  }
  if (!hasData && retry) {
    retry();
  }
};
const BASE64_REPLACE_REGEX = /[-_]/g;
const replaceBase64Chars = (str) => str.replace(BASE64_REPLACE_REGEX, match => (match === '-' ? '+' : '/'));
const base64ToBuffer = (base64Str) => {
    try {
        const binaryStr = atob(replaceBase64Chars(base64Str));
        const buffer = Uint8Array.from(binaryStr, char => char.charCodeAt(0));
        return {
            earlyData: buffer.buffer,
            error: null
        };
    } catch (error) {
        return {
            error
        };
    }
};
const closeWebSocket = (serverSocket) => {
    if (serverSocket.readyState === WebSocket.OPEN || serverSocket.readyState === WebSocket.CLOSING) {
        serverSocket.close();
    }
};
const byteToHex = Array.from({
    length: 256
}, (_, i) => (i + 256).toString(16).slice(1));
const stringify = (arr, offset = 0) => {
    const segments = [4, 2, 2, 2, 6];
    return segments.map(len => Array.from({
            length: len
        }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase();
};
const handleUdpRequest = async(serverSocket, responseHeader, rawClientData) => {
    const dnsCache = new Map();
    const BATCH_SIZE = 5;
    const CACHE_EXPIRY_TIME = 6 * 60 * 60 * 1000;
    let index = 0;
    let batch = [];
    if (!rawClientData || rawClientData.byteLength === 0) {
        return;
    }
    const udpPackets = new Uint8Array(new DataView(rawClientData.buffer).getUint16(0));
    const dnsFetch = async(chunks) => {
        const domain = new TextDecoder().decode(chunks[0]);
        const cachedEntry = dnsCache.get(domain);
        const currentTime = Date.now();
        if (cachedEntry && (currentTime - cachedEntry.timestamp) < CACHE_EXPIRY_TIME) {
            return cachedEntry.data;
        }
        try {
            const response = await fetch('https://cloudflare-dns.com/dns-query', {
                method: 'POST',
                headers: {
                    'content-type': 'application/dns-message'
                },
                body: concatenateChunks(chunks)
            });
            const result = await response.arrayBuffer();
            dnsCache.set(domain, {
                data: result,
                timestamp: currentTime
            });
            return result;
        } catch (error) {
            console.error('DNS Fetch error:', error);
            return null;
        }
    };
    const processBatch = async(controller) => {
        const dnsResults = await Promise.all(batch.map(dnsFetch));
        dnsResults.forEach(dnsResult => {
            if (dnsResult) {
                index = processDnsResult(dnsResult, udpPackets, index);
            }
        });
        controller.enqueue(udpPackets.slice(0, index));
        index = 0;
        batch = [];
    };
    const transformStream = new TransformStream({
        async transform(chunk, controller) {
            let offset = 0;
            while (offset < chunk.byteLength) {
                const udpPacketLength = new DataView(chunk.buffer, offset, 2).getUint16(0);
                batch.push(chunk.slice(offset + 2, offset + 2 + udpPacketLength));
                if (batch.length >= BATCH_SIZE) {
                    await processBatch(controller);
                }
                offset += 2 + udpPacketLength;
            }
        },
        async flush(controller) {
            if (batch.length) {
                await processBatch(controller);
            }
        }
    });
    const writer = transformStream.writable.getWriter();
    await writer.write(rawClientData);
    writer.close();
    const finalMessage = await transformStream.readable.getReader().read();
    if (serverSocket.readyState === WebSocket.OPEN) {
        serverSocket.send(finalMessage.value.buffer);
    }
};
const concatenateChunks = (chunks) => {
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    chunks.forEach(chunk => {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    });
    return result.buffer;
};
const processDnsResult = (dnsResult, udpPackets, index) => {
    const responseArray = new Uint8Array(dnsResult);
    let offset = 0;
    while (offset < responseArray.byteLength) {
        const responseLength = new DataView(responseArray.buffer, offset, 2).getUint16(0);
        udpPackets.set(responseArray.subarray(offset, offset + responseLength), index); // 使用 subarray
        index += responseLength;
        offset += responseLength;
    }
    return index;
};
const getConfig = (userID, hostName) => `
vless://${userID}@${hostName}:8443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}
`;
