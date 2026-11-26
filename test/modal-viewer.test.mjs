import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { proxyViewerHttp, proxyViewerUpgrade } from '../src/modal-viewer.mjs';

test('viewer proxy forwards HTTP and WebSocket traffic with the worker token', async t => {
  const upstream = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer private-token');
    res.end(`asset:${req.url}`);
  });
  const wsServer = new WebSocketServer({ server: upstream });
  wsServer.on('connection', (socket, req) => { assert.equal(req.headers.authorization, 'Bearer private-token'); socket.on('message', data => socket.send(data)); });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const worker = { url: `http://127.0.0.1:${upstream.address().port}`, token: 'private-token' };
  const local = createServer((req, res) => { void proxyViewerHttp(worker, req, res); });
  local.on('upgrade', (req, socket, head) => proxyViewerUpgrade(worker, req, socket, head));
  local.listen(0, '127.0.0.1');
  await once(local, 'listening');
  t.after(async () => { wsServer.close(); local.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise(resolve => local.close(resolve)), new Promise(resolve => upstream.close(resolve))]); });
  const base = `127.0.0.1:${local.address().port}`;
  assert.equal(await (await fetch(`http://${base}/api/modal/viewer/aabbccddeeff/index.js`)).text(), 'asset:/api/modal/viewer/aabbccddeeff/index.js');
  const ws = new WebSocket(`ws://${base}/api/modal/viewer/aabbccddeeff/socket.io`);
  await once(ws, 'open');
  ws.send('viewer data');
  const [message] = await once(ws, 'message');
  assert.equal(message.toString(), 'viewer data');
  ws.close();
  await once(ws, 'close');
});
