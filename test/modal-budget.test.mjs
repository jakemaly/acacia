import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateBudget } from '../src/modal-budget.mjs';

test('budget guard includes unreported worker usage and pauses on stale data', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const sample = { meteredUsd: '27.50', cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-12-01T00:00:00Z', fetchedAt: new Date(now).toISOString() };
  assert.equal(evaluateBudget({ sample, now, activeWorkers: 4 }).allowed, false);
  assert.equal(evaluateBudget({ sample: { ...sample, meteredUsd: '10' }, now, activeWorkers: 4 }).allowed, true);
  assert.equal(evaluateBudget({ sample: { ...sample, fetchedAt: new Date(now - 181_000).toISOString() }, now, activeWorkers: 4 }).allowed, false);
  assert.equal(evaluateBudget({ sample: null, now, activeWorkers: 4 }).allowed, false);
});

test('pilot pauses when measured aggregate compute exceeds one dollar per hour', () => {
  const now = Date.parse('2026-11-25T12:00:00Z');
  const sample = { meteredUsd: '1', cycleStart: '2026-11-01T00:00:00Z', cycleEnd: '2026-12-01T00:00:00Z', fetchedAt: new Date(now).toISOString() };
  const stats = Array.from({ length: 4 }, () => ({ costUsd: '0.05', durationSeconds: 600 }));
  const result = evaluateBudget({ sample, now, activeWorkers: 4, pilotStats: stats });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /pilot/i);
});
