import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;
            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                const url = new URL(request.url);
                switch (url.pathname) {
                    case '/':
                        return new Response(JSON.stringify(request.cf), { status: 200 });
                    case `/${userID}`: {
                        const config = getConfig(userID, request.headers.get('Host'));
                        return new Response(config, {
                            status: 200,
                            headers: {
                                "Content-Type": "text/plain;charset=utf-8"
                            },
                        });
                    }
                    default:
                        return new Response('Not found', { status: 404 });
                }
            } else {
                return await resOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function resOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    let address = '';
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
            address = addressRemote;
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
            const resHeader = new Uint8Array([resVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
        close() {},
        abort(reason) {},
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndWrite(address, port) {
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
    }
    async function tryConnect(address, port) {
        const tcpSocket = await connectAndWrite(address, port);
        return forwardToData(tcpSocket, webSocket, resHeader);
    }
    try {
        if (!await tryConnect(addressRemote, portRemote)) {
            if (!await tryConnect(proxyIP, portRemote)) {
                closeWebSocket(webSocket);
            }
        }
    } catch (error) {
        closeWebSocket(webSocket);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => {
                if (isCancel) return;
                const message = event.data;
                controller.enqueue(message);
            });
            webSocket.addEventListener('close', () => {
                closeWebSocket(webSocket);
                if (isCancel) return;
                controller.close();
            });
            webSocket.addEventListener('error', (err) => {
                console.error('WebSocket error:', err);
                controller.error(err);
            });
            if (earlyHeader) {
                const { earlyData, error } = base64ToBuffer(earlyHeader);
                if (error) {
                    controller.error(error);
                } else if (earlyData) {
                    controller.enqueue(earlyData);
                }
            }
        },
        pull(controller) {
        },
        cancel(reason) {
            if (isCancel) return;
            isCancel = true;
            closeWebSocket(webSocket);
        }
    });
    return stream;
}
const ADDRESS_TYPES = {
  IPV4: 1,
  DOMAIN: 2,
  IPV6: 3
};
const COMMANDS = {
  TCP: 1,
  UDP: 2
};
let cachedUserID;
function processResHeader(resBuffer, userID) {
  if (resBuffer.byteLength < 24) {
    return { hasError: true };
  }
  const dataView = new DataView(resBuffer);
  const bufferView = new Uint8Array(resBuffer);
  const version = bufferView.slice(0, 1);
  if (!cachedUserID) {
    cachedUserID = new Uint8Array(
      userID.replace(/-/g, '')
        .match(/../g)
        .map(byte => parseInt(byte, 16))
    );
  }
  const bufferUserID = bufferView.slice(1, 17);
  if (!bufferUserID.every((byte, index) => byte === cachedUserID[index])) {
    return { hasError: true };
  }
  const optLength = bufferView[17];
  const commandIndex = 18 + optLength;
  const command = bufferView[commandIndex];
  const isUDP = command === COMMANDS.UDP;
  if (command !== COMMANDS.TCP && !isUDP) {
    return { hasError: false };
  }
  const portIndex = commandIndex + 1;
  const portRemote = dataView.getUint16(portIndex);
  const addressIndex = portIndex + 2;
  const addressType = bufferView[addressIndex];
  let addressValueIndex = addressIndex + 1;
  let addressLength = 0;
  let addressValue = '';
  try {
    switch (addressType) {
      case ADDRESS_TYPES.IPV4:
        addressLength = 4;
        addressValue = bufferView
          .slice(addressValueIndex, addressValueIndex + addressLength)
          .join('.');
        break;

      case ADDRESS_TYPES.DOMAIN:
        addressLength = bufferView[addressValueIndex];
        addressValueIndex++;
        addressValue = new TextDecoder().decode(
          resBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
        );
        break;
      case ADDRESS_TYPES.IPV6:
        addressLength = 16;
        const ipv6Parts = [];
        for (let i = 0; i < 8; i++) {
          ipv6Parts.push(
            dataView.getUint16(addressValueIndex + i * 2).toString(16)
          );
        }
        addressValue = ipv6Parts.join(':');
        break;

      default:
        return { hasError: true };
    }
  } catch (error) {
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
    rawDataIndex: addressValueIndex + addressLength,
    resVersion: version,
    isUDP,
  };
}
async function forwardToData(remoteSocket, webSocket, resHeader) {
    let hasData = false;
    await remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (webSocket.readyState !== WebSocket.OPEN) {
                controller.error('WebSocket is closed');
                return;
            }
            let bufferToSend;
            if (resHeader) {
                bufferToSend = new Uint8Array(resHeader.byteLength + chunk.byteLength);
                bufferToSend.set(resHeader);
                bufferToSend.set(chunk, resHeader.byteLength);
                resHeader = null;
            } else {
                bufferToSend = chunk;
            }
            webSocket.send(bufferToSend);
            hasData = true;
        },
        close() {},
        abort(reason) {}
    })).catch((error) => {
        closeWebSocket(webSocket);
    });
    return hasData;
}
function base64ToBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const binaryStr = atob(normalizedStr);
        const length = binaryStr.length;
        const arrayBuffer = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            arrayBuffer[i] = binaryStr.charCodeAt(i);
        }
        return { earlyData: arrayBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}
function closeWebSocket(socket) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CLOSING) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
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
            } catch (error) {
                closeWebSocket(webSocket);
            }
        }
    }).getWriter();
    return { write: chunk => writer.write(chunk).catch(console.error) };
}
async function queryDNS(dnsRequest) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/dns-message' },
            body: dnsRequest,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return await response.arrayBuffer();
    } catch (error) {
        throw error;
    }
}
function queryDNSResponse(resHeader, dnsResponse, headerSent) {
    const sizeBuffer = new Uint8Array([(dnsResponse.byteLength >> 8) & 0xff, dnsResponse.byteLength & 0xff]);
    const resPayload = new Uint8Array((headerSent ? 0 : resHeader.byteLength) + sizeBuffer.byteLength + dnsResponse.byteLength);
    let offset = 0;
    if (!headerSent) {
        resPayload.set(resHeader, offset);
        offset += resHeader.byteLength;
    }
    resPayload.set(sizeBuffer, offset);
    resPayload.set(new Uint8Array(dnsResponse), offset + sizeBuffer.byteLength);
    return resPayload;
}
function getConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
