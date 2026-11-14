import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followAction } from '../src/action-wait.mjs';

const actionId = '1234-abcd';
const reply = (state, fields = {}) => ({
  content: [], structuredContent: { response: { format: 'json', data: { actionId, state, ...fields } } },
});
const sample = ({ remainingDistance, health = 20, state = 'running', checkpoint = {}, current, ...duringWait }) => reply('pending', {
  progress: { progress: { state, current }, request: { evidence: { checkpoint: { ...checkpoint, remainingDistance } } } },
  duringWait, vitalsDuringWait: { healthBefore: 20, healthAfter: health },
});
const settled = reply('settled', { output: { action: 'navigate', result: { status: 'succeeded' } } });

async function follow(t, responses, { name = 'navigate', args = {}, requestedWait = 60_000 } = {}) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const calls = [];
  const events = [];
  const result = await followAction({
    name, args: { submission_id: 'stable', response_format: 'json', ...args },
    requestedWait, pollMs: 5000,
    async call(tool, args) {
      calls.push({ tool, ...args });
      if (tool === name) return reply('accepted');
      assert.equal(args.action_id, actionId);
      now += args.timeout_ms;
      assert.ok(responses.length, 'unexpected extra wait');
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onProgress: progress => events.push(progress),
    isTransportFailure: error => error.message === 'fixture stream disconnected',
  });
  return { result, calls, events };
}

test('a single navigation call follows the original action through progress and a detour', async t => {
  const { result, calls, events } = await follow(t, [
    sample({ remainingDistance: 40 }), sample({ remainingDistance: 44 }),
    sample({ remainingDistance: 28 }), sample({ remainingDistance: 11 }), settled,
  ]);
  assert.equal(result, settled);
  assert.deepEqual(calls.map(call => call.tool), ['navigate', ...Array(5).fill('wait_for_action')]);
  assert.equal(calls[0].submission_id, 'stable');
  assert.deepEqual(events.map(event => event.remainingDistance), [40, 44, 28, 11]);
});

test('repeated movement in a circle hands back an active action and explicit choices', async t => {
  const { result, calls } = await follow(t, [
    ...[40, 41, 40, 41].map(remainingDistance => sample({ remainingDistance, distanceTravelledBlocks: 8 })),
  ]);
  const text = result.content[0].text;
  assert.match(text, /1234-abcd/);
  assert.match(text, /no verified progress/i);
  assert.match(text, /wait_for_action.*cancel_foreground_action/s);
  assert.equal(calls.length, 5);
});

test('a safety change hands back the active action promptly', async t => {
  const { result, calls } = await follow(t, [sample({ remainingDistance: 40, health: 14 })]);
  assert.match(result.content[0].text, /health dropped/i);
  assert.equal(calls.length, 2);
});

test('the runtime settles its execution deadline and supplies the final reason', async t => {
  const timedOut = reply('settled', {
    output: { action: 'navigate', result: { status: 'cancelled', error: '[ACTION_EXECUTION_TIMEOUT]' } },
  });
  timedOut.isError = true;
  const { result, calls } = await follow(t, [sample({ remainingDistance: 40 }), timedOut], {
    args: { execution_timeout_ms: 5000 },
  });
  assert.equal(result, timedOut);
  assert.deepEqual(calls.map(call => call.tool), ['navigate', 'wait_for_action', 'wait_for_action']);
});

test('ending the observational wait leaves the action active', async t => {
  const { result, calls } = await follow(t, [sample({ remainingDistance: 40 })], { requestedWait: 5000 });
  assert.match(result.content[0].text, /requested wait ended/i);
  assert.match(result.content[0].text, /1234-abcd/);
  assert.equal(calls.length, 2);
});

test('unavailable progress preserves the admitted action ID and choices', async t => {
  const unavailable = { content: [], isError: true, structuredContent: {
    response: { format: 'json', data: { state: 'refused', code: 'PROGRESS_UNAVAILABLE' } },
  } };
  const { result, calls } = await follow(t, [unavailable]);
  assert.match(result.content[0].text, /progress is unavailable/i);
  assert.match(result.content[0].text, /1234-abcd/);
  assert.match(result.content[0].text, /wait_for_action.*cancel_foreground_action/s);
  assert.equal(calls.length, 2);
});

test('declared recovery and finite spawn observation do not use the stall allowance', async t => {
  const observationUntil = Date.now() + 60_000;
  const { result, calls } = await follow(t, [
    sample({ checkpoint: { gained: 0, requested: 2 } }),
    ...Array.from({ length: 4 }, () => sample({ state: 'suspended' })),
    ...Array.from({ length: 4 }, () => sample({
      checkpoint: { phase: 'observing', camp: { phase: 'waiting_away', returnAfter: observationUntil } },
    })),
    settled,
  ], { name: 'collect_mob_drop' });
  assert.equal(result, settled);
  assert.equal(calls.length, 11);
});

test('a pending safety handoff preserves the runtime snapshot and active ID', async t => {
  const danger = sample({ remainingDistance: 40 });
  danger.structuredContent.response.data.survival = {
    summary: 'responding', dangers: [{ selected: true, stale: false, reflex: 'fire_reflex' }],
  };
  const { result, calls } = await follow(t, [danger]);
  assert.equal(calls.length, 2);
  assert.equal(result.structuredContent.response.data.actionId, actionId);
  assert.equal(result.structuredContent.response.data.survival.summary, 'responding');
  assert.match(result.content[0].text, /Immediate danger.*fire_reflex/);
});


test('resolving a destination height resets the horizontal distance baseline', async t => {
  const { result } = await follow(t, [
    sample({ remainingDistance: null, checkpoint: { positionedDimension: 'overworld' },
      current: { dimension: 'overworld', x: 1, y: 60, z: 0 } }),
    ...[21, 19, 17].map(remainingDistance => sample({ remainingDistance,
      checkpoint: { destination: { x: 0, y: 82, z: 0 } } })),
    settled,
  ], { args: { x: 0, z: 0 } });
  assert.equal(result, settled);
});

test('a lost receipt formatting response preserves the settled typed result', async t => {
  const { result } = await follow(t, [settled, new Error('fixture stream disconnected')],
    { args: { response_format: 'markdown' } });
  assert.equal(result, settled);
});

test('a failed reconnect during a poll preserves the known action handle', async t => {
  const { result } = await follow(t, [new Error('fixture stream disconnected')]);
  assert.match(result.content[0].text, /1234-abcd/);
  assert.match(result.content[0].text, /awaiting confirmation/);
});
