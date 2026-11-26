import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createModalBatchService } from '../src/modal-batch-service.mjs';

test('batch starts only with a healthy budget, persists its state, and stops all slots', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-service-'));
  const now = Date.now();
  let amount = 29, launches = 0, stops = 0;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0, budgetVerified: true,
    control: async request => request.command === 'budget' ? { meteredUsd: String(amount), fetchedAt: new Date(now).toISOString(),
      cycleStart: new Date(now - 60_000).toISOString(), cycleEnd: new Date(now + 60_000).toISOString() } : {},
    startRun(config) {
      launches++;
      let resolve;
      const run = { id: String(launches).padStart(12, '0'), runKey: 'a'.repeat(32), state: 'running', hardcore: config.hardcore,
        done: new Promise(done => { resolve = done; }), async stop() { stops++; run.state = 'stopped'; resolve(); } };
      return run;
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(service.start({ count: 2, hardcore: true }), /\$28/);
  assert.equal(launches, 0);
  amount = 1;
  await service.start({ count: 2, hardcore: true });
  assert.equal(launches, 2);
  await service.stop();
  assert.equal(stops, 2);
  assert.equal(service.status().state, 'stopped');
  assert.equal(JSON.parse(await readFile(join(root, 'modal-batch.json'), 'utf8')).state, 'stopped');
});

test('batch refuses to launch when the workspace cap is not verified', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-cap-'));
  let launches = 0;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0,
    control: async () => { launches++; return {}; }, startRun: () => { launches++; } });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await assert.rejects(service.start({ count: 4 }), /spend limit has not been verified/);
  assert.equal(launches, 0);
});

test('a confirmed zero-dollar spend limit permits a launch; an old usage-limit confirmation does not', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-spend-limit-'));
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0,
    control: async () => ({ meteredUsd: '1', fetchedAt: new Date().toISOString(),
      cycleStart: new Date(Date.now() - 60_000).toISOString(), cycleEnd: new Date(Date.now() + 60_000).toISOString() }),
    startRun() { return { id: '123456789abc', state: 'running', done: new Promise(() => {}), async stop() {} }; },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'modal-budget-verified.json'), JSON.stringify({ workspaceUsageLimitUsd: 30 }));
  await assert.rejects(service.start({ count: 1 }), /\$0 Modal out-of-pocket spend limit/);
  await writeFile(join(root, 'modal-budget-verified.json'), JSON.stringify({ workspaceSpendLimitUsd: 0 }));
  await service.start({ count: 1 });
  assert.equal(service.status().state, 'running');
});

test('a saved batch restores its archived Pi session and keeps the same worker identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-recovery-'));
  const run = { id: '123456789abc', runKey: 'a'.repeat(32), workerId: 'sb-existing', workerCreatedAt: 123,
    startedAt: Date.now(), release: { path: '/release', digest: 'b'.repeat(64), imageId: 'im-release' }, state: 'running' };
  await writeFile(join(root, 'modal-batch.json'), JSON.stringify({ state: 'running', desiredCount: 1, hardcore: true,
    autoResume: true, slots: [{ index: 0, run }] }));
  let launched, restored;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0, budgetVerified: true,
    control: async () => ({ meteredUsd: '1', fetchedAt: new Date().toISOString(),
      cycleStart: new Date(Date.now() - 60_000).toISOString(), cycleEnd: new Date(Date.now() + 60_000).toISOString() }),
    restoreSession: async (identity, directory) => { restored = { identity, directory }; return join(directory, 'restored.jsonl'); },
    startRun(config) { launched = config; return { ...run, done: new Promise(() => {}), async stop() {} }; },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.recover();
  assert.deepEqual(restored.identity, { runId: run.id, runKey: run.runKey });
  assert.equal(launched.id, run.id);
  assert.equal(launched.workerId, run.workerId);
  assert.equal(launched.workerCreatedAt, 123);
  assert.equal(launched.resumeSession, join(root, run.id, 'restored.jsonl'));
});

test('a budget interruption saves all worlds and resumes them when usage is safe again', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-budget-'));
  let amount = 1, launches = 0, stops = 0;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0, retryMs: 0, budgetVerified: true,
    control: async () => ({ meteredUsd: String(amount), fetchedAt: new Date().toISOString(),
      cycleStart: new Date(Date.now() - 60_000).toISOString(), cycleEnd: new Date(Date.now() + 60_000).toISOString() }),
    startRun(config) {
      launches++;
      let resolve;
      const run = { id: config.id ?? String(launches).padStart(12, '0'), runKey: 'a'.repeat(32), state: 'running',
        release: { path: '/release', imageId: 'im-release', digest: 'b'.repeat(64) }, hardcore: config.hardcore,
        done: new Promise(done => { resolve = done; }), async stop() { stops++; run.state = 'stopped'; resolve(); } };
      return run;
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.start({ count: 2 });
  amount = 29;
  await service.check();
  assert.equal(service.status().state, 'paused');
  assert.equal(stops, 2);
  amount = 1;
  await service.check();
  assert.equal(service.status().state, 'running');
  assert.equal(launches, 4);
});

test('failed worker cleanup disables automatic resumption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-cleanup-'));
  let amount = 1;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0, retryMs: 0, budgetVerified: true,
    control: async () => ({ meteredUsd: String(amount), fetchedAt: new Date().toISOString(),
      cycleStart: new Date(Date.now() - 60_000).toISOString(), cycleEnd: new Date(Date.now() + 60_000).toISOString() }),
    startRun() { return { id: '123456789abc', runKey: 'a'.repeat(32), state: 'running', done: new Promise(() => {}),
      async stop() { throw new Error('save failed'); } }; },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.start({ count: 1 });
  amount = 29;
  await service.check();
  assert.equal(service.status().state, 'paused');
  assert.equal(service.status().pauseKind, 'cleanup');
  assert.equal(service.status().autoResume, false);
  assert.match(service.status().detail, /save failed/);
});

test('resizing checks the budget and preserves the retained workers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-batch-resize-'));
  let launches = 0, stops = 0;
  const service = await createModalBatchService({ root, repo: root, agentDir: root, pollMs: 0, budgetVerified: true,
    control: async () => ({ meteredUsd: '1', fetchedAt: new Date().toISOString(),
      cycleStart: new Date(Date.now() - 60_000).toISOString(), cycleEnd: new Date(Date.now() + 60_000).toISOString() }),
    startRun() {
      const id = String(++launches).padStart(12, '0');
      let resolve;
      const run = { id, state: 'running', done: new Promise(done => { resolve = done; }),
        async stop() { stops++; run.state = 'stopped'; resolve(); } };
      return run;
    },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  await service.start({ count: 4 });
  const retained = service.status().slots.slice(0, 2).map(slot => slot.run.id);
  await service.resize(2);
  assert.equal(stops, 2);
  assert.equal(launches, 4);
  assert.equal(service.status().desiredCount, 2);
  assert.deepEqual(service.status().slots.map(slot => slot.run.id), retained);
});
