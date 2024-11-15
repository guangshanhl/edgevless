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
       	         port: port,
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
	let isUser = false;
	let isUDP = false;
	if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
		isUser = true;
	}
	if (!isUser) {
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
  let vlessHeader = responseHeader;
  await remoteSocket.readable.pipeTo(
    new WritableStream({
      async write(chunk, controller) {
        hasData = true;
        if (webSocket.readyState !== WebSocket.OPEN) {
          return controller.error('webSocket.readyState is close');
        }
        if (vlessHeader) {
          const combined = new Uint8Array(vlessHeader.length + chunk.byteLength);
          combined.set(new Uint8Array(vlessHeader), 0);
          combined.set(new Uint8Array(chunk), vlessHeader.length);
          webSocket.send(combined.buffer);
          vlessHeader = null;
        } else {
          webSocket.send(chunk);
        }
      },
      close() {
      },
      abort(reason) {
      }
    })
  ).catch((error) => {
    closeWebSocket(webSocket);
  });
  return hasData;
}
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
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
	return uuid;
}
async function handleUDPOutBound(webSocket, responseHeader) {
  let isHeaderSent = false;
  const processUdpChunk = (chunk) => {
    let index = 0;
    const udpPackets = [];
    while (index < chunk.byteLength) {
      const udpPacketLength = new DataView(chunk.buffer, index, 2).getUint16(0);
      const udpData = chunk.slice(index + 2, index + 2 + udpPacketLength);
      index += 2 + udpPacketLength;
      udpPackets.push(udpData);
    }
    return udpPackets;
  };
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      const udpPackets = processUdpChunk(chunk);
      udpPackets.forEach(packet => controller.enqueue(packet));
    }
  });
  transformStream.readable.pipeTo(new WritableStream({
    async write(chunk) {
      try {
        const response = await fetch('https://dns.google/dns-query', {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: chunk
        });
        const dnsQueryResult = await response.arrayBuffer();
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
        const dataToSend = isHeaderSent
          ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
          : new Uint8Array([...responseHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
        if (webSocket.readyState === WebSocket.OPEN) {
          webSocket.send(dataToSend.buffer);
          isHeaderSent = true;
        }
      } catch (error) {
      }
    }
  })).catch((error) => {
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
