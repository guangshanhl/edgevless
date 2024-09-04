var regex_default = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000)$/i;

function validate(uuid) {
    return typeof uuid === "string" && regex_default.test(uuid);
}
var validate_default = validate;

var byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
    return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!validate_default(uuid)) {
        throw TypeError("Stringified UUID is invalid");
    }
    return uuid;
}
var stringify_default = stringify;

var WS_READY_STATE_OPEN = 1;
function makeReadableWebSocketStream(ws, earlyDataHeader) {
    let readableStreamCancel = false;
    return new ReadableStream({
        start(controller) {
            ws.addEventListener("message", async (e) => {
                if (readableStreamCancel) {
                    return;
                }
                const vlessBuffer = e.data;
                controller.enqueue(vlessBuffer);
            });
            ws.addEventListener("error", (e) => {
                readableStreamCancel = true;
                controller.error(e);
            });
            ws.addEventListener("close", () => {
                    if (readableStreamCancel) {
                        return;
                    }
                    controller.close();
            });
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                safeCloseWebSocket(ws);
                return;
            }
            if (earlyData) {
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
            safeCloseWebSocket(ws);
        }
    });
}
function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { error: null };
    }
    try {
        base64Str = base64Str.replace(/-/g, "+").replace(/_/g, "/");
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { error };
    }
}
function safeCloseWebSocket(socket) {
        if (socket.readyState === WS_READY_STATE_OPEN) {
            socket.close();
        }
}
function processVlessHeader(vlessBuffer, userID) {
    if (vlessBuffer.byteLength < 24) {
        return {
            hasError: true,
        };
    }
    const version = new Uint8Array(vlessBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    if (stringify_default(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
        isValidUser = true;
    }
    if (!isValidUser) {
        return {
            hasError: true,
        };
    }
    const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
    const command = new Uint8Array(
        vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
    )[0];
    if (command === 1) {
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
        };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getInt16(0);
    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(
        vlessBuffer.slice(addressIndex, addressIndex + 1)
    );
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            ).join(".");
            break;
        case 2:
            addressLength = new Uint8Array(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
            )[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            break;
        case 3:
            addressLength = 16;
            const dataView = new DataView(
                vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
            );
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(":");
            break;
        default:
    }
    if (!addressValue) {
        return {
            hasError: true,
        };
    }
    return {
        hasError: false,
        addressRemote: addressValue,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        vlessVersion: version,
        isUDP
    };
}

import { connect } from "cloudflare:sockets";
function delay2(ms) {
    return new Promise((resolve, rej) => {
        setTimeout(resolve, ms);
    });
}
var cf_worker_vless_default = {
    async fetch(request, env, ctx) {
        let address = "";
        const userID = env.UUID || "9562eed2-51c4-4b90-aab3-78fdb2ba397b";
		const proxyIP = env.PROXYIP || "";
        const isVaildUUID = validate_default(userID);
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader !== "websocket") {
            return new Response(
                `<html>
<head><title>404 Not Found</title></head>
<body>
<center><h1>404 Not Found ${isVaildUUID ? "_-_" : ""}</h1></center>
<hr><center>nginx/1.23.4</center>
</body>
</html>`,
                {
                    status: 404,
                    headers: {
                        "content-type": "text/html; charset=utf-8",
                        "WWW-Authenticate": "Basic"
                    }
                }
            );
        }
        const webSocketPair = new WebSocketPair();
        const [client, webSocket] = Object.values(webSocketPair);
        const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
        let remoteSocket = null;
        webSocket.accept();
        const readableWebSocketStream = makeReadableWebSocketStream(
            webSocket,
            earlyDataHeader,
        );
        let vlessResponseHeader = new Uint8Array([0, 0]);
        let remoteConnectionReadyResolve;
        readableWebSocketStream.pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    if (remoteSocket) {
                        const writer2 = remoteSocket.writable.getWriter();
                        await writer2.write(chunk);
                        writer2.releaseLock();
                        return;
                    }
                    const {
                        hasError,
                        portRemote,
                        addressRemote,
                        rawDataIndex,
                        vlessVersion,
                        isUDP
                    } = processVlessHeader(chunk, userID);
                    if (hasError) {
                        webSocket.close();
                        return;
                    }
                    try {
                        remoteSocket = connect({
                            hostname: addressRemote,
                            port: portRemote
                        });
                        const writer = remoteSocket.writable.getWriter();
                        await writer.write(chunk.slice(rawDataIndex));
                        writer.releaseLock();
                    } catch (error) {
                        closeWebSocket(webSocket);
                        return;
                    }
                    try {
                        await remoteSocket.readable.pipeTo(
                            new WritableStream({
                                start() {
                                    if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                                        webSocket.send(vlessResponseHeader);
                                    }
                                },
                                async write(dataChunk, controller) {
                                    if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                                        webSocket.send(dataChunk);
                                    }
                                }
                            })
                        );
                    } catch (error) {
                        try {
                            const fallbackSocket = connect({
                                hostname: proxyIP,
                                port: portRemote
                            });
                            const fallbackWriter = fallbackSocket.writable.getWriter();
                            await fallbackWriter.write(chunk.slice(rawDataIndex));
                            fallbackWriter.releaseLock();
                            await fallbackSocket.readable.pipeTo(
                                new WritableStream({
                                    start() {
                                        if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                                            webSocket.send(vlessResponseHeader);
                                        }
                                    },
                                    async write(fallbackChunk, controller) {
                                        if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                                            webSocket.send(fallbackChunk);
                                        }
                                    }
                                })
                            );
                        } catch (fallbackError) {
                            closeWebSocket(webSocket);
                        }
                    }
                }
            })
        );
        (async () => {
            await new Promise((resolve) => (remoteConnectionReadyResolve = resolve));
            let count = 0;
            remoteSocket.readable.pipeTo(
                new WritableStream({
                    start() {
                        if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                            webSocket.send(vlessResponseHeader);
                        }
                    },
                    async write(chunk, controller) {
                        if (webSocket.readyState === WebSocket.READY_STATE_OPEN) {
                            if (count++ > 2e4) {
                                await delay2(1);
                            }
                            webSocket.send(chunk);
                        }
                    }
                })
            ).catch((error) => {
                safeCloseWebSocket2(webSocket);
            });
        })();
        return new Response(null, {
            status: 101,
            webSocket: client
        });
    }
};
function safeCloseWebSocket2(ws) {
        if (ws.readyState !== WebSocket.READY_STATE_CLOSED) {
            ws.close();
        }
}
export {
    cf_worker_vless_default as default
};
