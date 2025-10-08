import { connect } from 'cloudflare:sockets';

const WS_OPEN = 1, WS_CLOSING = 2;

let cachedMyIDBuffer = null;
let cachedMyID = null;
const getCachedMyIDBuffer = (myID) => {
  if (cachedMyID !== myID) {
    cachedMyID = myID;
    cachedMyIDBuffer = new Uint8Array(
      myID.replace(/-/g, '').match(/../g).map(byte => parseInt(byte, 16))
    );
  }
  return cachedMyIDBuffer;
};

class TokenBucketLimiter {
  constructor(rateBytesPerSec = 65536) {
    this.rate = rateBytesPerSec;
    this.capacity = this.rate;
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      const add = (elapsed / 1000) * this.rate;
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.lastRefill = now;
    }
  }
  async waitForTokens(bytes) {
    while (true) {
      this.refill();
      if (this.tokens >= bytes) {
        this.tokens -= bytes;
        return;
      }
      const deficit = bytes - this.tokens;
      const waitMs = Math.ceil((deficit / this.rate) * 1000);
      await new Promise(r => setTimeout(r, Math.max(1, waitMs)));
    }
  }
}

class SendRateLimiter {
  constructor(webSocket, rateBytesPerSecond = 65536) {
    this.ws = webSocket;
    this.bucket = new TokenBucketLimiter(rateBytesPerSecond);
    this.queue = [];
    this.pumping = false;
    this.closed = false;
    webSocket.addEventListener('close', () => this.closed = true);
    webSocket.addEventListener('error', () => this.closed = true);
  }
  enqueue(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.queue.push(data);
    if (!this.pumping) this.startPump();
  }
  async startPump() {
    if (this.pumping) return;
    this.pumping = true;
    while (!this.closed && this.queue.length > 0) {
      const chunk = this.queue.shift();
      if (!chunk) break;
      await this.bucket.waitForTokens(chunk.byteLength);
      if (this.ws.readyState === WS_OPEN) {
        try { this.ws.send(chunk); } catch { this.closed = true; break; }
      } else break;
    }
    this.pumping = false;
  }
}

export default {
  fetch: async (request, env) => {
    const myID = env.MYID ?? 'd342d11e-d424-4583-b36e-524ab1f0afa4';
    const ownIP = env.OWNIP ?? '';
    const downRate = Number(env.RATE_DOWN_BYTES_PER_SECOND) || 65536;
    const upRate = Number(env.RATE_UP_BYTES_PER_SECOND) || 32768;
    if (request.headers.get('Upgrade') === 'websocket') {
      return handlerWs(request, myID, ownIP, downRate, upRate);
    } else {
      return handlerHttp(request, myID);
    }
  },
};

const handlerHttp = (request, myID) => {
  const path = new URL(request.url).pathname;
  if (path === '/') {
    return new Response('Cloudflare Worker Active', { status: 200 });
  } else if (path === `/${myID}`) {
    return new Response(getConfig(myID, request.headers.get('Host')), {
      headers: { "content-type": "text/plain" },
    });
  } else return new Response('404', { status: 404 });
};

const handlerWs = async (request, myID, ownIP, downRate, upRate) => {
  const [client, webSocket] = Object.values(new WebSocketPair());
  webSocket.accept();

  const protocolHeader = request.headers.get('sec-websocket-protocol') || '';
  const readableWstream = handlerStream(webSocket, protocolHeader);

  const remoteSocket = { value: null };
  let remoteWriter = null;
  let udpWrite = null;
  let isDns = false;

  const downLimiter = new SendRateLimiter(webSocket, downRate);
  const upLimiter = new TokenBucketLimiter(upRate);

  const writableStream = new WritableStream({
    write: async (chunk) => {
      await upLimiter.waitForTokens(chunk.byteLength);

      if (isDns && udpWrite) return udpWrite(chunk);
      if (remoteSocket.value) return remoteWriter.write(chunk);

      const headerResult = processResHeader(chunk, myID);
      if (headerResult.hasError) return;
      const { portRemote, addressRemote, rawDataIndex, resVersion, isUDP } = headerResult;
      const resHeader = new Uint8Array([resVersion[0], 0]);
      const clientData = chunk.slice(rawDataIndex);

      if (isUDP) {
        if (portRemote !== 53) return;
        isDns = true;
        const { write } = await handleUDP(webSocket, resHeader, downLimiter);
        udpWrite = write;
        return udpWrite(clientData);
      } else {
        return handleTCP(remoteSocket, remoteWriter, addressRemote, portRemote, clientData, webSocket, resHeader, ownIP, downLimiter);
      }
    },
    close: () => {
      if (remoteSocket.value) try { remoteSocket.value.close(); } catch {}
    },
    abort: () => {
      if (remoteSocket.value) try { remoteSocket.value.close(); } catch {}
      closeWebSocket(webSocket);
    }
  });

  readableWstream.pipeTo(writableStream)
    .catch(() => closeWebSocket(webSocket))
    .finally(() => {
      if (remoteSocket.value) try { remoteSocket.value.close(); } catch {}
    });

  return new Response(null, { status: 101, webSocket: client });
};

const handleTCP = async (remoteSocket, remoteWriter, address, port, data, ws, resHeader, ownIP, limiter) => {
  try {
    const socket = connect({ hostname: address, port });
    remoteSocket.value = socket;
    remoteWriter = socket.writable.getWriter();
    await remoteWriter.write(data);
    await forwardToData(socket, ws, resHeader, limiter);
    return true;
  } catch {
    if (ownIP) {
      try {
        const socket = connect({ hostname: ownIP, port });
        remoteSocket.value = socket;
        remoteWriter = socket.writable.getWriter();
        await remoteWriter.write(data);
        await forwardToData(socket, ws, resHeader, limiter);
        return true;
      } catch {}
    }
    closeWebSocket(ws);
    return false;
  }
};

const forwardToData = async (remoteSocket, ws, resHeader, limiter) => {
  if (ws.readyState !== WS_OPEN) return false;
  let firstChunk = true;

  const writable = new WritableStream({
    write: async (chunk) => {
      const payload = firstChunk
        ? new Uint8Array([...resHeader, ...new Uint8Array(chunk)])
        : new Uint8Array(chunk);
      limiter.enqueue(payload);
      firstChunk = false;
    },
  });

  try {
    await remoteSocket.readable.pipeTo(writable);
  } catch {
    closeWebSocket(ws);
  }
  return true;
};

const handlerStream = (ws, earlyHeader) => new ReadableStream({
  start(controller) {
    const { earlyData } = base64ToBuffer(earlyHeader);
    if (earlyData) controller.enqueue(earlyData);
    ws.addEventListener('message', ({ data }) => controller.enqueue(data));
    ws.addEventListener('close', () => controller.close());
    ws.addEventListener('error', (err) => controller.error(err));
  },
  cancel() { closeWebSocket(ws); }
});

const processResHeader = (resBuffer, myID) => {
  if (resBuffer.byteLength < 24) return { hasError: true };
  const dv = new DataView(resBuffer);
  const version = new Uint8Array([dv.getUint8(0)]);
  const idBuf = getCachedMyIDBuffer(myID);
  for (let i = 0; i < 16; i++) if (idBuf[i] !== dv.getUint8(1 + i)) return { hasError: true };
  const optLen = dv.getUint8(17);
  const cmd = dv.getUint8(18 + optLen);
  const isUDP = cmd === 2;
  if (!isUDP && cmd !== 1) return { hasError: true };
  const port = dv.getUint16(18 + optLen + 1, false);
  let idx = 18 + optLen + 3;
  const type = dv.getUint8(idx++);
  let addr = '';
  switch (type) {
    case 1: addr = `${dv.getUint8(idx)}.${dv.getUint8(idx+1)}.${dv.getUint8(idx+2)}.${dv.getUint8(idx+3)}`; break;
    case 2:
      const len = dv.getUint8(idx); idx++;
      addr = new TextDecoder().decode(new Uint8Array(resBuffer, idx, len));
      break;
    case 3:
      const parts = [];
      for (let i = 0; i < 8; i++) parts.push(dv.getUint16(idx + i*2, false).toString(16));
      addr = parts.join(':'); break;
    default: return { hasError: true };
  }
  return { hasError: false, addressRemote: addr, portRemote: port, rawDataIndex: resBuffer.byteLength - (resBuffer.byteLength - idx), resVersion: version, isUDP };
};

const handleUDP = async (ws, resHeader, limiter) => {
  let headerSent = false;
  const transform = new TransformStream({
    transform(chunk, controller) {
      let i = 0;
      while (i < chunk.byteLength) {
        const len = new DataView(chunk.buffer, chunk.byteOffset + i, 2).getUint16(0);
        const start = i + 2;
        controller.enqueue(new Uint8Array(chunk.slice(start, start + len)));
        i += 2 + len;
      }
    }
  });
  const writable = new WritableStream({
    write: async (chunk) => {
      const resp = await fetch('https://cloudflare-dns.com/dns-query', {
        method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk
      });
      const buf = new Uint8Array(await resp.arrayBuffer());
      const lenBuf = new Uint8Array(2);
      new DataView(lenBuf.buffer).setUint16(0, buf.byteLength, false);
      const packet = headerSent
        ? new Uint8Array([...lenBuf, ...buf])
        : new Uint8Array([...resHeader, ...lenBuf, ...buf]);
      limiter.enqueue(packet);
      headerSent = true;
    }
  });
  transform.readable.pipeTo(writable).catch(() => closeWebSocket(ws));
  const writer = transform.writable.getWriter();
  return { write: (chunk) => writer.write(chunk) };
};

const closeWebSocket = (ws) => {
  try { if ([WS_OPEN, WS_CLOSING].includes(ws.readyState)) ws.close(); } catch {}
};

const base64ToBuffer = (b64) => {
  try {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { earlyData: bytes.buffer };
  } catch (e) { return { error: e }; }
};

const getConfig = (id, host) =>
  `vless://${id}@${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F#${host}`;
