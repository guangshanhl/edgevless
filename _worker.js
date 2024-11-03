import { connect } from 'cloudflare:sockets';
const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
class VLESSHandler {
    constructor(userID, proxyIP) {
        this.userID = userID;
        this.proxyIP = proxyIP;
    }
    async handleRequest(request) {
        return request.headers.get('Upgrade') === 'websocket'
            ? this.handleWebSocket(request)
            : this.handleHTTP(request);
    }
    handleHTTP(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (path === "/") {
            return new Response(JSON.stringify(request.cf, null, 4));
        }
        if (path === `/${this.userID}`) {
            return new Response(
                this.generateConfig(request.headers.get("Host")),
                { headers: { "Content-Type": "text/plain;charset=utf-8" }}
            );
        }
        return new Response("Not found", { status: 404 });
    }
    async handleWebSocket(request) {
        const [client, webSocket] = Object.values(new WebSocketPair());
        webSocket.accept();
        const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
        const remoteSocket = { value: null };
        let udpWriter = null;
        const readableStream = this.createReadableStream(webSocket, earlyDataHeader);
        const writableStream = this.createWritableStream(webSocket, remoteSocket, udpWriter);
        readableStream.pipeTo(writableStream).catch(() => this.closeWebSocket(webSocket));
        return new Response(null, { status: 101, webSocket: client });
    }
    createReadableStream(webSocket, earlyDataHeader) {
        return new ReadableStream({
            start: (controller) => {
                const { earlyData, error } = this.parseEarlyData(earlyDataHeader);
                if (error) {
                    controller.error(error);
                    return;
                }
                if (earlyData) {
                    controller.enqueue(earlyData);
                }
                webSocket.addEventListener('message', e => controller.enqueue(e.data));
                webSocket.addEventListener('close', () => {
                    this.closeWebSocket(webSocket);
                    controller.close();
                });
                webSocket.addEventListener('error', e => controller.error(e));
            },
            cancel: () => this.closeWebSocket(webSocket)
        });
    }
    createWritableStream(webSocket, remoteSocket, udpWriter) {
        return new WritableStream({
            write: async (chunk) => {
                if (udpWriter) {
                    return udpWriter(chunk);
                }
                if (remoteSocket.value) {
                    await this.writeToRemote(remoteSocket.value, chunk);
                    return;
                }
                const header = this.parseVLESSHeader(chunk);
                if (!header || header.hasError) return;
                const responseHeader = new Uint8Array([header.version[0], 0]);
                const data = chunk.slice(header.dataIndex);
                if (header.isUDP && header.port === 53) {
                    const dnsHandler = await this.createDNSHandler(webSocket, responseHeader);
                    udpWriter = dnsHandler.write;
                    udpWriter(data);
                    return;
                }
                await this.handleTCPConnection(
                    remoteSocket,
                    header.address,
                    header.port,
                    data,
                    webSocket,
                    responseHeader
                );
            }
        });
    }
    async writeToRemote(socket, chunk) {
        const writer = socket.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
    }
    async handleTCPConnection(remoteSocket, address, port, data, webSocket, responseHeader) {
        const connect = async (addr) => {
            try {
                if (!remoteSocket.value || remoteSocket.value.closed) {
                    remoteSocket.value = await connect({
                        hostname: addr,
                        port: port
                    });
                }
                await this.writeToRemote(remoteSocket.value, data);
                return await this.forwardData(remoteSocket.value, webSocket, responseHeader);
            } catch {
                return false;
            }
        };
        if (!(await connect(address)) && this.proxyIP && !(await connect(this.proxyIP))) {
            this.closeWebSocket(webSocket);
        }
    }
    async forwardData(remoteSocket, webSocket, responseHeader) {
        let hasData = false;
        let needHeader = Boolean(responseHeader);
        try {
            await remoteSocket.readable.pipeTo(new WritableStream({
                write: (chunk) => {
                    if (webSocket.readyState !== WebSocket.OPEN) {
                        throw new Error("WebSocket closed");
                    }
                    if (needHeader) {
                        const combined = new Uint8Array(responseHeader.length + chunk.byteLength);
                        combined.set(responseHeader);
                        combined.set(new Uint8Array(chunk), responseHeader.length);
                        webSocket.send(combined);
                        needHeader = false;
                    } else {
                        webSocket.send(chunk);
                    }
                    hasData = true;
                }
            }));
        } catch {
            this.closeWebSocket(webSocket);
        }
        return hasData;
    }
    async createDNSHandler(webSocket, responseHeader) {
        const transformStream = new TransformStream({
            async transform(chunk, controller) {
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const size = new DataView(chunk.buffer, offset, 2).getUint16(0);
                    const data = chunk.subarray(offset + 2, offset + 2 + size);
                    offset += 2 + size;
                    const dnsResponse = await this.handleDNSRequest(data);
                    const responseSize = dnsResponse.byteLength;
                    const header = new Uint8Array([(responseSize >> 8) & 0xff, responseSize & 0xff]);
                    if (webSocket.readyState === WebSocket.OPEN) {
                        webSocket.send(new Uint8Array([...responseHeader, ...header, ...new Uint8Array(dnsResponse)]));
                    }
                }
                controller.terminate();
            }
        });
        return {
            write: chunk => transformStream.writable.getWriter().write(chunk)
        };
    }
    async handleDNSRequest(query) {
        const response = await fetch("https://1.1.1.1/dns-query", {
            method: "POST",
            headers: {
                accept: "application/dns-message",
                "content-type": "application/dns-message",
            },
            body: query,
        });
        return response.arrayBuffer();
    }
    parseVLESSHeader(buffer) {
        const bytes = new Uint8Array(buffer);
        if (this.stringifyUUID(bytes.subarray(1, 17)) !== this.userID) {
            return { hasError: true };
        }
        const optLength = bytes[17];
        const cmdStart = 18 + optLength;
        const isUDP = bytes[cmdStart] === 2;
        const port = (bytes[cmdStart + 1] << 8) | bytes[cmdStart + 2];
        const addressInfo = this.parseAddress(bytes, cmdStart + 3);
        return {
            hasError: false,
            version: bytes.subarray(0, 1),
            isUDP,
            port,
            address: addressInfo.address,
            dataIndex: addressInfo.dataIndex
        };
    }
    parseAddress(bytes, start) {
        const addressType = bytes[start];
        const addressLength = addressType === 2 ? bytes[start + 1] : (addressType === 1 ? 4 : 16);
        const valueStart = start + (addressType === 2 ? 2 : 1);
        const valueEnd = valueStart + addressLength;
        let address;
        if (addressType === 1) {
            address = bytes.subarray(valueStart, valueEnd).join('.');
        } else if (addressType === 2) {
            address = new TextDecoder().decode(bytes.subarray(valueStart, valueEnd));
        } else {
            address = Array.from(bytes.subarray(valueStart, valueEnd))
                .map(b => b.toString(16).padStart(2, '0'))
                .join(':');
        }
        return { address, dataIndex: valueEnd };
    }
    stringifyUUID(arr) {
        const hexTable = new Array(256).fill(0).map((_, i) => (i + 256).toString(16).slice(1));
        const template = [4, 2, 2, 2, 6];
        let offset = 0;
        return template
            .map(len => Array(len).fill()
                .map(() => hexTable[arr[offset++]])
                .join('')
            )
            .join('-')
            .toLowerCase();
    }
    parseEarlyData(str) {
        try {
            if (str instanceof ArrayBuffer || str instanceof Uint8Array) {
                return { earlyData: str };
            }
            const binary = atob(str.replace(/[-_]/g, m => m === '-' ? '+' : '/'));
            const buffer = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
                buffer[i] = binary.charCodeAt(i);
            }
            return { earlyData: buffer.buffer };
        } catch (error) {
            return { error };
        }
    }
    closeWebSocket(ws) {
        if (ws.readyState <= WebSocket.CLOSING) {
            ws.close();
        }
    }
    generateConfig(host) {
        return `vless://${this.userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`;
    }
}
export default {
    async fetch(request, env) {
        const handler = new VLESSHandler(
            env.UUID || DEFAULT_UUID,
            env.PROXYIP || ''
        );        
        try {
            return await handler.handleRequest(request);
        } catch (err) {
            return new Response(err.toString());
        }
    }
};
