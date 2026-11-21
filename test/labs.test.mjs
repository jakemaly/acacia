import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { evaluateLabChecks, labCheckpoints, labFixtures, readLabEvidence, resolveLabCheckpoint, validateLabChecks } from '../src/labs.mjs';
import { dashboard } from '../src/server.mjs';

test('the fixture library contains the authored Blaze and reflex trials', async () => {
  const fixtures = await labFixtures();
  assert.deepEqual(fixtures.map(fixture => fixture.id).sort(), ['blaze-spawner-tool', 'hunger-reflex']);
  assert.equal(fixtures.find(fixture => fixture.id === 'blaze-spawner-tool').controller.name, 'farm_blaze_spawner');
  assert.deepEqual(fixtures.find(fixture => fixture.id === 'blaze-spawner-tool').activateCommands, [
    '/gamerule doMobSpawning false',
    '/difficulty normal',
    '/execute in minecraft:the_nether run kill @e[type=minecraft:blaze,x=117,y=75,z=681,distance=..16]',
    '/execute in minecraft:the_nether run kill @e[type=minecraft:item,x=117,y=75,z=681,distance=..16]',
  ]);
  const blaze = fixtures.find(fixture => fixture.id === 'blaze-spawner-tool');
  assert.equal(blaze.version, 12);
  assert.equal(blaze.requiredBuild, 'candidate');
  assert.equal(blaze.controller.arguments.time_limit_ms, 840_000);
  assert.equal(blaze.controller.arguments.count, 20);
  assert.equal(blaze.timeLimitMs, 900_000);
  assert.equal(blaze.checks.find(check => check.kind === 'inventoryOrNearbyAtLeast').count, 20);
  assert.deepEqual(blaze.checks.find(check => check.kind === 'inventoryOrNearbyAtLeast').center,
    { dimension: 'minecraft:the_nether', x: 117.5, y: 72.5, z: 681.5, radius: 6 });
  assert.match(blaze.controller.arguments.rationale, /twenty new blaze rods/);
  assert.ok(blaze.prepare.includes('/execute in minecraft:the_nether run setblock 117 72 681 minecraft:nether_brick_slab[type=bottom]'));
  assert.ok(blaze.prepare.includes('/execute in minecraft:the_nether run setblock 117 74 681 minecraft:nether_bricks'));
  assert.ok(blaze.prepare.includes('/execute in minecraft:the_nether run data merge block 117 75 681 {SpawnRange:2,SpawnCount:4,MaxNearbyEntities:4}'));
  assert.equal(blaze.prepare.filter(command => command.includes('setblock 117 74 681 minecraft:nether_bricks')).length, 1);
  assert.ok(blaze.prepare.indexOf('/give Acacia minecraft:diamond_pickaxe') >
    blaze.prepare.findIndex(command => command.includes('weapon.mainhand with minecraft:diamond_sword')));
  assert.equal(fixtures.find(fixture => fixture.id === 'hunger-reflex').controller.type, 'idle');
});

test('Blaze advertises Candidate and rejects Current before starting an unsupported run', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-lab-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const host = '127.0.0.1';
  const app = await dashboard({ host, port: 0, root, agentDir: join(root, 'agent'), viewerPort: 3000,
    gamePort: 25565, allowed: new Set([host]) });
  t.after(() => app.close());

  const origin = `http://${host}:${app.port}`;
  const catalog = await (await fetch(`${origin}/api/lab`)).json();
  const blaze = catalog.fixtures.find(fixture => fixture.id === 'blaze-spawner-tool');
  assert.equal(blaze.requiredBuild, 'candidate');
  assert.equal(catalog.candidateAvailable, false);

  const response = await fetch(`${origin}/api/lab/start`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: blaze.id, build: 'current' }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Blaze spawner tool requires the candidate build.' });
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
    nearby: { droppedItems: [{ name: 'blaze_rod', count: 20, distance: 3.5 }] },
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
  assert.equal(evaluateLabChecks([{ kind: 'inventoryOrNearbyAtLeast', item: 'blaze_rod', count: 20 }], {
    status: { inventory: { stacks: [] }, nearby: { droppedItems: [{ name: 'blaze_rod', count: 20, distance: 4 }] } },
    groundItems: { blaze_rod: 0 },
  }).passed, true);
  assert.equal(evaluateLabChecks([{ kind: 'inventoryOrNearbyAtLeast', item: 'blaze_rod', count: 20 }], {
    status: { inventory: { stacks: [] }, nearby: { droppedItems: [{ name: 'blaze_rod', count: 20, distance: 4.1 }] } },
    groundItems: { blaze_rod: 0 },
  }).passed, false);
  assert.equal(evaluateLabChecks([], {}).passed, false);
});

test('nearby-item checks use the same bounded radius as the fixture evidence collector', () => {
  const check = { kind: 'inventoryOrNearbyAtLeast', item: 'blaze_rod', count: 20,
    center: { dimension: 'minecraft:the_nether', x: 117.5, y: 72.5, z: 681.5, radius: 6 } };
  assert.deepEqual(validateLabChecks([check]), [check]);
  assert.equal(evaluateLabChecks([check], {
    status: { inventory: { stacks: [] }, nearby: { droppedItems: [{ name: 'blaze_rod', count: 20, distance: 5.9 }] } },
  }).passed, true);
  assert.equal(evaluateLabChecks([check], {
    status: { inventory: { stacks: [] }, nearby: { droppedItems: [{ name: 'blaze_rod', count: 20, distance: 6.1 }] } },
  }).passed, false);
  assert.throws(() => validateLabChecks([{ ...check, center: { ...check.center, radius: 9 } }]), /unsupported/);
});

test('live lab evidence requests structured status and block results', async () => {
  const calls = [];
  const client = { async callTool(name, args) {
    calls.push({ name, args });
    return name === 'view_status'
      ? { isError: false, structuredContent: { response: { data: { result: {
        situation: { vitals: { health: 20 }, inventory: { stacks: [] } },
      } } } } }
      : { isError: false, structuredContent: { response: { data: { result: { blocks: { cells: [
        { x: 4, y: 5, z: 6, name: 'air' },
      ] } } } } } };
  } };
  const evidence = await readLabEvidence(client, [
    { kind: 'healthAtLeast', value: 1 }, { kind: 'blockAt', pos: { x: 4, y: 5, z: 6 }, name: 'air' },
  ], new AbortController().signal);
  assert.deepEqual(evidence, { status: { vitals: { health: 20 }, inventory: { stacks: [] } },
    blocks: [{ x: 4, y: 5, z: 6, name: 'air' }] });
  assert.deepEqual(calls.map(call => [call.name, call.args.response_format]), [['view_status', 'json'], ['view_blocks', 'json']]);
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
