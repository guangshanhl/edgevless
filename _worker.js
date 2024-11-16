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
						return new Response(`${config}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			let e = err;
			return new Response(e.toString());
		}
	},
};
async function vlessOverWSHandler(request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();
	let address = '';
	const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebStream = makeWebStream(webSocket, earlyHeader);
	let remoteSocket = {
		value: null,
	};
	let udpWrite = null;
	let isDns = false;
	readableWebStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpWrite) {
				return udpWrite(chunk);
			}
			if (remoteSocket.value) {
				const writer = remoteSocket.value.writable.getWriter()
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
			const responseHeader = new Uint8Array([vlessVersion[0], 0]);
			const clientData = chunk.slice(rawDataIndex);
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, responseHeader);
				udpWrite = write;
				udpWrite(clientData);
				return;
			}
			handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, responseHeader);
		},
		close() {
		},
		abort(reason) {
		},
	})).catch((err) => {
	});
	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, responseHeader) {
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
   	       	return forwardToData(tcpSocket, webSocket, responseHeader);
   	}
  	if (!await tryConnect(addressRemote, portRemote)) {
     	 	if (!await tryConnect(proxyIP, portRemote)) {
   	       		closeWebSocket(webSocket);
    	 	}
  	}
}
function makeWebStream(webSocket, earlyHeader) {
	let isCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocket.addEventListener('message', (event) => {
				if (isCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});
			webSocket.addEventListener('close', () => {
				closeWebSocket(webSocket);
				if (isCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocket.addEventListener('error', (err) => {
				controller.error(err);
			}
			);
			const { earlyData, error } = base64ToArrayBuffer(earlyHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},
		pull(controller) {
		},
		cancel(reason) {
			if (isCancel) {
				return;
			}
			isCancel = true;
			closeWebSocket(webSocket);
		}
	});
	return stream;
}
let cachedUserIDBytes;
function processVlessHeader(
	vlessBuffer,
	userID
) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isUDP = false;
	if (!cachedUserIDBytes) {
	    cachedUserIDBytes = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
	}
	const bufferUserID = new Uint8Array(vlessBuffer.slice(1, 17));
	if (!bufferUserID.every((byte, index) => byte === cachedUserIDBytes[index])) {
	    return {
	      hasError: true,
 	   };
  	}
	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: false,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer).getUint16(0);
	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			break;
		default:
			return {
				hasError: true,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
		};
	}
	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}
async function forwardToData(remoteSocket, webSocket, responseHeader) {
    let hasData = false;
    let buffer = [];
    let bufferSize = 0;
    const maxBufferSize = 1024 * 16;
    let responseHeaderArray = responseHeader ? new Uint8Array(responseHeader) : null;
    const sendBufferedData = async () => {
        if (bufferSize === 0) return;
        const combinedBuffer = new Uint8Array(bufferSize);
        let offset = 0;
        for (let chunk of buffer) {
            combinedBuffer.set(chunk, offset);
            offset += chunk.length;
        }
        buffer = [];
        bufferSize = 0;
        try {
            webSocket.send(combinedBuffer.buffer);
        } catch (error) {
            return false;
        }
    };
    const writableStream = new WritableStream({
        async write(chunk, controller) {
            hasData = true;
            if (responseHeaderArray) {
                const combinedBuffer = new Uint8Array(responseHeaderArray.length + chunk.byteLength);
                combinedBuffer.set(responseHeaderArray, 0);
                combinedBuffer.set(new Uint8Array(chunk), responseHeaderArray.length);
                buffer.push(combinedBuffer);
                bufferSize += combinedBuffer.byteLength;
                responseHeaderArray = null;
            } else {
                buffer.push(chunk);
                bufferSize += chunk.byteLength;
            }
            if (bufferSize >= maxBufferSize) {
                await sendBufferedData();
            }
        },
        async close() {
            await sendBufferedData();
        },
        abort(reason) {
        }
    });
    try {
        await remoteSocket.readable.pipeTo(writableStream);
    } catch (error) {
        closeWebSocket(webSocket);
    }
    return hasData;
}
function base64ToArrayBuffer(base64Str) {
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
const WEBSOCKET_READY_STATE = {
    OPEN: 1,
    CLOSING: 2
};
function closeWebSocket(socket) {
    if (socket.readyState === WEBSOCKET_READY_STATE.OPEN || socket.readyState === WEBSOCKET_READY_STATE.CLOSING) {
        socket.close();
    }
}
function handleUDPOutBound(webSocket, responseHeader) {
  let isHeaderSent = false;
  async function processUdpChunk(chunk) {
    const udpPackets = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const udpPacketLength = (chunk[offset] << 8) | chunk[offset + 1];
      const nextOffset = offset + 2 + udpPacketLength;
      if (nextOffset > chunk.byteLength) {
        throw new Error('Invalid UDP packet length');
      }
      udpPackets.push(chunk.subarray(offset + 2, nextOffset));
      offset = nextOffset;
    }
    return udpPackets;
  }
  const transformStream = new TransformStream({
    async transform(chunk, controller) {
      const udpPackets = await processUdpChunk(chunk);
      udpPackets.forEach(packet => controller.enqueue(packet));
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      try {
        const response = await fetch('https://cloudflare-dns.com/dns-query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/dns-message' },
          body: chunk
        });
        const dnsQueryResult = new Uint8Array(await response.arrayBuffer());
        const udpSizeBuffer = new Uint8Array(2);
        udpSizeBuffer[0] = (dnsQueryResult.byteLength >> 8) & 0xff;
        udpSizeBuffer[1] = dnsQueryResult.byteLength & 0xff;
        const totalSize = (isHeaderSent ? 0 : responseHeader.length) + udpSizeBuffer.length + dnsQueryResult.length;
        const outputBuffer = new Uint8Array(totalSize);
        let offset = 0;
        if (!isHeaderSent) {
          outputBuffer.set(new TextEncoder().encode(JSON.stringify(responseHeader)), offset);
          offset += responseHeader.length;
          isHeaderSent = true;
        }
        outputBuffer.set(udpSizeBuffer, offset);
        offset += udpSizeBuffer.length;
        outputBuffer.set(dnsQueryResult, offset);
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(outputBuffer);
        }
      } catch (error) {
      }
    }
  })).catch(error => {
  });
  const writer = transformStream.writable.getWriter();
  return {
    write(chunk) {
      writer.write(chunk);
    }
  };
}
function getVLESSConfig(userID, hostName) {
    return `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
