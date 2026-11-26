import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createBatch } from '../src/batch.mjs';

function harness() {
  const runs = [];
  const startRun = ({ slot, parent }) => {
    let finish;
    const run = { id: `run-${runs.length}`, slot, parent, state: 'running',
      done: new Promise(resolve => { finish = resolve; }),
      end(state) { run.state = state; finish(); },
      stop() { run.end('stopped'); return run.done; } };
    runs.push(run);
    return run;
  };
  return { runs, batch: createBatch({ startRun, reviewDeath: async () => {}, retryDelay: async () => {} }) };
}

test('maintains independent slots after a hardcore death and stops all on a win', async () => {
  const { runs, batch } = harness();
  await batch.start({ count: 2, hardcore: true });
  assert.equal(runs.length, 2);
  runs[0].end('dead');
  await tick();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].slot, 0);
  assert.equal(runs[2].parent, runs[0].id);
  runs[1].end('won');
  await tick();
  assert.equal(batch.status().state, 'won');
  assert.equal(runs[2].state, 'stopped');
  assert.equal(runs.length, 3);
});

test('pauses all slots after three consecutive failed attempts in one slot', async () => {
  const { runs, batch } = harness();
  await batch.start({ count: 2, hardcore: true });
  for (const run of [0, 2, 3]) {
    runs[run].end('incomplete');
    await tick();
  }
  assert.equal(batch.status().state, 'paused');
  assert.equal(runs[1].state, 'stopped');
  assert.equal(runs.length, 4);
});

test('operator stop prevents pending death review from restarting a slot', async () => {
  let finishReview;
  const { runs, batch } = harness();
  const gate = new Promise(resolve => { finishReview = resolve; });
  batch.reviewDeath = () => gate;
  await batch.start({ count: 1, hardcore: true });
  runs[0].end('dead');
  await tick();
  await batch.stop();
  finishReview();
  await tick();
  assert.equal(batch.status().state, 'stopped');
  assert.equal(runs.length, 1);
});

test('a failed death review does not prevent the next attempt', async () => {
  const { runs, batch } = harness();
  batch.reviewDeath = async () => { throw new Error('review unavailable'); };
  await batch.start({ count: 1, hardcore: true });
  runs[0].end('dead');
  await tick();
  assert.equal(runs.length, 2);
  assert.equal(batch.status().state, 'running');
  assert.match(batch.status().slots[0].reviewError, /review unavailable/);
});

test('a stop failure still stops other slots and reports that cleanup failed', async () => {
  const { runs, batch } = harness();
  await batch.start({ count: 2 });
  runs[0].stop = () => { throw new Error('worker unreachable'); };
  await batch.stop();
  assert.equal(runs[1].state, 'stopped');
  assert.equal(batch.status().state, 'paused');
  assert.match(batch.status().detail, /worker unreachable/);
});

test('batch status does not expose private connection credentials', async () => {
  const { runs, batch } = harness();
  await batch.start({ count: 1 });
  runs[0].remoteMcp = { token: 'private-connect-token' };
  assert.doesNotMatch(JSON.stringify(batch.status()), /private-connect-token/);
  await batch.stop();
});

test('a paused batch can restore the saved identity of each slot', async () => {
  const started = [];
  const batch = createBatch({ startRun(options) {
    started.push(options);
    return { id: options.resume?.id ?? 'fresh', state: 'running', done: new Promise(() => {}), async stop() {} };
  } });
  await batch.start({ count: 1, hardcore: true, resumeSlots: [{ id: 'aabbccddeeff', runKey: 'a'.repeat(32) }] });
  assert.equal(started[0].resume.id, 'aabbccddeeff');
  assert.equal(started[0].resume.runKey, 'a'.repeat(32));
  await batch.stop();
});

test('resizing stops only removed worlds and adds new worlds without restarting existing ones', async () => {
  const { runs, batch } = harness();
  await batch.start({ count: 4 });
  await batch.resize(2);
  assert.deepEqual(runs.map(run => run.state), ['running', 'running', 'stopped', 'stopped']);
  assert.deepEqual(batch.status().slots.map(slot => slot.run.id), ['run-0', 'run-1']);
  await batch.resize(3);
  assert.deepEqual(batch.status().slots.map(slot => slot.run.id), ['run-0', 'run-1', 'run-4']);
  await batch.stop();
});

test('a removed world cannot restart after its death review finishes', async () => {
  const { runs, batch } = harness();
  let finishReview;
  batch.reviewDeath = () => new Promise(resolve => { finishReview = resolve; });
  await batch.start({ count: 2, hardcore: true });
  runs[1].end('dead');
  await tick();
  await batch.resize(1);
  finishReview();
  await tick();
  assert.equal(runs.length, 2);
  assert.equal(batch.status().slots.length, 1);
  await batch.stop();
});
