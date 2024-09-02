import { connect } from "cloudflare:sockets";
export default {
  async fetch(req, env) {
    const userID = env.UUID || "d342d11e-d424-4583-b36e-524ab1f0afa4";
    const proxyIP = env.PROXYIP || "";
    try {
      return req.headers.get("Upgrade") === "websocket"
        ? handleWs(req, userID, proxyIP)
        : handleHttp(req, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};
const handleHttp = (req, userID) => {
  const path = new URL(req.url).pathname;
  if (path === "/") return new Response(JSON.stringify(req.cf, null, 4));
  if (path === `/${userID}`) {
    return new Response(getConfig(userID, req.headers.get("Host")), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }
  return new Response("Not found", { status: 404 });
};
const handleWs = async (req, userID, proxyIP) => {
  const [client, ws] = new WebSocketPair();
  ws.accept(); 
  const stream = createStream(ws, req.headers.get('sec-websocket-protocol'));
  let remote = { value: null }; 
  stream.pipeTo(new WritableStream({
    async write(chunk) {
      if (remote.value) return writeToRemote(remote.value, chunk);
      const { hasError, addr, port, idx, ver, isUDP } = parseVlessHeader(chunk, userID);
      if (hasError) return;     
      const rawData = chunk.slice(idx);
      if (isUDP && port === 53) {
        await handleUDP(ws, ver, rawData);
      } else {
        await handleTCP(remote, addr, port, rawData, ws, ver, proxyIP);
      }
    }
  })); 
  return new Response(null, { status: 101, webSocket: client });
};
const createStream = (ws, earlyheader) => {
  return new ReadableStream({
    start(controller) {
      const { earlyData, error } = base64ToBuffer(earlyheader || '');
      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);
      ws.addEventListener("message", (e) => controller.enqueue(e.data));
      ws.addEventListener("close", () => controller.close());
      ws.addEventListener("error", (err) => controller.error(err));
      return () => closeWs(ws);
    }
  });
};
const handleTCP = async (remote, addr, port, rawData, ws, header, proxyIP) => {
  try {
    const socket = await connectAndWrite(remote, addr, port, rawData);
    await forwardData(socket, ws, header, async () => {
      const fallback = await connectAndWrite(remote, proxyIP, port, rawData);
      fallback.closed.finally(() => closeWs(ws));
      await forwardData(fallback, ws, header);
    });
  } catch {
    closeWs(ws);
  }
};
const connectAndWrite = async (remote, addr, port, rawData) => {
  if (!remote.value || remote.value.closed) {
    remote.value = await connect({ hostname: addr, port });
  }
  await writeToRemote(remote.value, rawData);
  return remote.value;
};
const parseVlessHeader = (buf, userID) => {
  try {
    const view = new DataView(buf);
    const useruuid = stringify(buf.slice(1, 17));
    if (useruuid !== userID) return { hasError: true };
    const cmdOffset = 18 + view.getUint8(17);
    const cmd = view.getUint8(cmdOffset);
    const port = view.getUint16(cmdOffset + 1);
    const addrType = view.getUint8(cmdOffset + 3);
    const addrVal = extractAddress(buf, addrType, cmdOffset + 4);
    return { hasError: false, addr: addrVal, port, idx: cmdOffset + 4 + addrVal.length, ver: buf.slice(0, 1), isUDP: cmd === 2 };
  } catch {
    return { hasError: true };
  }
};
const extractAddress = (buf, addrType, addrOffset) => {
  return addrType === 1
    ? Array.from(new Uint8Array(buf, addrOffset, 4)).join(".")
    : addrType === 2
    ? new TextDecoder().decode(new Uint8Array(buf, addrOffset + 1, buf[addrOffset]))
    : Array.from(new Uint8Array(buf, addrOffset, 16)).map(b => b.toString(16).padStart(2, "0")).join(":");
};
const forwardData = async (socket, ws, header, retry) => {
  if (ws.readyState !== WebSocket.OPEN) {
    closeWs(ws);
    return;
  }
  let hasData = false;
  let firstChunk = true;
  const headerLength = header.length;
  try {
    await socket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        hasData = true;
        try {
          if (firstChunk) {
            const outputBuffer = new Uint8Array(headerLength + chunk.byteLength);
            outputBuffer.set(header);
            outputBuffer.set(new Uint8Array(chunk), headerLength);
            ws.send(outputBuffer.buffer);
            firstChunk = false;
          } else {
            ws.send(chunk);
          }
        } catch {
          closeWs(ws);
        }
      }
    }));
  } catch {
    closeWs(ws);
  }
  if (!hasData && retry) {
    retry();
  }
};
const base64ToBuffer = (base64Str) => {
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
    const buffer = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) buffer[i] = binaryStr.charCodeAt(i);
    return { earlyData: buffer.buffer, error: null };
  } catch {
    return { error: new Error("Invalid base64 string") };
  }
};
const closeWs = (ws) => {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close();
};
const stringify = (arr) => {
  const segments = [4, 2, 2, 2, 6];
  let result = '';
  let offset = 0;
  segments.forEach(len => {
    result += Array.from(arr.slice(offset, offset + len)).map(b => b.toString(16).padStart(2, '0')).join('');
    result += '-';
    offset += len;
  });
  return result.slice(0, -1).toLowerCase();
};
const handleUDP = async (ws, header, rawData) => {
  const tasks = [];
  let idx = 0; 
  while (idx < rawData.byteLength) {
    const len = new DataView(rawData).getUint16(idx);
    tasks.push(sendDnsQuery(ws, header, rawData.slice(idx + 2, idx + 2 + len)));
    idx += 2 + len;
  } 
  await Promise.all(tasks);
};
const sendDnsQuery = async (ws, header, query) => {
  try {
    const response = await fetch("https://cloudflare-dns.com/dns-query", {
      method: "POST",
      headers: { "Content-Type": "application/dns-message" },
      body: query
    });
    const dnsResult = await response.arrayBuffer();
    const udpSizeBuffer = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
    const outputBuffer = new Uint8Array(header.length + udpSizeBuffer.length + dnsResult.byteLength);
    outputBuffer.set(header);
    outputBuffer.set(udpSizeBuffer, header.length);
    outputBuffer.set(new Uint8Array(dnsResult), header.length + udpSizeBuffer.length);
    
    if (ws.readyState === WebSocket.OPEN) ws.send(outputBuffer.buffer);
  } catch {
  }
};
const getConfig = (userID, host) => `
vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host}
`;
