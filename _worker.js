import { connect } from 'cloudflare:sockets';
const DEFAULT_UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const DNS_PORT = 53;
const WS_READY_STATE = { OPEN: 1, CLOSING: 2 };
const ADDRESS_TYPES = { IPV4: 1, DOMAIN: 2, IPV6: 3 };
export default {
  async fetch(request, env) {
    const userID = env.UUID || DEFAULT_UUID;
    const proxyIP = env.PROXYIP || '';   
    try {
      return request.headers.get('Upgrade') === 'websocket' 
        ? handleWs(request, userID, proxyIP)
        : handleHttp(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
function handleHttp(request, userID) {
  const url = new URL(request.url); 
  if (url.pathname === "/") {
    return new Response(JSON.stringify(request.cf, null, 4));
  } 
  if (url.pathname === `/${userID}`) {
    const host = request.headers.get("Host");
    return new Response(
      `vless://${userID}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}`,
      { headers: { "Content-Type": "text/plain;charset=utf-8" }}
    );
  } 
  return new Response("Not found", { status: 404 });
}
async function handleWs(request, userID, proxyIP) {
  const [clientSocket, serverSocket] = new WebSocketPair();
  serverSocket.accept();
  const streams = createBidirectionalStream(serverSocket, request.headers.get('sec-websocket-protocol'));
  const handler = new ConnectionHandler(serverSocket, userID, proxyIP); 
  streams.readable.pipeTo(handler.writable).catch(() => closeSocket(serverSocket));
  return new Response(null, { 
    status: 101, 
    webSocket: clientSocket 
  });
}
class ConnectionHandler {
  constructor(serverSocket, userID, proxyIP) {
    this.serverSocket = serverSocket;
    this.userID = userID;
    this.proxyIP = proxyIP;
    this.remoteSocket = null;
    this.dnsWriter = null;
    this.isDns = false;
    this.resHeader = new Uint8Array(2);   
    this.writable = new WritableStream({
      write: chunk => this.handleChunk(chunk)
    });
  }
  async handleChunk(chunk) {
    if (this.isDns && this.dnsWriter) {
      return this.dnsWriter(chunk);
    }
    if (this.remoteSocket) {
      const writer = this.remoteSocket.writable.getWriter();
      await writer.write(chunk);
      writer.releaseLock();
      return;
    }
    const header = this.parseHeader(chunk);
    if (!header) return;
    this.resHeader[0] = header.version[0];
    this.resHeader[1] = 0;
    const data = chunk.slice(header.dataIndex);
    this.isDns = header.isUDP && header.port === DNS_PORT;
    if (this.isDns) {
      const dnsHandler = await this.createDnsHandler();
      this.dnsWriter = dnsHandler.write;
      this.dnsWriter(data);
      return;
    }
    await this.handleTcpConnection(header.address, header.port, data);
  }
  parseHeader(chunk) {
    const bytes = new Uint8Array(chunk);
    const receivedID = this.bytesToUUID(bytes.subarray(1, 17));   
    if (receivedID !== this.userID) return null;
    const optLength = bytes[17];
    const cmdStart = 18 + optLength;
    const command = bytes[cmdStart];
    const port = new DataView(bytes.buffer).getUint16(cmdStart + 1);   
    return {
      version: bytes.subarray(0, 1),
      isUDP: command === 2,
      port,
      ...this.parseAddress(bytes, cmdStart + 3),
    };
  }
  parseAddress(bytes, start) {
    const addressType = bytes[start];
    const addressLength = addressType === ADDRESS_TYPES.DOMAIN 
      ? bytes[start + 1] 
      : (addressType === ADDRESS_TYPES.IPV4 ? 4 : 16);   
    const valueStart = start + (addressType === ADDRESS_TYPES.DOMAIN ? 2 : 1);
    const addressBytes = bytes.subarray(valueStart, valueStart + addressLength);    
    return {
      address: this.getAddressString(addressType, addressBytes),
      dataIndex: valueStart + addressLength
    };
  }
  getAddressString(type, bytes) {
    switch(type) {
      case ADDRESS_TYPES.IPV4:
        return Array.from(bytes).join('.');
      case ADDRESS_TYPES.DOMAIN:
        return new TextDecoder().decode(bytes);
      case ADDRESS_TYPES.IPV6:
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(':');
    }
  }
  async handleTcpConnection(address, port, data) {
    const tryConnect = async (addr) => {
      try {
        this.remoteSocket = await this.connectTcp(addr, port, data);
        return await this.forwardData();
      } catch {
        return false;
      }
    };
    if (!(await tryConnect(address) || await tryConnect(this.proxyIP))) {
      closeSocket(this.serverSocket);
    }
  }
  async connectTcp(addr, port, data) {
    const socket = connect({
      hostname: addr,
      port,
      allowHalfOpen: false,
      secureTransport: 'on'
    });
    const writer = socket.writable.getWriter();
    await writer.write(data);
    writer.releaseLock();    
    return socket;
  }
  async forwardData() {
    let hasData = false;
    let headerSent = true;
    const writer = new WritableStream({
      write: chunk => {
        if (this.serverSocket.readyState !== WS_READY_STATE.OPEN) {
          throw new Error('WebSocket closed');
        }
        if (headerSent) {
          const combined = new Uint8Array(this.resHeader.length + chunk.length);
          combined.set(this.resHeader);
          combined.set(new Uint8Array(chunk), this.resHeader.length);
          this.serverSocket.send(combined);
          headerSent = false;
        } else {
          this.serverSocket.send(chunk);
        }
        hasData = true;
      }
    });
    try {
      await this.remoteSocket.readable.pipeTo(writer);
    } catch {
      closeSocket(this.serverSocket);
    }
    return hasData;
  }
  async createDnsHandler() {
    const buffer = [];
    let headerSent = false;
    return {
      write: async chunk => {
        buffer.push(chunk);
        if (buffer.length >= 64) {
          await this.processDnsChunks(buffer, headerSent);
          headerSent = true;
          buffer.length = 0;
        }
      }
    };
  }
  async processDnsChunks(chunks, sentHeader) {
    for (const chunk of chunks) {
      const response = await this.queryDns(chunk);
      if (!response) continue;
      const size = response.byteLength;
      const sizeBuffer = new Uint8Array([size >> 8, size & 0xff]);     
      const data = !sentHeader
        ? Buffer.concat([this.resHeader, sizeBuffer, new Uint8Array(response)])
        : Buffer.concat([sizeBuffer, new Uint8Array(response)]);
      if (this.serverSocket.readyState === WS_READY_STATE.OPEN) {
        this.serverSocket.send(data);
      }
    }
  }
  async queryDns(packet) {
    try {
      const response = await fetch("https://cloudflare-dns.com/dns-query", {
        method: "POST",
        headers: {
          accept: "application/dns-message",
          "content-type": "application/dns-message",
        },
        body: packet
      });
      return response.arrayBuffer();
    } catch {
      return null;
    }
  }
  bytesToUUID(bytes) {
    const segments = [4, 2, 2, 2, 6];
    let offset = 0;
    return segments
      .map(len => {
        let str = '';
        for (let i = 0; i < len; i++) {
          str += bytes[offset++].toString(16).padStart(2, '0');
        }
        return str;
      })
      .join('-');
  }
}
function createBidirectionalStream(socket, earlyDataHeader) {
  return {
    readable: new ReadableStream({
      start(controller) {
        if (earlyDataHeader) {
          const data = parseEarlyData(earlyDataHeader);
          if (data) controller.enqueue(data);
        }
        socket.addEventListener('message', e => controller.enqueue(e.data));
        socket.addEventListener('close', () => controller.close());
        socket.addEventListener('error', e => controller.error(e));
      },
      cancel() {
        closeSocket(socket);
      }
    })
  };
}
function parseEarlyData(data) {
  if (!data) return null;
  try {
    if (data instanceof ArrayBuffer) return data;
    const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  } catch {
    return null;
  }
}
function closeSocket(socket, code = 1000, reason = 'Normal Closure') {
  if (socket.readyState <= WS_READY_STATE.CLOSING) {
    socket.close(code, reason);
  }
}
