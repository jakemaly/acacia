import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dashboard } from '../src/server.mjs';

test('the existing dashboard starts a Modal batch and selects a live worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-dashboard-'));
  let selection;
  const remote = { id: 'aabbccddeeff', state: 'running', seed: '17', hardcore: true, activity: [],
    viewer: '/api/modal/viewer/aabbccddeeff/', proxyViewer(_req, res) { res.end('viewer'); } };
  const service = { status: () => ({ state: 'running', desiredCount: 4, slots: [{ index: 0, run: remote }] }),
    async start(input) { selection = input; }, async stop() {}, async resume() {}, async close() {},
    getRun: id => id === remote.id ? remote : undefined };
  const app = await dashboard({ host: '127.0.0.1', port: 0, root, agentDir: root, viewerPort: 3000, gamePort: 25565,
    allowed: new Set(['127.0.0.1']), modalService: service });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${app.port}`;
  const start = await fetch(`${origin}/api/modal/start`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ count: 4, mode: 'hardcore' }) });
  assert.equal(start.status, 202);
  assert.deepEqual(selection, { count: 4, hardcore: true });
  const status = await (await fetch(`${origin}/api/run?modal=${remote.id}`)).json();
  assert.equal(status.id, remote.id);
  assert.equal(status.viewer, remote.viewer);
  assert.equal(await (await fetch(`${origin}${remote.viewer}`)).text(), 'viewer');
});

test('dashboard recovery does not treat a finished Modal world as a local hardcore run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-dashboard-recovery-'));
  const directory = join(root, '123456789abc');
  await mkdir(directory);
  await writeFile(join(directory, 'run.json'), JSON.stringify({ hardcore: true, modal: { runKey: 'a'.repeat(32) } }));
  await writeFile(join(directory, 'result.json'), JSON.stringify({ state: 'dead' }));
  let reviews = 0;
  const service = { async close() {}, status: () => ({ state: 'idle', slots: [] }) };
  const app = await dashboard({ host: '127.0.0.1', port: 0, root, agentDir: root, viewerPort: 3000, gamePort: 25565,
    allowed: new Set(['127.0.0.1']), modalService: service, reflect: async () => { reviews++; } });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const status = await (await fetch(`http://127.0.0.1:${app.port}/api/run`)).json();
  assert.equal(status.state, 'idle');
  assert.equal(reviews, 0);
});
