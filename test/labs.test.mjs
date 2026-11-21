import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateLabChecks, labCheckpoints, labFixtures, resolveLabCheckpoint, validateLabChecks } from '../src/labs.mjs';

test('the fixture library contains the authored Blaze and reflex trials', async () => {
  const fixtures = await labFixtures();
  assert.deepEqual(fixtures.map(fixture => fixture.id).sort(), ['blaze-spawner-tool', 'hunger-reflex']);
  assert.equal(fixtures.find(fixture => fixture.id === 'blaze-spawner-tool').controller.name, 'farm_blaze_spawner');
  assert.deepEqual(fixtures.find(fixture => fixture.id === 'blaze-spawner-tool').activateCommands, ['/difficulty normal']);
  assert.equal(fixtures.find(fixture => fixture.id === 'hunger-reflex').controller.type, 'idle');
});

test('checkpoints list published saves and resolve only listed checkpoint IDs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-labs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = '123456abcdef';
  const run = 'abcdef123456';
  const name = '01234567-89ab-cdef-0123-456789abcdef';
  const checkpoint = join(root, 'checkpoints', session, run, name);
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(root, 'checkpoints', session, run, 'index.json'), JSON.stringify({
    slots: { recent: name, anchor: null }, incidents: [],
  }));
  await writeFile(join(checkpoint, 'checkpoint.json'), JSON.stringify({ at: 1234, context: { ageMs: 42 } }));
  const listed = await labCheckpoints(root);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].contextAgeMs, 42);
  assert.equal(resolveLabCheckpoint(root, listed[0].id, listed)?.path, checkpoint);
  assert.equal(resolveLabCheckpoint(root, `${session}/${run}/../../outside`, listed), null);
});

test('independent fixture checks count nearby drops and reject missing block evidence', () => {
  const checks = [
    { kind: 'healthAtLeast', value: 1 },
    { kind: 'inventoryOrNearbyAtLeast', item: 'blaze_rod', count: 20 },
    { kind: 'blockAt', pos: { x: 1, y: 2, z: 3 }, name: 'air' },
  ];
  const status = {
    vitals: { health: 20 },
    inventory: { stacks: [] },
    nearby: { droppedItems: [{ name: 'blaze_rod', count: 20 }] },
  };
  assert.deepEqual(evaluateLabChecks(checks, { status, blocks: [{ x: 1, y: 2, z: 3, name: 'air' }] }), {
    passed: true,
    checks: [
      { check: checks[0], actual: 20, passed: true },
      { check: checks[1], actual: { carried: 0, nearby: 20, total: 20 }, passed: true },
      { check: checks[2], actual: 'air', passed: true },
    ],
  });
  assert.equal(evaluateLabChecks(checks, { status, blocks: [] }).passed, false);
  assert.equal(evaluateLabChecks(checks, { status: { ...status, nearby: { droppedItems: [] } },
    blocks: [{ x: 1, y: 2, z: 3, name: 'air' }], groundItems: { blaze_rod: 20 } }).passed, true);
  assert.equal(evaluateLabChecks([], {}).passed, false);
});

test('reflex checks require both eating and a raised hunger bar', () => {
  const checks = [
    { kind: 'foodAtLeast', value: 11 },
    { kind: 'inventoryBelow', item: 'bread', count: 3 },
  ];
  const baseline = { vitals: { food: 10 }, inventory: { stacks: [{ name: 'bread', count: 3 }] } };
  const result = evaluateLabChecks(checks, {
    status: { vitals: { food: 12 }, inventory: { stacks: [{ name: 'bread', count: 2 }] } },
  }, baseline);
  assert.equal(result.passed, true);
});

test('checkpoint success checks accept only bounded observable predicates', () => {
  assert.deepEqual(validateLabChecks([{ kind: 'inventoryAtLeast', item: 'blaze_rod', count: 20 }]),
    [{ kind: 'inventoryAtLeast', item: 'blaze_rod', count: 20 }]);
  assert.throws(() => validateLabChecks([{ kind: 'runShell', command: 'rm -rf' }]), /unsupported/);
  assert.throws(() => validateLabChecks(Array.from({ length: 17 }, () => ({ kind: 'foodAtLeast', value: 10 }))), /sixteen/);
});
