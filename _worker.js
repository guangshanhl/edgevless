import { connect } from 'cloudflare:sockets';
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';
if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
}
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;

            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader === 'websocket') {
                return await vlessOverWSHandler(request);
            }
            const url = new URL(request.url);
            switch (url.pathname) {
                case '/':
                    return new Response(JSON.stringify(request.cf), { status: 200 });
                case `/${userID}`:
                    const vlessConfig = getConfig(userID, request.headers.get('Host'));
                    return new Response(vlessConfig, {
                        status: 200,
                        headers: { 'Content-Type': 'text/plain;charset=utf-8' }
                    });
                default:
                    return new Response('Not found', { status: 404 });
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};
async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    let remoteSocket = { value: null };
    let udpStreamWrite = null;
    let isDns = false;
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
            if (remoteSocket.value) {
                await writeToSocket(remoteSocket.value, chunk);
                return;
            }
            const { hasError, message, portRemote, addressRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);
            if (hasError) throw new Error(message);
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                    const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader);
                    udpStreamWrite = write;
                    udpStreamWrite(rawClientData);
                    return;
                } else {
                    throw new Error('UDP proxy only enable for DNS which is port 53');
                }
            }
            await handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader);
        },
        close: () => console.log(`readableWebSocketStream is close`),
        abort: (reason) => console.log(`readableWebSocketStream is abort`, JSON.stringify(reason)),
    })).catch(err => console.log('readableWebSocketStream pipeTo error', err));
    return new Response(null, { status: 101, webSocket: client });
}
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    const connectAndWrite = async (address, port) => {
        const tcpSocket = connect({ hostname: address, port });
        remoteSocket.value = tcpSocket;
        await writeToSocket(tcpSocket, rawClientData);
        return tcpSocket;
    };
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, async () => {
        const retrySocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        remoteSocketToWS(retrySocket, webSocket, vlessResponseHeader);
    });
}
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (!readableStreamCancel) {
                    controller.enqueue(event.data);
                }
            });
            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (!readableStreamCancel) controller.close();
            });
            webSocketServer.addEventListener('error', (err) => controller.error(err));
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) controller.error(error);
            else if (earlyData) controller.enqueue(earlyData);
        },
        cancel(reason) {
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
            console.log(`ReadableStream was canceled, due to ${reason}`);
        }
    });
    return stream;
}
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) return { hasError: true, message: 'invalid data' };
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    const isValidUser = stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID;
    if (!isValidUser) return { hasError: true, message: 'invalid user' };
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];
    if (![1, 2].includes(command)) return { hasError: true, message: `command ${command} is not supported` };
    const isUDP = command === 2;
    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(vlessBuffer.slice(portIndex, portIndex + 2)).getUint16(0);
    const addressType = new Uint8Array(vlessBuffer.slice(portIndex + 2, portIndex + 3))[0];
    const addressValue = (addressType === 1)
        ? new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 7)).join('.')
        : (addressType === 2)
            ? new TextDecoder().decode(vlessBuffer.slice(portIndex + 4, portIndex + 4 + new Uint8Array(vlessBuffer.slice(portIndex + 3, portIndex + 4))[0]))
            : (addressType === 3)
                ? Array.from(new Uint16Array(vlessBuffer.slice(portIndex + 3, portIndex + 19)), part => part.toString(16)).join(':')
                : '';
    if (!addressValue) return { hasError: true, message: `invalid address type ${addressType}` };
    return { hasError: false, addressRemote: addressValue, portRemote, rawDataIndex: portIndex + 3 + (addressType === 2 ? 1 : 0) + (addressType === 1 ? 4 : (addressType === 3 ? 16 : 0)), vlessVersion: version, isUDP };
}
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let hasIncomingData = false;
    let vlessHeader = vlessResponseHeader;
    remoteSocket.readable.pipeTo(new WritableStream({
        async write(chunk) {
            hasIncomingData = true;
            if (webSocket.readyState !== WS_READY_STATE_OPEN) throw new Error('webSocket is not open');
            if (vlessHeader) {
                webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
                vlessHeader = null;
            } else {
                webSocket.send(chunk);
            }
        },
        close: () => console.log('remoteSocket.readable is close'),
        abort: (reason) => console.error('remoteSocket.readable abort', reason),
    })).catch(error => {
        console.error('remoteSocketToWS has exception', error);
        safeCloseWebSocket(webSocket);
    });
    if (!hasIncomingData && retry) retry();
}
async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const udpPakcetLength = new DataView(chunk.slice(index, index + 2)).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index += 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://1.1.1.1/dns-query', { method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk });
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSizeBuffer = new Uint8Array([(dnsQueryResult.byteLength >> 8) & 0xff, dnsQueryResult.byteLength & 0xff]);
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                if (isVlessHeaderSent) {
                    webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                } else {
                    webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                    isVlessHeaderSent = true;
                }
            }
        }
    })).catch(error => console.log('dns udp has error', error));
    const writer = transformStream.writable.getWriter();
    return { write: chunk => writer.write(chunk) };
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) return { error: null };
    try {
        const decode = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
        const arryBuffer = Uint8Array.from(decode, c => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
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
    if ([WS_READY_STATE_OPEN, WS_READY_STATE_CLOSING].includes(socket.readyState)) {
        socket.close();
    }
}
const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
function unsafeStringify(arr, offset = 0) {
    return `${byteToHex[arr[offset + 0]]}${byteToHex[arr[offset + 1]]}${byteToHex[arr[offset + 2]]}${byteToHex[arr[offset + 3]]}-${byteToHex[arr[offset + 4]]}${byteToHex[arr[offset + 5]]}-${byteToHex[arr[offset + 6]]}${byteToHex[arr[offset + 7]]}-${byteToHex[arr[offset + 8]]}${byteToHex[arr[offset + 9]]}-${byteToHex[arr[offset + 10]]}${byteToHex[arr[offset + 11]]}${byteToHex[arr[offset + 12]]}${byteToHex[arr[offset + 13]]}${byteToHex[arr[offset + 14]]}${byteToHex[arr[offset + 15]]}`.toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) throw TypeError("Stringified UUID is invalid");
    return uuid;
}
function getConfig(userID, hostName) {
    return `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
}
