import { connect } from 'cloudflare:sockets';

let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

// MUX 相关常量
const MUX_PACKET_HEADER_SIZE = 5;
const MUX_NEW_CONN = 0x01;
const MUX_DATA = 0x02;
const MUX_CLOSE = 0x03;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

class MuxSessionManager {
    constructor() {
        this.sessions = new Map();
        this.nextSessionId = 1;
    }

    createSession(webSocket, vlessResponseHeader) {
        const sessionId = this.nextSessionId++;
        const session = new MuxSession(sessionId, webSocket, vlessResponseHeader);
        this.sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }

    removeSession(sessionId) {
        this.sessions.delete(sessionId);
    }
}

class MuxSession {
    constructor(sessionId, webSocket, vlessResponseHeader) {
        this.sessionId = sessionId;
        this.webSocket = webSocket;
        this.vlessResponseHeader = vlessResponseHeader;
        this.subConnections = new Map();
    }

    async handleMuxPacket(packet) {
        const cmd = packet[0];
        const sessionId = new DataView(packet.buffer).getUint16(1);
        
        switch(cmd) {
            case MUX_NEW_CONN:
                await this.handleNewConnection(sessionId, packet.slice(MUX_PACKET_HEADER_SIZE));
                break;
            case MUX_DATA:
                await this.handleData(sessionId, packet.slice(MUX_PACKET_HEADER_SIZE));
                break;
            case MUX_CLOSE:
                await this.handleClose(sessionId);
                break;
        }
    }

    async handleNewConnection(sessionId, data) {
        const subConn = {
            id: sessionId,
            socket: null,
            buffer: []
        };
        
        const {addressRemote, portRemote} = processVlessHeader(data, userID);
        
        try {
            const socket = await connect({
                hostname: addressRemote,
                port: portRemote
            });
            
            subConn.socket = socket;
            this.subConnections.set(sessionId, subConn);

            while(subConn.buffer.length > 0) {
                const writer = socket.writable.getWriter();
                await writer.write(subConn.buffer.shift());
                writer.releaseLock();
            }

            this.setupDataForwarding(sessionId, socket);

        } catch(error) {
            this.sendMuxClose(sessionId);
        }
    }

    async handleData(sessionId, data) {
        const subConn = this.subConnections.get(sessionId);
        if (!subConn) {
            this.sendMuxClose(sessionId);
            return;
        }

        if (subConn.socket) {
            const writer = subConn.socket.writable.getWriter();
            await writer.write(data);
            writer.releaseLock();
        } else {
            subConn.buffer.push(data);
        }
    }

    async handleClose(sessionId) {
        const subConn = this.subConnections.get(sessionId);
        if (subConn && subConn.socket) {
            subConn.socket.close();
        }
        this.subConnections.delete(sessionId);
    }

    setupDataForwarding(sessionId, socket) {
        socket.readable.pipeTo(new WritableStream({
            write: async (chunk) => {
                if (this.webSocket.readyState === WS_READY_STATE_OPEN) {
                    const muxData = new Uint8Array(chunk.byteLength + MUX_PACKET_HEADER_SIZE);
                    muxData[0] = MUX_DATA;
                    new DataView(muxData.buffer).setUint16(1, sessionId);
                    muxData.set(new Uint8Array(chunk), MUX_PACKET_HEADER_SIZE);
                    
                    this.webSocket.send(muxData);
                }
            },
            close: () => {
                this.sendMuxClose(sessionId);
            }
        })).catch(() => {
            this.sendMuxClose(sessionId);
        });
    }

    sendMuxClose(sessionId) {
        if (this.webSocket.readyState === WS_READY_STATE_OPEN) {
            const closePacket = new Uint8Array(3);
            closePacket[0] = MUX_CLOSE;
            new DataView(closePacket.buffer).setUint16(1, sessionId);
            this.webSocket.send(closePacket);
        }
    }
}

export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;

            if (!isValidUUID(userID)) {
                throw new Error('uuid is not valid');
            }

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
            return new Response(err.toString());
        }
    },
};

async function vlessOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);
    webSocket.accept();

    let remoteSocketWapper = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;
    
    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader);
    
    const muxManager = new MuxSessionManager();

    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocketWapper.value) {
                const writer = remoteSocketWapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const result = processVlessHeader(chunk, userID);
            
            if (result.hasError) {
                throw new Error(result.message);
            }

            if (result.isMux) {
                await result.session.handleMuxPacket(chunk.slice(result.rawDataIndex));
                return;
            }

            if (result.isUDP) {
                if (result.portRemote === 53) {
                    isDns = true;
                    const { write } = await handleUDPOutBound(webSocket, result.vlessResponseHeader);
                    udpStreamWrite = write;
                    udpStreamWrite(chunk.slice(result.rawDataIndex));
                } else {
                    throw new Error('UDP proxy only enable for DNS which is port 53');
                }
            } else {
                await handleTCPOutBound(
                    remoteSocketWapper,
                    result.addressRemote,
                    result.portRemote,
                    chunk.slice(result.rawDataIndex),
                    webSocket,
                    result.vlessResponseHeader
                );
            }
        }
    })).catch((err) => {
        console.error('Stream processing error:', err);
    });

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });

            webSocketServer.addEventListener('close', () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });

            webSocketServer.addEventListener('error', (err) => {
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {
        },
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        }
    });
    return stream;
}

function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: 'invalid data',
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
            message: 'invalid user',
        };
    }

    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(vlessBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    if (command === 1) {
        // TCP
    } else if (command === 2) {
        isUDP = true;
    } else if (command === 3) {
        // MUX
        return {
            hasError: false,
            isMux: true,
            session: muxManager.createSession(webSocket, vlessResponseHeader),
            rawDataIndex: addressValueIndex + addressLength,
            vlessVersion: version
        };
    } else {
        return {
            hasError: true,
            message: `command ${command} is not supported, valid commands: 01-tcp, 02-udp, 03-mux`,
        };
    }

    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(vlessBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = '';

    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join('.');
            break;
        case 2:
            addressLength = new Uint8Array(vlessBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(':');
            break;
        default:
            return {
                hasError: true,
                message: `invalid addressType is ${addressType}`,
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

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader) {
    async function connectAndWrite(address, port) {
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });
        remoteSocket.value = tcpSocket;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote);
        tcpSocket.closed.catch(error => {
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
    }

    const tcpSocket = await connectAndWrite(addressRemote, portRemote);
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry);
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry) {
    let vlessHeader = vlessResponseHeader;
    let hasIncomingData = false;
    
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                start() {
                },
                async write(chunk, controller) {
                    hasIncomingData = true;
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        controller.error('webSocket.readyState is not open, maybe close');
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
                }
            })
        )
        .catch((error) => {
            safeCloseWebSocket(webSocket);
        });

    if (hasIncomingData === false && retry) {
        retry();
    }
}

async function handleUDPOutBound(webSocket, vlessResponseHeader) {
    let isVlessHeaderSent = false;
    
    const transformStream = new TransformStream({
        start(controller) {
        },
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
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
                });
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
        write(chunk) {
            writer.write(chunk);
        }
    };
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

function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
    }
}

function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
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

function getVLESSConfig(userID, hostName) {
    const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
    
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
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}
