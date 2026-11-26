import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startModalRun } from '../src/modal-run.mjs';

test('a remote run keeps Pi local, records its manifest, and saves before terminating the worker', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let runId, onAbort;
  const worker = { sandboxId: 'sb-test', url: 'https://worker.invalid', token: 'secret' };
  const run = startModalRun({ root, agentDir: '/local/pi', hardcore: true }, {
    releaseManager: { prepare: async () => ({ digest: 'a'.repeat(64), imageId: 'im-test', path: root }) },
    control: async request => { events.push(request.command); return request.command === 'create' ? worker : {}; },
    request: async (_worker, path, options) => {
      events.push(path);
      if (path === '/start') { runId = options.body.id; return { id: runId, state: 'starting' }; }
      if (path === '/status') return { id: runId, state: 'running', seed: '7', hardcore: true };
      if (path === '/context') return { prompt: 'play the game' };
      if (path === '/manifest') return { id: runId, seed: '7', hardcore: true, sourceDigest: 'a'.repeat(64) };
      if (path === '/stop') return { id: runId, state: 'stopped' };
      return {};
    },
    play: async options => { assert.equal(options.agentDir, '/local/pi'); assert.equal(options.remoteMcp.token, 'secret');
      options.record('assistant', { text: 'ready' }); await new Promise(resolve => { onAbort = resolve; options.signal.addEventListener('abort', resolve, { once: true }); }); },
    upload: async (_worker, _path, name) => { events.push(`archive:${name}`); },
    pollMs: 5, heartbeatMs: 5,
  });
  for (let i = 0; i < 100 && !onAbort; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(run.state, 'running');
  const manifest = JSON.parse(await readFile(join(root, run.id, 'run.json'), 'utf8'));
  assert.equal(manifest.modal.sandboxId, 'sb-test');
  assert.doesNotMatch(JSON.stringify(manifest), /secret/);
  await run.stop();
  assert.equal(run.state, 'stopped');
  assert.ok(events.indexOf('archive:activity.jsonl') >= 0 && events.indexOf('archive:activity.jsonl') < events.indexOf('/stop'));
  assert.ok(events.indexOf('/stop') < events.indexOf('terminate'));
});

test('a worker that fails to save is not forcibly terminated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-save-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let id, started;
  const run = startModalRun({ root, agentDir: root, hardcore: true }, {
    releaseManager: { prepare: async () => ({ digest: 'b'.repeat(64), imageId: 'im-test', path: root }) },
    control: async request => { events.push(request.command); return { sandboxId: 'sb-test', url: 'https://worker.invalid', token: 'secret' }; },
    request: async (_worker, path, options) => {
      if (path === '/start') { id = options.body.id; return { id, state: 'starting' }; }
      if (path === '/status') return { id, state: 'running', seed: '7' };
      if (path === '/context') return { prompt: 'play' };
      if (path === '/manifest') return { id, sourceDigest: 'b'.repeat(64) };
      if (path === '/stop') throw new Error('sync failed');
      return {};
    },
    play: async options => { started = true; await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })); },
    upload: async () => {},
    pollMs: 5, heartbeatMs: 5,
  });
  for (let i = 0; i < 100 && !started; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(run.stop(), /sync failed/);
  assert.equal(run.state, 'incomplete');
  assert.match(run.detail, /sync failed/);
  assert.deepEqual(events, ['create']);
});

test('a time-limited worker saves and pauses for automatic same-world rollover', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-rollover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [];
  let id;
  const run = startModalRun({ root, agentDir: root, hardcore: true }, {
    releaseManager: { prepare: async () => ({ digest: 'c'.repeat(64), imageId: 'im-test', path: root }) },
    control: async request => { events.push(request.command); return { sandboxId: 'sb-test', url: 'https://worker.invalid', token: 'secret' }; },
    request: async (_worker, path, options) => {
      if (path === '/start') { id = options.body.id; return { id, state: 'starting' }; }
      if (path === '/status') return { id, state: 'running' };
      if (path === '/context') return { prompt: 'play' };
      if (path === '/manifest') return { id, sourceDigest: 'c'.repeat(64) };
      if (path === '/stop') { events.push('save'); return { state: 'stopped' }; }
      return {};
    },
    play: async options => new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true })),
    upload: async () => {}, pollMs: 2, rolloverMs: 30,
  });
  await run.done;
  assert.equal(run.state, 'paused');
  assert.equal(run.pauseReason, 'rollover');
  assert.deepEqual(events, ['create', 'save', 'terminate']);
});

test('reattaching to a finished worker records the terminal outcome without starting Pi again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-terminal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = '123456789abc';
  let played = false;
  const run = startModalRun({ root, agentDir: root, id, runKey: 'a'.repeat(32), workerId: 'sb-test', resume: true,
    release: { digest: 'd'.repeat(64), imageId: 'im-test', path: root } }, {
    control: async request => request.command === 'recover' ? { alive: true, sandboxId: 'sb-test', url: 'https://worker.invalid', token: 'secret' } : {},
    request: async (_worker, path) => {
      if (path === '/status' || path === '/stop') return { id, state: 'won', detail: 'Dragon defeated.' };
      if (path === '/manifest') return { id, sourceDigest: 'd'.repeat(64) };
      return {};
    },
    play: async () => { played = true; }, upload: async () => {},
  });
  await run.done;
  assert.equal(run.state, 'won');
  assert.equal(played, false);
  assert.equal(JSON.parse(await readFile(join(root, id, 'result.json'), 'utf8')).state, 'won');
});
