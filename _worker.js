import { connect } from 'cloudflare:sockets';
export default {
  async fetch(request, env) {
    const userID = env.UUID || 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const proxyIP = env.PROXYIP || '';
    try {
      return request.headers.get('Upgrade') === 'websocket' 
        ? handleWsRequest(request, userID, proxyIP)
        : handleHttpRequest(request, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
function handleHttpRequest(request, userID) {
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
async function handleWsRequest(request, userID, proxyIP) {
  const [client, server] = new WebSocketPair();
  server.accept();
  const earlyData = request.headers.get('sec-websocket-protocol');
  let remote = null;
  let udpWriter = null;
  let isDns = false;
  const responseHeader = new Uint8Array(2);
  const readable = createReadableStream(server, earlyData);
  const writable = createWritableStream(server, responseHeader, userID, proxyIP);
  readable.pipeTo(writable).catch(() => closeWs(server));
  return new Response(null, { status: 101, webSocket: client });
}
function createReadableStream(server, earlyData) {
  return new ReadableStream({
    start(controller) {
      if(earlyData) {
        try {
          controller.enqueue(base64ToArrayBuffer(earlyData));
        } catch(e) {}
      }
      server.addEventListener('message', e => controller.enqueue(e.data));
      server.addEventListener('close', () => controller.close());
      server.addEventListener('error', e => controller.error(e));
    }
  });
}
function createWritableStream(server, responseHeader, userID, proxyIP, remote, udpWriter, isDns) {
  return new WritableStream({
    async write(chunk) {
      if(isDns && udpWriter) {
        return udpWriter(chunk);
      }   
      if(remote) {
        const writer = remote.writable.getWriter();
        await writer.write(chunk);
        writer.releaseLock();
        return;
      }
      const header = parseHeader(chunk, userID);
      if(!header) return;    
      responseHeader[0] = chunk[0];
      responseHeader[1] = 0;
      isDns = header.isUdp && header.port === 53;
      const data = chunk.slice(header.dataIndex);
      if(isDns) {
        udpWriter = await setupUdpProxy(server, responseHeader, data);
        return;
      }
      remote = await setupTcpProxy(header.address, header.port, data, server, responseHeader, proxyIP);
    }
  });
}
function parseHeader(chunk, userID) {
  const bytes = new Uint8Array(chunk);
  if(bytes.length < 18) return null; 
  const id = bytesToHex(bytes.slice(1, 17));
  if(id !== userID) return null;
  const optLen = bytes[17];
  const cmdStart = 18 + optLen;
  if(bytes.length < cmdStart + 3) return null;
  const isUdp = bytes[cmdStart] === 2;
  const port = (bytes[cmdStart + 1] << 8) | bytes[cmdStart + 2];
  const addrInfo = parseAddress(bytes, cmdStart + 3); 
  return { isUdp, port, ...addrInfo };
}
function parseAddress(bytes, start) {
  const type = bytes[start];
  const addrLen = type === 2 ? bytes[start + 1] : (type === 1 ? 4 : 16);
  const addrStart = start + (type === 2 ? 2 : 1);
  const addr = type === 1 
    ? Array.from(bytes.slice(addrStart, addrStart + addrLen)).join('.')
    : type === 2
    ? new TextDecoder().decode(bytes.slice(addrStart, addrStart + addrLen))
    : Array.from(bytes.slice(addrStart, addrStart + addrLen))
        .map(b => b.toString(16).padStart(2, '0')).join(':');
  return { address: addr, dataIndex: addrStart + addrLen };
}
async function setupTcpProxy(address, port, data, server, responseHeader, proxyIP) {
  const tryConnect = async (addr) => {
    try {
      const socket = await connect({
        hostname: addr,
        port,
        allowHalfOpen: false,
        secureTransport: true
      });     
      const writer = socket.writable.getWriter();
      await writer.write(data);
      writer.releaseLock();
	    let hasData = false; 
      socket.readable
        .pipeTo(new WritableStream({
          async write(chunk) {
            if(server.readyState !== 1) controller.error('WebSocket closed');
            if(responseHeader) {
              const combined = new Uint8Array(responseHeader.length + chunk.length);
              combined.set(responseHeader);
              combined.set(new Uint8Array(chunk), responseHeader.length);
              server.send(combined);
              responseHeader = null;
            } else {
              server.send(chunk);
            }
	      		hasData = true;
          }
        }))
        .catch(() => closeWs(server));
  		return hasData;
      return socket;
    } catch {
      return false;
    }
  };
  return !(await tryConnect(address)) || !(await tryConnect(proxyIP)) || (closeWs(server), null);
}
async function setupUdpProxy(server, responseHeader, initialData) {
  let headerSent = false; 
  const transform = new TransformStream({
    async transform(chunk, controller) {
      let offset = 0;
      while(offset < chunk.byteLength) {
        const size = new DataView(chunk.buffer, offset, 2).getUint16(0);
        const data = chunk.slice(offset + 2, offset + 2 + size);
        offset += 2 + size;
        const dnsResponse = await fetch("https://1.1.1.1/dns-query", {
          method: "POST",
          headers: {
            "accept": "application/dns-message",
            "content-type": "application/dns-message"
          },
          body: data
        }).then(r => r.arrayBuffer());
        const respSize = dnsResponse.byteLength;
        const sizeBuffer = new Uint8Array([respSize >> 8, respSize & 0xff]);       
        const packet = headerSent
          ? new Uint8Array(2 + respSize)
          : new Uint8Array(responseHeader.length + 2 + respSize);
        if(!headerSent) {
          packet.set(responseHeader);
          packet.set(sizeBuffer, responseHeader.length);
          packet.set(new Uint8Array(dnsResponse), responseHeader.length + 2);
          headerSent = true;
        } else {
          packet.set(sizeBuffer);
          packet.set(new Uint8Array(dnsResponse), 2);
        }
        if(server.readyState === 1) server.send(packet);
      }
    }
  });
  const writer = transform.writable.getWriter();
  writer.write(initialData);
  return chunk => writer.write(chunk);
}
function base64ToArrayBuffer(base64) {
  const binary = atob(base64.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for(let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
function bytesToHex(bytes) {
  const segments = [4,2,2,2,6];
  let offset = 0;
  return segments
    .map(len => {
      const hex = Array.from(bytes.slice(offset, offset += len))
        .map(b => b.toString(16).padStart(2,'0'))
        .join('');
      return hex;
    })
    .join('-');
}
function closeWs(ws) {
  if(ws.readyState === 1 || ws.readyState === 2) ws.close();
}
