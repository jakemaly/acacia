import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterStatusPlayers } from '../src/status-privacy.mjs';

test('full markdown status omits player presence but keeps gameplay status', () => {
  const raw = {
    content: [{ type: 'text', text: '### Nearby (within 16 blocks)\n- Players: aycelol (online, not loaded nearby)\n- Hostiles: none' }],
    structuredContent: { response: { format: 'markdown', markdown: '- Players: aycelol (online, not loaded nearby)\n- Hostiles: none' } },
  };

  const filtered = filterStatusPlayers(raw);
  assert.doesNotMatch(JSON.stringify(filtered), /aycelol|not loaded nearby/);
  assert.match(filtered.content[0].text, /Hostiles: none/);
});

test('JSON status omits the player list and its position', () => {
  const nearby = {
    players: [{ username: 'aycelol', position: { x: -46.5, y: 72, z: -1.5 } }],
    hostiles: [],
  };
  const raw = {
    content: [{ type: 'text', text: JSON.stringify({ nearby }) }],
    structuredContent: { response: { data: { result: { situation: { nearby } } } } },
  };

  const filtered = filterStatusPlayers(raw);
  assert.doesNotMatch(JSON.stringify(filtered), /aycelol|-46\.5|"y":72/);
  assert.match(JSON.stringify(filtered), /hostiles/);
});

test('status without a player list is left intact', () => {
  const raw = { content: [{ type: 'text', text: 'overworld (survival)\nHostiles: creeper nearby' }] };
  assert.deepEqual(filterStatusPlayers(raw), raw);
});
