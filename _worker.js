// <!--GAMFC-->version base on commit 841ed4e9ff121dde0ed6a56ae800c2e6c4f66056, time is 2024-04-16 18:02:37 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}
export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
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
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
						return new Response(`${vlessConfig}`, {
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
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};
/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {
	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);
	webSocket.accept();
	let address = '';
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns && udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
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
				throw new Error(message);
				return;
			}
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					throw new Error('UDP proxy only enable for DNS which is port 53');
					return;
				}
			}
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);
			if (isDns) {
				const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
				udpStreamWrite = write;
				udpStreamWrite(rawClientData);
				return;
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
		},
		close() {
		},
		abort(reason) {
		},
	})).catch((err) => {
	});
	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}
/**
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		let tcpSocket = remoteSocket.value;
	        if (!tcpSocket || tcpSocket.closed) {
                  tcpSocket = connect({
                    hostname: address,
                    port: port,
                  });
                  remoteSocket.value = tcpSocket;
                }
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		tcpSocket.closed.catch(error => {
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null);
	}
	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}
/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
	let readableStreamCancel = false;
	let backpressureQueue = [];
	function handleCancel() {
		if (readableStreamCancel) return true;
		readableStreamCancel = true;
		safeCloseWebSocket(webSocketServer);
		return false;
	}
	const stream = new ReadableStream({
		start(controller) {
			const messageHandler = (event) => {
				if (readableStreamCancel) return;
				if (controller.desiredSize <= 0) {
					backpressureQueue.push(event.data);
				} else {
					controller.enqueue(event.data);
				}
			};

			const closeHandler = () => {
				if (handleCancel()) return;
				controller.close();
			};

			const errorHandler = (err) => {
				controller.error(err);
			};

			webSocketServer.addEventListener('message', messageHandler);
			webSocketServer.addEventListener('close', closeHandler);
			webSocketServer.addEventListener('error', errorHandler);

			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}

			this._cleanup = () => {
				webSocketServer.removeEventListener('message', messageHandler);
				webSocketServer.removeEventListener('close', closeHandler);
				webSocketServer.removeEventListener('error', errorHandler);
			};
		},
		pull(controller) {
			if (backpressureQueue.length > 0) {
				controller.enqueue(backpressureQueue.shift());
			}
		},
		cancel(reason) {
			if (handleCancel()) return;
			this._cleanup();
		}
	});
	return stream;
}
/**
 * 
 * @param { ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns 
 */
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
	let isValidUser = false;
	let isUDP = false;
	if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
		isValidUser = true;
	}
	if (!isValidUser) {
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
			hasError: true,
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
/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false;
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						webSocket.send(chunk);
					}
				},
				close() {
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});
	if (hasIncomingData === false && retry) {
		retry();
	}
}
/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
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
/**
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
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
/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {
		},
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {
		}
	});
	transformStream.readable.pipeTo(new WritableStream({
		async write(chunk) {
			const resp = await fetch('https://1.1.1.1/dns-query',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				if (isVlessHeaderSent) {
					webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
				} else {
					webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
					isVlessHeaderSent = true;
				}
			}
		}
	})).catch((error) => {
	});
	const writer = transformStream.writable.getWriter();
	return {
		/**
		 * 
		 * @param {Uint8Array} chunk 
		 */
		write(chunk) {
			writer.write(chunk);
		}
	};
}
/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`
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
