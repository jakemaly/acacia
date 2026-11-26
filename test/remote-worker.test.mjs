import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRemoteWorker } from '../src/remote-worker.mjs';

test('worker starts one run, forwards its MCP socket, and saves it on stop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-worker-test-'));
  const socket = join(root, 'mcp.sock');
  const mcp = createServer((request, response) => {
    if (request.headers.host !== '127.0.0.1:25575') return response.writeHead(403).end();
    response.end(`worker:${request.url}`);
  }).listen(socket);
  await once(mcp, 'listening');
  await mkdir(join(root, 'aabbccddeeff'));
  const viewer = createServer((request, response) => response.end(`viewer:${request.url}`)).listen(join(root, 'aabbccddeeff', 'viewer.sock'));
  await once(viewer, 'listening');
  let config, stopped = false, committed = false;
  const worker = await createRemoteWorker({ host: '127.0.0.1', port: 0, root, heartbeatMs: 0,
    async commit() { assert.equal(stopped, true); committed = true; },
    startRun(options) {
      config = options;
      return { id: 'aabbccddeeff', state: 'starting', done: new Promise(() => {}),
        async stop() { stopped = true; } };
    },
  });
  t.after(async () => { await worker.close(); mcp.closeAllConnections(); viewer.closeAllConnections(); await Promise.all([new Promise(resolve => mcp.close(resolve)), new Promise(resolve => viewer.close(resolve))]); await rm(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${worker.port}`;
  const start = await fetch(`${base}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'aabbccddeeff', hardcore: true }) });
  assert.equal(start.status, 202);
  assert.equal((await start.json()).id, 'aabbccddeeff');
  assert.equal(config.hardcore, true);
  assert.equal(config.viewerPrefix, '/api/modal/viewer/aabbccddeeff');
  const abort = new AbortController();
  const play = config.play({ socket, promptText: 'test prompt', signal: abort.signal });
  assert.equal(await (await fetch(`${base}/mcp?test=1`)).text(), 'worker:/mcp?test=1');
  assert.equal(await (await fetch(`${base}/api/modal/viewer/aabbccddeeff/index.js`)).text(), 'viewer:/api/modal/viewer/aabbccddeeff/index.js');
  assert.equal((await (await fetch(`${base}/context`)).json()).prompt, 'test prompt');
  assert.equal((await fetch(`${base}/archive/activity.jsonl`, { method: 'PUT', body: '{"event":"test"}\n' })).status, 200);
  assert.equal(await readFile(join(root, 'aabbccddeeff', 'controller', 'activity.jsonl'), 'utf8'), '{"event":"test"}\n');
  assert.equal((await fetch(`${base}/archive/auth.json`, { method: 'PUT', body: 'secret' })).status, 400);
  assert.equal((await fetch(`${base}/start`, { method: 'POST', body: '{}' })).status, 409);
  assert.equal((await fetch(`${base}/stop`, { method: 'POST' })).status, 200);
  assert.equal(stopped, true);
  assert.equal(committed, true);
  abort.abort();
  await play;
});

test('worker stops its run when the controller stops heartbeating', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-worker-heartbeat-'));
  let stopped = false, abandoned;
  const notified = new Promise(resolve => { abandoned = resolve; });
  const worker = await createRemoteWorker({ host: '127.0.0.1', port: 0, root, heartbeatMs: 50,
    onAbandon: abandoned, commit: async () => {},
    startRun() { return { id: 'aabbccddeeff', state: 'running', done: new Promise(() => {}), async stop() { stopped = true; } }; },
  });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  await fetch(`http://127.0.0.1:${worker.port}/start`, { method: 'POST', body: '{}' });
  await Promise.race([notified, new Promise((_, reject) => setTimeout(() => reject(new Error('Heartbeat did not expire')), 2000))]);
  assert.equal(stopped, true);
});

test('an unclaimed worker shuts down instead of consuming compute indefinitely', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-worker-unclaimed-'));
  let abandoned;
  const notified = new Promise(resolve => { abandoned = resolve; });
  const worker = await createRemoteWorker({ host: '127.0.0.1', port: 0, root, heartbeatMs: 50, onAbandon: abandoned });
  t.after(async () => { await worker.close(); await rm(root, { recursive: true, force: true }); });
  await Promise.race([notified, new Promise((_, reject) => setTimeout(() => reject(new Error('Unclaimed worker did not stop')), 2000))]);
});
