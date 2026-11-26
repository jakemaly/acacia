import { request } from 'undici';
import { WebSocket, WebSocketServer } from 'ws';

const socketServer = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
const ignoredHeaders = new Set(['host', 'authorization', 'cookie', 'connection', 'upgrade', 'keep-alive', 'proxy-authorization', 'transfer-encoding']);

function viewerUrl(worker, path) {
  const match = /^\/api\/modal\/viewer\/([a-f0-9]{12})\//.exec(path);
  if (!match) throw new Error('Invalid viewer path.');
  const base = new URL(worker.url);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
    throw new Error('Modal viewer requires HTTPS.');
  }
  if (!worker.token) throw new Error('Modal worker connection token is missing.');
  const result = new URL(path, base);
  if (result.origin !== base.origin || !result.pathname.startsWith(`/api/modal/viewer/${match[1]}/`)) throw new Error('Invalid viewer path.');
  return result;
}

export async function proxyViewerHttp(worker, req, res) {
  try {
    const url = viewerUrl(worker, req.url);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => !ignoredHeaders.has(name.toLowerCase())));
    headers.authorization = `Bearer ${worker.token}`;
    const upstream = await request(url, { method: req.method, headers,
      ...(req.method !== 'GET' && req.method !== 'HEAD' && { body: req }), headersTimeout: 30_000 });
    const responseHeaders = Object.fromEntries(Object.entries(upstream.headers).filter(([name]) => !ignoredHeaders.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie'));
    res.writeHead(upstream.statusCode, responseHeaders);
    upstream.body.on('error', () => res.destroy());
    res.on('close', () => upstream.body.destroy());
    upstream.body.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('Viewer unavailable.');
    else res.destroy();
  }
}

export function proxyViewerUpgrade(worker, req, socket, head) {
  let upstream;
  try {
    const url = viewerUrl(worker, req.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    upstream = new WebSocket(url, { headers: { authorization: `Bearer ${worker.token}` }, perMessageDeflate: false,
      maxPayload: 32 * 1024 * 1024, handshakeTimeout: 15_000 });
  } catch { socket.destroy(); return; }
  socket.once('error', () => upstream.terminate());
  socket.once('close', () => { if (upstream.readyState !== WebSocket.CLOSED) upstream.terminate(); });
  upstream.once('error', () => socket.destroy());
  upstream.once('open', () => {
    if (socket.destroyed) return upstream.terminate();
    socketServer.handleUpgrade(req, socket, head, client => {
      client.on('message', (data, binary) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary }); });
      upstream.on('message', (data, binary) => { if (client.readyState === WebSocket.OPEN) client.send(data, { binary }); });
      client.on('error', () => upstream.terminate());
      client.on('close', () => upstream.close());
      upstream.on('close', () => client.close());
      upstream.on('error', () => client.terminate());
    });
  });
}
