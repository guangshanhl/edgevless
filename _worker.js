import { connect } from "cloudflare:sockets";

export default {
  async fetch(req, env) {
    const userID = env.UUID || "d342d11e-d424-4583-b36e-524ab1f0afa4";
    const proxyIP = env.PROXYIP || "";

    try {
      return req.headers.get("Upgrade") === "websocket"
        ? handleWebSocket(req, userID, proxyIP)
        : handleHttpRequest(req, userID);
    } catch (err) {
      return new Response(err.toString());
    }
  }
};

const handleHttpRequest = (req, userID) => {
  const path = new URL(req.url).pathname;

  if (path === "/") {
    return new Response(JSON.stringify(req.cf, null, 4));
  }

  if (path === `/${userID}`) {
    return new Response(getVlessConfig(userID, req.headers.get("Host")), {
      headers: { "Content-Type": "text/plain;charset=utf-8" }
    });
  }

  return new Response("Not found", { status: 404 });
};

const handleWebSocket = async (req, userID, proxyIP) => {
  const [client, ws] = new WebSocketPair();
  ws.accept();

  const stream = new ReadableStream({
    start(controller) {
      const earlyProtocol = req.headers.get("sec-websocket-protocol") || "";
      const { earlyData, error } = decodeBase64ToBuffer(earlyProtocol);

      if (error) return controller.error(error);
      if (earlyData) controller.enqueue(earlyData);

      const onMessage = (e) => controller.enqueue(e.data);
      const onClose = () => controller.close();
      const onError = (err) => controller.error(err);

      ws.addEventListener("message", onMessage);
      ws.addEventListener("close", onClose);
      ws.addEventListener("error", onError);

      return () => {
        ws.removeEventListener("message", onMessage);
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
        closeWebSocket(ws);
      };
    }
  });

  let remoteConnection = { value: null };
  let udpWriteFunction = null;
  let isDnsRequest = false;

  stream.pipeTo(
    new WritableStream({
      async write(chunk) {
        if (isDnsRequest && udpWriteFunction) return udpWriteFunction(chunk);
        if (remoteConnection.value) return writeToRemoteConnection(remoteConnection.value, chunk);

        const {
          hasError,
          address = "",
          port = 443,
          offset,
          version = new Uint8Array([0, 0]),
          isUDP
        } = parseVlessPacket(chunk, userID);

        if (hasError) return;

        const responseHeader = new Uint8Array([version[0], 0]);
        const data = chunk.slice(offset);

        if (isUDP && port === 53) {
          udpWriteFunction = await handleUdpRequest(ws, responseHeader, data);
        } else {
          handleTcpConnection(remoteConnection, address, port, data, ws, responseHeader, proxyIP);
        }
      }
    })
  );

  return new Response(null, { status: 101, webSocket: client });
};

const writeToRemoteConnection = async (socket, chunk) => {
  const writer = socket.writable.getWriter();
  await writer.write(chunk);
  writer.releaseLock();
};

const handleTcpConnection = async (remoteConnection, address, port, data, ws, header, proxyIP) => {
  try {
    const socket = await connectAndWriteToRemote(remoteConnection, address, port, data);

    await forwardTcpStream(socket, ws, header, async () => {
      const fallbackConnection = await connectAndWriteToRemote(remoteConnection, proxyIP, port, data);
      fallbackConnection.closed.finally(() => closeWebSocket(ws));
      await forwardTcpStream(fallbackConnection, ws, header);
    });
  } catch {
    closeWebSocket(ws);
  }
};

const connectAndWriteToRemote = async (remoteConnection, address, port, data) => {
  if (remoteConnection.value?.writable && !remoteConnection.value?.closed) {
    await writeToRemoteConnection(remoteConnection.value, data);
  } else {
    remoteConnection.value = await connect({ hostname: address, port });
    await writeToRemoteConnection(remoteConnection.value, data);
  }

  return remoteConnection.value;
};

const parseVlessPacket = (buffer, userID) => {
  try {
    const view = new DataView(buffer);
    const userUUID = stringifyUuid(new Uint8Array(buffer.slice(1, 17)));

    if (userUUID !== userID) {
      return { hasError: true };
    }

    const version = new Uint8Array(buffer.slice(0, 1));
    const optLenOffset = 17;
    const optLen = view.getUint8(optLenOffset);
    const commandOffset = optLenOffset + 1 + optLen;
    const command = view.getUint8(commandOffset);
    const isUDP = command === 2;
    const portOffset = commandOffset + 1;
    const port = view.getUint16(portOffset);
    const addressTypeOffset = portOffset + 2;
    const addressType = view.getUint8(addressTypeOffset);

    let addressLength;

    if (addressType === 2) {
      addressLength = view.getUint8(addressTypeOffset + 1);
    } else if (addressType === 1) {
      addressLength = 4;
    } else {
      addressLength = 16;
    }

    const addressValueIndex = addressTypeOffset + (addressType === 2 ? 2 : 1);
    const addressValue =
      addressType === 1
        ? Array.from(new Uint8Array(buffer, addressValueIndex, 4)).join(".")
        : addressType === 2
        ? new TextDecoder().decode(new Uint8Array(buffer, addressValueIndex, addressLength))
        : Array.from(new Uint8Array(buffer, addressValueIndex, 16))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(":");

    return {
      hasError: false,
      address: addressValue,
      port,
      offset: addressValueIndex + addressLength,
      version,
      isUDP
    };
  } catch {
    return { hasError: true };
  }
};

const forwardTcpStream = async (socket, ws, header, retryCallback) => {
  if (ws.readyState !== WebSocket.OPEN) {
    closeWebSocket(ws);
    return;
  }

  let hasReceivedData = false;
  let isFirstChunk = true;
  const headerLength = header.length;

  try {
    await socket.readable.pipeTo(
      new WritableStream({
        async write(chunk) {
          hasReceivedData = true;

          try {
            if (isFirstChunk) {
              const combinedBuffer = new Uint8Array(headerLength + chunk.byteLength);
              combinedBuffer.set(header);
              combinedBuffer.set(new Uint8Array(chunk), headerLength);
              ws.send(combinedBuffer.buffer);
              isFirstChunk = false;
            } else {
              ws.send(chunk);
            }
          } catch {
            closeWebSocket(ws);
          }
        }
      })
    );
  } catch {
    closeWebSocket(ws);
  }

  if (!hasReceivedData && retryCallback) {
    retryCallback();
  }
};

const decodeBase64ToBuffer = (base64Str) => {
  const base64 = base64Str.replace(/-/g, "+").replace(/_/g, "/");
  const binaryStr = atob(base64);
  const len = binaryStr.length;
  const buffer = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    buffer[i] = binaryStr.charCodeAt(i);
  }

  return { earlyData: buffer.buffer, error: null };
};

const closeWebSocket = (ws) => {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CLOSING) {
    ws.close();
  }
};

const stringifyUuid = (arr, offset = 0) => {
  const byteToHex = (byte) => byte.toString(16).padStart(2, "0");
  const segments = [4, 2, 2, 2, 6];
  let result = [];
  let currentOffset = offset;

  for (const len of segments) {
    for (let i = currentOffset; i < currentOffset + len; i++) {
      result.push(byteToHex(arr[i]));
    }
    result.push("-");
    currentOffset += len;
  }

  result.pop();
  return result.join("").toLowerCase();
};

const handleUdpRequest = async (ws, header, rawData) => {
  const fetchDnsResponse = async (offset, length) => {
    try {
      const response = await fetch("https://cloudflare-dns.com/dns-query", {
        method: "POST",
        headers: { "content-type": "application/dns-message" },
        body: rawData.slice(offset, offset + length)
      });
      return response.arrayBuffer();
    } catch {
      return null;
    }
  };

  const tasks = [];
  let index = 0;

  while (index < rawData.byteLength) {
    const length = new Uint16Array(rawData.buffer, index, 1)[0];

    tasks.push(
      (async () => {
        const dnsResult = await fetchDnsResponse(index + 2, length);
        if (dnsResult) {
          const dnsResponse = new Uint8Array(header.length + dnsResult.byteLength);
          dnsResponse.set(header);
          dnsResponse.set(new Uint8Array(dnsResult), header.length);
          ws.send(dnsResponse.buffer);
        }
      })()
    );

    index += 2 + length;
  }

  await Promise.all(tasks);

  return async (chunk) => {
    const dnsResult = await fetchDnsResponse(0, chunk.byteLength);
    if (dnsResult) {
      const dnsResponse = new Uint8Array(header.length + dnsResult.byteLength);
      dnsResponse.set(header);
      dnsResponse.set(new Uint8Array(dnsResult), header.length);
      ws.send(dnsResponse.buffer);
    }
  };
};

const getVlessConfig = (userID, host) => `
vless://${userID}@${host}:443?encryption=none&flow=xtls-rprx-vision&security=reality&fp=chrome&pbk=xxxx&sid=xxxx#config
`;
