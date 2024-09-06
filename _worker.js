import { connect } from "cloudflare:sockets"; export default { async fetch(req, env) { const userID = env.UUID || "d342d11e-d424-4583-b36e-524ab1f0afa4", proxyIP = env.PROXYIP || ""; try { return req.headers.get("Upgrade") === "websocket" ? handleWs(req, userID, proxyIP) : handleHttp(req, userID); } catch (err) { return new Response(err.toString()); } } }; const handleHttp = (req, userID) => { const path = new URL(req.url).pathname; if (path === "/") return new Response(JSON.stringify(req.cf, null, 4)); if (path === `/${userID}`) return new Response(getConfig(userID, req.headers.get("Host")), { headers: { "Content-Type": "text/plain;charset=utf-8" } }); return new Response("Not found", { status: 404 }); }; const handleWs = async (req, userID, proxyIP) => { const [client, ws] = new WebSocketPair(); ws.accept(); const stream = new ReadableStream({ start(controller) { const earlyheader = req.headers.get('sec-websocket-protocol') || '', { earlyData, error } = base64ToBuffer(earlyheader); if (error) return controller.error(error); if (earlyData) controller.enqueue(earlyData); const onMessage = (e) => controller.enqueue(e.data), onClose = () => controller.close(), onError = (err) => controller.error(err); ws.addEventListener("message", onMessage); ws.addEventListener("close", onClose); ws.addEventListener("error", onError); return () => { ws.removeEventListener("message", onMessage); ws.removeEventListener("close", onClose); ws.removeEventListener("error", onError); closeWs(ws); }; } }); let remote = { value: null }, udpWrite = null, isDns = false; stream.pipeTo(new WritableStream({ async write(chunk) { if (isDns && udpWrite) return udpWrite(chunk); if (remote.value) return writeToRemote(remote.value, chunk); const { hasError, addr = '', port = 443, idx, ver = new Uint8Array([0, 0]), isUDP } = parseVlessHeader(chunk, userID); if (hasError) return; const resHeader = new Uint8Array([ver[0], 0]), rawData = chunk.slice(idx); if (isUDP && port === 53) udpWrite = await handleUDP(ws, resHeader, rawData); else handleTCP(remote, addr, port, rawData, ws, resHeader, proxyIP); } })); return new Response(null, { status: 101, webSocket: client }); }; const writeToRemote = async (socket, chunk) => { const writer = socket.writable.getWriter(); await writer.write(chunk); writer.releaseLock(); }; const handleTCP = async (remote, addr, port, rawData, ws, header, proxyIP) => { try { const socket = await connectAndWrite(remote, addr, port, rawData); await forwardData(socket, ws, header, async () => { const fallback = await connectAndWrite(remote, proxyIP, port, rawData); fallback.closed.finally(() => closeWs(ws)); await forwardData(fallback, ws, header); }); } catch { closeWs(ws); } }; const connectAndWrite = async (remote, addr, port, rawData) => { if (remote.value && !remote.value.closed) await writeToRemote(remote.value, rawData); else { remote.value = await connect({ hostname: addr, port }); await writeToRemote(remote.value, rawData); } return remote.value; }; const parseVlessHeader = (buf, userID) => { try { const view = new DataView(buf), useruuid = stringify(new Uint8Array(buf.slice(1, 17))); if (useruuid !== userID) return { hasError: true }; const version = new Uint8Array(buf.slice(0, 1)), optLenOffset = 17, optLen = view.getUint8(optLenOffset), cmdOffset = optLenOffset + 1 + optLen, cmd = view.getUint8(cmdOffset), isUDP = cmd === 2, portOffset = cmdOffset + 1, port = view.getUint16(portOffset), addrTypeOffset = portOffset + 2, addrType = view.getUint8(addrTypeOffset); let addrLen; if (addrType === 2) addrLen = view.getUint8(addrTypeOffset + 1); else addrLen = addrType === 1 ? 4 : 16; const addrValIdx = addrTypeOffset + (addrType === 2 ? 2 : 1), addrVal = addrType === 1 ? Array.from(new Uint8Array(buf, addrValIdx, 4)).join(".") : addrType === 2 ? new TextDecoder().decode(new Uint8Array(buf, addrValIdx, addrLen)) : Array.from(new Uint8Array(buf, addrValIdx, 16)).map(b => b.toString(16).padStart(2, "0")).join(":"); return { hasError: false, addr: addrVal, port, idx: addrValIdx + addrLen, ver: version, isUDP }; } catch { return { hasError: true }; } }; const forwardData = async (socket, ws, header, retry) => { if (ws.readyState !== WebSocket.OPEN) return closeWs(ws); let hasData = false, firstChunk = true, headerLength = header.length; try { await socket.readable.pipeTo(new WritableStream({ async write(chunk) { hasData = true; try { if (firstChunk) { const outputBuffer = new Uint8Array(headerLength + chunk.byteLength); outputBuffer.set(header); outputBuffer.set(new Uint8Array(chunk), headerLength); ws.send(outputBuffer.buffer); firstChunk = false; } else ws.send(chunk); } catch { closeWs(ws); } } })); } catch { closeWs(ws); } if (!hasData && retry) retry(); }; const base64ToBuffer = base64Str => { try { if (base64Str.includes('-') || base64Str.includes('_')) base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/'); const binaryStr = atob(base64Str), len = binaryStr.length, buffer = new Uint8Array(len); for (let i = 0; i < len; i++) buffer[i] = binaryStr.charCodeAt(i); return { earlyData: buffer.buffer, error: null }; } catch (error) { return { error }; } }; const closeWs = (ws) => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) ws.close(); }; const byteToHex = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1)); const stringify = (arr, offset = 0) => { const segments = [4, 2, 2, 2, 6]; return segments.map(len => Array.from({ length: len }, () => byteToHex[arr[offset++]]).join('')).join('-').toLowerCase(); }; const handleUDP = async (ws, header, rawData) => { const dnsFetch = async (offset, length) => { try { const response = await fetch("https://cloudflare-dns.com/dns-query", { method: "POST", headers: { "content-type": "application/dns-message" }, body: rawData.slice(offset, offset + length), }); return response.arrayBuffer(); } catch { return null; } }; const tasks = []; let idx = 0; while (idx < rawData.byteLength) { const len = new Uint16Array(rawData.buffer, idx, 1)[0]; tasks.push((async () => { const dnsResult = await dnsFetch(idx + 2, len); if (!dnsResult) return; const udpSizeBuffer = new Uint8Array(2); udpSizeBuffer[0] = (dnsResult.byteLength >> 8) & 0xff; udpSizeBuffer[1] = dnsResult.byteLength & 0xff; const outputBuffer = new Uint8Array(header.length + 2 + dnsResult.byteLength); outputBuffer.set(header, 0); outputBuffer.set(udpSizeBuffer, header.length); outputBuffer.set(new Uint8Array(dnsResult), header.length + 2); if (ws.readyState === WebSocket.OPEN) ws.send(outputBuffer.buffer); })()); idx += 2 + len; } await Promise.all(tasks); }; const getConfig = (userID, host) => ` vless://${userID}\u0040${host}:443?encryption=none&security=tls&sni=${host}&fp=randomized&type=ws&host=${host}&path=%2F%3Fed%3D2560#${host} `;
