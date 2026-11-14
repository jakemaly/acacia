import assert from 'node:assert/strict';
import { test } from 'node:test';
import { followAction } from '../src/action-wait.mjs';

const actionId = '1234-abcd';
const reply = (state, fields = {}) => ({
  content: [], structuredContent: { response: { format: 'json', data: { actionId, state, ...fields } } },
});
const sample = (checkpoint = {}, state = 'running') => reply('pending', {
  progress: { progress: { state }, request: { evidence: { checkpoint } } },
});
const settled = reply('settled', { output: { action: 'navigate', result: { status: 'succeeded' } } });

async function follow(t, responses, { name = 'navigate', executionLimit, pollMs = 5000 } = {}) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const calls = [];
  const events = [];
  const result = await followAction({
    name, args: { submission_id: 'stable' }, executionLimit, pollMs,
    async call(tool, args) {
      calls.push({ tool, ...args });
      if (tool === name) return reply('accepted');
      assert.equal(args.action_id, actionId);
      if (tool === 'cancel_foreground_action') return reply('cancellation_requested');
      assert.ok(responses.length, 'unexpected extra wait');
      if (args.response_format === 'markdown') assert.equal(args.timeout_ms, 0);
      now += args.timeout_ms;
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onProgress: progress => events.push(progress),
    isTransportFailure: error => error.message === 'fixture stream disconnected',
  });
  return { result, calls, events };
}

test('an action can outlast a two-minute observation limit without involving the model', async t => {
  const reports = Array.from({ length: 32 }, (_, i) => sample({ furnaceOutput: Math.floor(i / 2), requested: 16 }));
  const { result, calls, events } = await follow(t, [...reports, settled, settled], { name: 'smelt_item' });
  assert.equal(result, settled);
  assert.equal(calls[0].submission_id, 'stable');
  assert.equal(calls.length, 35);
  assert.equal(events.length, 32);
  assert.equal(events.at(-1).furnaceOutput, 15);
});

test('recovery and missing telemetry keep the same action until its partial or final result', async t => {
  const unavailable = { ...reply('refused', { code: 'PROGRESS_UNAVAILABLE' }), isError: true };
  const recovering = sample({}, 'suspended');
  recovering.structuredContent.response.data.vitalsDuringWait = { healthBefore: 20, healthAfter: 13 };
  const { result, events } = await follow(t, [
    unavailable, recovering, sample({ remainingDistance: 20 }, 'resuming'), settled, settled,
  ]);
  assert.equal(result, settled);
  assert.deepEqual(events.map(event => event.state), ['suspended', 'resuming']);
});

test('the runtime settles its advertised execution deadline and supplies the final reason', async t => {
  const timedOut = reply('settled', {
    output: { action: 'navigate', result: { status: 'cancelled', error: '[ACTION_EXECUTION_TIMEOUT]' } },
  });
  timedOut.isError = true;
  const { result, calls } = await follow(t, [sample(), timedOut, timedOut], { executionLimit: 5000 });
  assert.equal(result, timedOut);
  assert.equal(calls[0].execution_timeout_ms, 5000);
  assert.ok(calls.slice(1).every(call => call.tool === 'wait_for_action'));
});

test('older runtimes get a single targeted cancellation and the final receipt after expiry', async t => {
  const { result, calls } = await follow(t, [...Array.from({ length: 15 }, () => sample()), settled, settled], {
    pollMs: 60_000,
  });
  assert.equal(result, settled);
  assert.equal(calls[0].execution_timeout_ms, undefined);
  const cancellation = calls.filter(call => call.tool === 'cancel_foreground_action');
  assert.equal(cancellation.length, 1);
  assert.equal(cancellation[0].action_id, actionId);
  assert.equal(calls.at(-1).response_format, 'markdown');
});

test('a lost receipt formatting response preserves the settled typed result', async t => {
  const { result } = await follow(t, [settled, new Error('fixture stream disconnected')]);
  assert.equal(result, settled);
});

test('a failed reconnect during a poll preserves the known action handle', async t => {
  const { result } = await follow(t, [new Error('fixture stream disconnected')]);
  assert.match(result.content[0].text, /1234-abcd/);
  assert.match(result.content[0].text, /lost connection/i);
});
