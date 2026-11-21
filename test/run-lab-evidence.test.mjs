import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createLabEvidenceCollector } from '../src/run.mjs';

test('each nearby-item evidence poll waits for its own server marker', async () => {
  const serverOutput = [];
  const commands = [];
  const write = command => {
    commands.push(command);
    if (command.includes('/scoreboard players get #total acacialab')) {
      setTimeout(() => serverOutput.push('#total has 20 [acacialab]'), 5).unref();
    }
    for (const line of command.split('\n')) {
      if (!line.startsWith('/say LAB_ITEMS_') || !line.endsWith('_END')) continue;
      setTimeout(() => serverOutput.push(line.slice('/say '.length)), 20).unref();
    }
  };
  const waitFor = async check => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (check()) return;
      await delay(1);
    }
    throw new Error('Evidence marker timed out.');
  };
  const collect = createLabEvidenceCollector({ id: 'abc123', serverOutput, write, waitFor, serverExit: Promise.resolve() });
  const check = [{ kind: 'inventoryOrNearbyAtLeast', item: 'blaze_rod', count: 20,
    center: { dimension: 'minecraft:the_nether', x: 117.5, y: 72.5, z: 681.5, radius: 6 } }];

  assert.deepEqual(await collect(check), { groundItems: { blaze_rod: 20 } });
  assert.deepEqual(await collect(check), { groundItems: { blaze_rod: 20 } });

  const markers = commands.flatMap(command => command.split('\n'))
    .filter(line => line.startsWith('/say LAB_ITEMS_') && line.endsWith('_END'));
  assert.equal(markers.length, 2);
  assert.notEqual(markers[0], markers[1]);
  assert.ok(commands.some(command => command.includes(
    '/execute in minecraft:the_nether positioned 117.5 72.5 681.5 as @e[type=minecraft:item,nbt={Item:{id:"minecraft:blaze_rod"}},distance=..6]')));
});
