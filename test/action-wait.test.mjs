import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followAction } from '../src/action-wait.mjs';

const actionId = '1234-abcd';
const reply = (state, fields = {}) => ({
  content: [], structuredContent: { response: { format: 'json', data: { actionId, state, ...fields } } },
});
const sample = ({ remainingDistance, health = 20, state = 'running', checkpoint = {}, ...duringWait }) => reply('pending', {
  progress: { progress: { state }, request: { evidence: { checkpoint: { ...checkpoint, remainingDistance } } } },
  duringWait, vitalsDuringWait: { healthBefore: 20, healthAfter: health },
});
const settled = reply('settled', { output: { action: 'navigate', result: { status: 'succeeded' } } });

async function follow(t, responses, { name = 'navigate', args = {} } = {}) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const calls = [];
  const events = [];
  const result = await followAction({
    name, args: { submission_id: 'stable', response_format: 'json', ...args },
    requestedWait: 60_000, pollMs: 5000,
    async call(tool, args) {
      calls.push({ tool, ...args });
      if (tool === name) return reply('accepted');
      assert.equal(args.action_id, actionId);
      if (tool === 'cancel_foreground_action') return reply('cancellation_requested');
      now += args.timeout_ms;
      assert.ok(responses.length, 'unexpected extra wait');
      return responses.shift();
    },
    onProgress: progress => events.push(progress),
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

test('a reached job deadline cancels once and retrieves terminal evidence', async t => {
  const { result, calls } = await follow(t, [sample({ remainingDistance: 40 }), settled], {
    args: { execution_timeout_ms: 5_000 },
  });
  assert.equal(result, settled);
  assert.deepEqual(calls.map(call => call.tool), ['navigate', 'wait_for_action', 'cancel_foreground_action', 'wait_for_action']);
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
