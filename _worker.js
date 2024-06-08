import { connect } from 'cloudflare:sockets';

// 初始用户ID和代理IP
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = '';

// 验证UUID的有效性
if (!isValidUUID(userID)) {
    throw new Error('uuid is not valid');
}

// 主处理函数
export default {
    async fetch(request, env, ctx) {
        try {
            userID = env.UUID || userID;
            proxyIP = env.PROXYIP || proxyIP;

            const upgradeHeader = request.headers.get('Upgrade');
            if (!upgradeHeader || upgradeHeader !== 'websocket') {
                return handleHttpRequest(request);
            } else {
                return await vlessOverWSHandler(request);
            }
        } catch (err) {
            return new Response(err.toString());
        }
    },
};

// 处理HTTP请求
function handleHttpRequest(request) {
    const url = new URL(request.url);
    switch (url.pathname) {
        case '/':
            return new Response(JSON.stringify(request.cf), { status: 200 });
        case `/${userID}`:
            const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
            return new Response(vlessConfig, {
                status: 200,
                headers: { "Content-Type": "text/plain;charset=utf-8" },
            });
        default:
            return new Response('Not found', { status: 404 });
    }
}

// 处理WebSocket连接
async function vlessOverWSHandler(request) {
    const { client, webSocket } = createWebSocketPair();

    webSocket.accept();
    const log = createLogger();

    const readableWebSocketStream = createReadableWebSocketStream(webSocket, request.headers.get('sec-websocket-protocol'), log);

    const remoteSocketWrapper = { value: null };
    let udpStreamWrite = null;
    let isDns = false;

    readableWebSocketStream.pipeTo(createWritableStream({ remoteSocketWrapper, webSocket, log, userID, udpStreamWrite, isDns })).catch((err) => {
        log('readableWebSocketStream pipeTo error', err);
    });

    return new Response(null, { status: 101, webSocket: client });
}

function createWebSocketPair() {
    const webSocketPair = new WebSocketPair();
    return { client: Object.values(webSocketPair)[0], webSocket: Object.values(webSocketPair)[1] };
}

function createLogger() {
    let address = '';
    let portWithRandomLog = '';

    return (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
    };
}

function createReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;

    return new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener('message', (event) => {
                if (!readableStreamCancel) {
                    controller.enqueue(event.data);
                }
            });

            webSocketServer.addEventListener('close', () => {
                if (!readableStreamCancel) {
                    controller.close();
                }
                safeCloseWebSocket(webSocketServer);
            });

            webSocketServer.addEventListener('error', (err) => {
                log('webSocketServer has error');
                controller.error(err);
            });

            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull() { },
        cancel(reason) {
            if (!readableStreamCancel) {
                log(`ReadableStream was canceled, due to ${reason}`);
                readableStreamCancel = true;
                safeCloseWebSocket(webSocketServer);
            }
        },
    });
}

function createWritableStream({ remoteSocketWrapper, webSocket, log, userID, udpStreamWrite, isDns }) {
    return new WritableStream({
        async write(chunk, controller) {
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }

            if (remoteSocketWrapper.value) {
                const writer = remoteSocketWrapper.value.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            const { hasError, message, portRemote = 443, addressRemote, rawDataIndex, vlessVersion, isUDP } = processVlessHeader(chunk, userID);

            if (hasError) {
                throw new Error(message);
            }

            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);

            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                } else {
                    throw new Error('UDP proxy only enabled for DNS which is port 53');
                }
            }

            if (isDns) {
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
            } else {
                handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
            }
        },
        close() {
            log('readableWebSocketStream is close');
        },
        abort(reason) {
            log('readableWebSocketStream is abort', JSON.stringify(reason));
        },
    });
}

// 安全关闭WebSocket
function safeCloseWebSocket(webSocket) {
    try {
        webSocket.close();
    } catch (e) {
        console.log('Error closing webSocket:', e);
    }
}

// 处理VLESS头信息
function processVlessHeader(chunk, userID) {
    // 假设这里有解析VLESS头信息的逻辑
    // 返回一个示例对象
    return {
        hasError: false,
        message: '',
        portRemote: 443,
        addressRemote: 'example.com',
        rawDataIndex: 0,
        vlessVersion: new Uint8Array([0, 0]),
        isUDP: false,
    };
}

// 处理TCP外部连接
async function handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
    try {
        const remoteSocket = await connect(addressRemote, portRemote, { ip: proxyIP }); // 使用 proxyIP 连接到远程地址
        remoteSocketWrapper.value = remoteSocket;

        const { readable, writable } = remoteSocket;

        const remoteWriter = writable.getWriter();
        await remoteWriter.write(vlessResponseHeader);
        await remoteWriter.write(rawClientData);
        remoteWriter.releaseLock();

        readable.pipeTo(webSocket.writable).catch((err) => {
            log('remoteSocket readable pipeTo webSocket.writable error', err);
        });

        webSocket.readable.pipeTo(writable).catch((err) => {
            log('webSocket.readable pipeTo remoteSocket writable error', err);
        });
    } catch (err) {
        log('Error in handleTCPOutBound', err);
        safeCloseWebSocket(webSocket);
    }
}

// 处理UDP外部连接
async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {
    // 假设这里有处理UDP连接的逻辑
    // 返回一个示例对象
    return {
        write: (chunk) => {
            // 这里是写入UDP数据的逻辑
        },
    };
}

// Helper function to convert base64 to ArrayBuffer
function base64ToArrayBuffer(base64) {
    try {
        const binaryString = atob(base64);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return { earlyData: bytes.buffer, error: null };
    } catch (e) {
        return { earlyData: null, error: e };
    }
}

// Helper function to validate UUID
function isValidUUID(uuid) {
    const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab]{1}[0-9a-f]{3}-[0-9a-f]{12}$/i;
    return regex.test(uuid);
}

// 获取VLESS配置
function getVLESSConfig(userID, host) {
    // 假设这里生成并返回VLESS配置的逻辑
    return `vless://${userID}@${host}:443?encryption=none&security=tls&type=ws#VLESS+WS+TLS`;
}
