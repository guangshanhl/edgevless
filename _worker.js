import { connect } from 'cloudflare:sockets';
const CONFIG = {
  BUFFER_SIZE: 128 * 1024,
  WS_STATES: {
    OPEN: 1,
    CLOSING: 2
  },
  DEFAULT_USER_ID: 'd342d11e-d424-4583-b36e-524ab1f0afa4',
  DNS_ENDPOINT: 'https://cloudflare-dns.com/dns-query'
};
export default {
  async fetch(request, env) {
    const handler = new WebSocketHandler(
      env?.UUID || CONFIG.DEFAULT_USER_ID,
      env?.PROXYIP || ''
    );
    return handler.handleRequest(request);
  }
};
class WebSocketHandler {
  #userID;
  #proxyIP;
  #cachedUserID;

  constructor(userID, proxyIP) {
    this.#userID = userID;
    this.#proxyIP = proxyIP;
  }
 
  async handleRequest(request) {
    try {
      if (request.headers.get('Upgrade') === 'websocket') {
        return await this.#handleWebSocket(request);
      }

      const url = new URL(request.url);
      const routes = new Map([
        ['/', () => new Response(JSON.stringify(request.cf))],
        [`/${this.#userID}`, () => {
          const config = this.#getConfig(request.headers.get('Host'));
          return new Response(config, {
            headers: {'Content-Type': 'text/plain;charset=utf-8'}
          });
        }]
      ]);

      const handler = routes.get(url.pathname);
      return handler?.() ?? new Response('Not found', { status: 404 });
      
    } catch (err) {
      return new Response(err.toString());
    }
  }

  async #handleWebSocket(request) {
    const { 0: client, 1: webSocket } = Object.values(new WebSocketPair());
    webSocket.accept();

    const earlyHeader = request.headers.get('sec-websocket-protocol') || '';
    const readableStream = this.#makeWebStream(webSocket, earlyHeader);
    
    const state = {
      remoteSocket: null,
      udpWrite: null,
      isDns: false
    };

    await readableStream.pipeTo(new WritableStream({
      write: async (chunk) => {
        await this.#handleStreamWrite(chunk, state, webSocket);
      }
    })).catch(() => this.#closeWebSocket(webSocket));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async #handleStreamWrite(chunk, state, webSocket) {
    if (state.isDns && state.udpWrite) {
      this.#writeChunked(chunk, state.udpWrite);
      return;
    }

    if (state.remoteSocket) {
      await this.#writeToRemoteSocket(chunk, state.remoteSocket);
      return;
    }

    const header = this.#processRessHeader(chunk);
    if (header.hasError) return;

    const { portRemote = 443, addressRemote = '', rawDataIndex, ressVersion = new Uint8Array([0, 0]), isUDP } = header;

    if (isUDP) {
      if (portRemote === 53) {
        state.isDns = true;
      } else {
        return;
      }
    }

    const resHeader = new Uint8Array([ressVersion[0], 0]);
    const clientData = chunk.slice(rawDataIndex);

    if (state.isDns) {
      const { write } = await this.#handleUDPOutBound(webSocket, resHeader);
      state.udpWrite = write;
      state.udpWrite(clientData);
      return;
    }

    await this.#handleTCPOutBound(state, addressRemote, portRemote, clientData, webSocket, resHeader);
  }

  #writeChunked(data, writer) {
    for (let offset = 0; offset < data.byteLength; offset += CONFIG.BUFFER_SIZE) {
      const chunk = data.slice(offset, offset + CONFIG.BUFFER_SIZE);
      writer(chunk);
    }
  }

  async #writeToRemoteSocket(data, socket) {
    const writer = socket.writable.getWriter();
    try {
      for (let offset = 0; offset < data.byteLength; offset += CONFIG.BUFFER_SIZE) {
        await writer.write(data.slice(offset, offset + CONFIG.BUFFER_SIZE));
      }
    } finally {
      writer.releaseLock();
    }
  }

  async #handleTCPOutBound(state, address, port, data, webSocket, resHeader) {
    const connectAndWrite = async (addr, p) => {
      state.remoteSocket = connect({ hostname: addr, port: p });
      await this.#writeToRemoteSocket(data, state.remoteSocket);
      return state.remoteSocket;
    };

    const tryConnect = async (addr, p) => {
      const socket = await connectAndWrite(addr, p);
      return this.#forwardData(socket, webSocket, resHeader);
    };

    const connected = await tryConnect(address, port) || 
                     await tryConnect(this.#proxyIP, port);
                     
    if (!connected) {
      this.#closeWebSocket(webSocket);
    }
  }

  async #forwardData(socket, webSocket, resHeader) {
    let hasData = false;

    try {
      await socket.readable.pipeTo(new WritableStream({
        write: (chunk) => {
          const buffer = resHeader
            ? new Uint8Array([...resHeader, ...chunk])
            : chunk;
          
          if (webSocket.readyState === CONFIG.WS_STATES.OPEN) {
            this.#writeChunked(buffer, chunk => webSocket.send(chunk));
            hasData = true;
          }
          resHeader = null;
        }
      }));
    } catch {
      this.#closeWebSocket(webSocket);
    }

    return hasData;
  }

  async #handleUDPOutBound(webSocket, resHeader) {
    let headerSent = false;
    const transformStream = new TransformStream({
      transform: (chunk, controller) => {
        this.#processUDPChunk(chunk, controller);
      }
    });

    this.#pipeUDPStream(transformStream, webSocket, resHeader);

    return {
      write: (chunk) => this.#writeToUDPStream(chunk, transformStream.writable.getWriter(), webSocket)
    };
  }

  #processUDPChunk(chunk, controller) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const dataView = new DataView(chunk.buffer, chunk.byteOffset + offset);
      const length = dataView.getUint16(0);
      const data = chunk.slice(offset + 2, offset + 2 + length);
      offset += 2 + length;
      controller.enqueue(data);
    }
  }

  async #pipeUDPStream(stream, webSocket, resHeader) {
    let headerSent = false;
    
    await stream.readable.pipeTo(new WritableStream({
      write: async (chunk) => {
        try {
          const response = await fetch(CONFIG.DNS_ENDPOINT, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/dns-message',
              'Accept': 'application/dns-message'
            },
            body: chunk
          });

          const result = await response.arrayBuffer();
          const sizeBuffer = new Uint8Array([(result.byteLength >> 8) & 0xff, result.byteLength & 0xff]);
          const payload = headerSent 
            ? new Uint8Array([...sizeBuffer, ...new Uint8Array(result)])
            : new Uint8Array([...resHeader, ...sizeBuffer, ...new Uint8Array(result)]);

          headerSent = true;

          if (webSocket.readyState === CONFIG.WS_STATES.OPEN) {
            webSocket.send(payload);
          }
        } catch {
          this.#closeWebSocket(webSocket);
        }
      }
    })).catch(() => this.#closeWebSocket(webSocket));
  }

  #writeToUDPStream(chunk, writer, webSocket) {
    this.#writeChunked(chunk, async (data) => {
      try {
        await writer.write(data);
      } catch {
        this.#closeWebSocket(webSocket);
      }
    });
  }

  #processRessHeader(ressBuffer) {
    if (ressBuffer.byteLength < 24) return { hasError: true };

    const version = new DataView(ressBuffer, 0, 1).getUint8(0);
    
    if (!this.#cachedUserID) {
      this.#cachedUserID = Uint8Array.from(
        this.#userID.replace(/-/g, '')
          .match(/../g)
          .map(byte => parseInt(byte, 16))
      );
    }

    const bufferUserID = new Uint8Array(ressBuffer, 1, 16);
    if (!bufferUserID.every((byte, i) => byte === this.#cachedUserID[i])) {
      return { hasError: true };
    }

    const optLength = new DataView(ressBuffer, 17, 1).getUint8(0);
    const command = new DataView(ressBuffer, 18 + optLength, 1).getUint8(0);
    
    const isUDP = command === 2;
    if (!isUDP && command !== 1) {
      return { hasError: false };
    }

    const portIndex = 18 + optLength + 1;
    const portRemote = new DataView(ressBuffer, portIndex, 2).getUint16(0);
    const addressIndex = portIndex + 2;
    const addressType = new DataView(ressBuffer, addressIndex, 1).getUint8(0);

    const addressInfo = this.#parseAddress(ressBuffer, addressType, addressIndex + 1);
    if (!addressInfo) return { hasError: true };

    return {
      hasError: false,
      addressRemote: addressInfo.value,
      portRemote,
      rawDataIndex: addressInfo.nextIndex,
      ressVersion: version,
      isUDP
    };
  }

  #parseAddress(buffer, type, startIndex) {
    let value = '';
    let length = 0;
    let currentIndex = startIndex;

    switch (type) {
      case 1: // IPv4
        length = 4;
        value = new Uint8Array(buffer, currentIndex, length).join('.');
        break;

      case 2: // Domain
        length = new DataView(buffer, currentIndex, 1).getUint8(0);
        currentIndex += 1;
        value = new TextDecoder().decode(
          new Uint8Array(buffer, currentIndex, length)
        );
        break;

      case 3: // IPv6
        length = 16;
        const ipv6Parts = new Uint16Array(buffer, currentIndex, length / 2);
        value = Array.from(ipv6Parts, part => part.toString(16)).join(':');
        break;

      default:
        return null;
    }

    return {
      value,
      nextIndex: currentIndex + length
    };
  }

  #base64ToBuffer(base64Str) {
    try {
      const normalizedStr = base64Str
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const binaryStr = atob(normalizedStr);
      
      const buffer = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        buffer[i] = binaryStr.charCodeAt(i);
      }

      return { 
        earlyData: buffer.buffer, 
        error: null 
      };
    } catch (error) {
      return { error };
    }
  }

  #makeWebStream(webSocket, earlyHeader) {
    let isActive = true;
    
    return new ReadableStream({
      start: (controller) => {
        const messageHandler = ({ data }) => {
          if (!isActive) return;
          
          if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            this.#writeChunked(data, chunk => controller.enqueue(chunk));
          } else {
            controller.enqueue(data);
          }
        };

        const cleanup = () => {
          isActive = false;
          webSocket.removeEventListener('message', messageHandler);
          webSocket.removeEventListener('close', cleanup);
          webSocket.removeEventListener('error', handleError);
          this.#closeWebSocket(webSocket);
        };

        const handleError = (error) => {
          if (!isActive) return;
          controller.error(error);
          cleanup();
        };

        webSocket.addEventListener('message', messageHandler);
        webSocket.addEventListener('close', cleanup);
        webSocket.addEventListener('error', handleError);

        if (earlyHeader) {
          const { earlyData, error } = this.#base64ToBuffer(earlyHeader);
          if (error) {
            handleError(error);
          } else if (earlyData) {
            controller.enqueue(earlyData);
          }
        }

        return cleanup;
      },
      
      cancel: () => {
        isActive = false;
        this.#closeWebSocket(webSocket);
      }
    }, {
      highWaterMark: CONFIG.BUFFER_SIZE,
      size: chunk => chunk.byteLength || 1
    });
  }

  #closeWebSocket = (socket) => {
    if (socket?.readyState === CONFIG.WS_STATES.OPEN || 
        socket?.readyState === CONFIG.WS_STATES.CLOSING) {
      socket.close();
    }
  }
  #getConfig(hostName) {
    return `vless://${this.#userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2560#${hostName}`;
  }
}
