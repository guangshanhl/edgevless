import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP; 
            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader && upgradeHeader === 'websocket') {
                return await ressOverWSHandler(request);
            }                       
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
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function ressOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
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
                ressVersion = new Uint8Array([0, 0]),
                isUDP,
            } = processRessHeader(chunk, userID);
            if (hasError) return;
            if (isUDP && portRemote === 53) {
                isDns = true;
            } else if (isUDP) {
                return;
            }
            const resHeader = new Uint8Array([ressVersion[0], 0]);
            const clientData = chunk.slice(rawDataIndex);
            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, resHeader);
                udpWrite = write;
                udpWrite(clientData);
                return;
            }
            handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader);
        },
    })).catch((err) => {
        closeWebSocket(webSocket);
    });
    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, clientData, webSocket, resHeader) {
    async function connectAndPipe(address, port) {
        const tcpSocket = connect({ hostname: address, port });
	remoteSocket.value = tcpSocket;   
        const writer = tcpSocket.writable.getWriter();
        await writer.write(clientData);
        try {
            await writer.write(clientData);
        } finally {
            writer.releaseLock();
        }
        let hasData = false;
        await remoteSocket.readable.pipeTo(new WritableStream({
            write(chunk) {
                let dataToSend;
		if (resHeader) {
		    dataToSend = new Uint8Array(resHeader.length + chunk.byteLength);
		    dataToSend.set(resHeader, 0);
		    dataToSend.set(new Uint8Array(chunk), resHeader.length);
		    resHeader = null;
		} else {
		    dataToSend = chunk;
		}
                if (webSocket.readyState === 1) {
                    webSocket.send(dataToSend);
                    hasData = true;
                }
            }
        })).catch(() => closeWebSocket(webSocket));
        return hasData;
    }
    if (!(await connectAndPipe(addressRemote, portRemote))) {
        await connectAndPipe(proxyIP, portRemote);
    }
}
function makeWebStream(webSocket, earlyHeader) {
    let isCancel = false;
    const handleMessage = (event, controller) => {
        if (!isCancel) {
            controller.enqueue(event.data);
        }
    };
    const handleClose = (controller) => {
        if (!isCancel) {
            controller.close();
            closeWebSocket(webSocket);
        }
    };
    const handleError = (err, controller) => {
        controller.error(err);
        closeWebSocket(webSocket);
    };
    const decodeBase64ToBuffer = (base64Str) => {
        try {
            const normalizedStr = base64Str.replace(/-/g, '+').replace(/_/g, '/');
            const binaryStr = atob(normalizedStr);
            const length = binaryStr.length;
            const arrayBuffer = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                arrayBuffer[i] = binaryStr.charCodeAt(i);
            }
            return arrayBuffer.buffer;
        } catch {
            return null;
        }
    };
    const stream = new ReadableStream({
        start(controller) {
            webSocket.addEventListener('message', (event) => handleMessage(event, controller));
            webSocket.addEventListener('close', () => handleClose(controller));
            webSocket.addEventListener('error', (err) => handleError(err, controller));
            if (earlyHeader) {
                const earlyDataBuffer = decodeBase64ToBuffer(earlyHeader);
                if (earlyDataBuffer) {
                    controller.enqueue(earlyDataBuffer);
                } else {
                    controller.error(error);
                }
            }
        },
        cancel(reason) {
            if (!isCancel) {
                isCancel = true;
                closeWebSocket(webSocket);
            }
        }
    });
    return stream;
}
let cachedUserID;
function processRessHeader(ressBuffer, userID) {
    if (ressBuffer.byteLength < 24) return { hasError: true };
    const version = new Uint8Array(ressBuffer.slice(0, 1));
    let isUDP = false;
    if (!cachedUserID) {
        cachedUserID = new Uint8Array(userID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16)));
    }
    const bufferUserID = new Uint8Array(ressBuffer.slice(1, 17));
    const hasError = bufferUserID.some((byte, index) => byte !== cachedUserID[index]);
    if (hasError) return { hasError: true };
    const optLength = new Uint8Array(ressBuffer.slice(17, 18))[0];
    const command = new Uint8Array(ressBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (command === 2) isUDP = true;
    if (command !== 1 && command !== 2) return { hasError: false };
    const portIndex = 18 + optLength + 1;
    const portBuffer = ressBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(ressBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(ressBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(ressBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
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
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        ressVersion: version,
        isUDP,
    };
}
function closeWebSocket(socket) {
    if (socket.readyState === 1 || socket.readyState === 2) {
        socket.close();
    }
}
async function handleUDPOutBound(webSocket, resHeader) {
	let headerSent = false;
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
			const resp = await fetch('https://dns.google/dns-query',
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
			const payload = headerSent
        	            ? new Uint8Array([...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)])
        	            : new Uint8Array([...resHeader, ...udpSizeBuffer, ...new Uint8Array(dnsQueryResult)]);
          		headerSent = true;
         		if (webSocket.readyState === 1) {
          			webSocket.send(payload);
           	     	}
		}
	}));
	const writer = transformStream.writable.getWriter();
	return {
		write(chunk) {
			writer.write(chunk);
		}
	};
}
function getConfig(userID, hostName) {
    return `yless://${userID}\u0040${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
