import assert from 'node:assert/strict';
import { test } from 'node:test';
import { filterStatusPlayers } from '../src/status-privacy.mjs';
import { gameTools } from '../src/game-tools.mjs';
import { freshPrivateSession, initialAgentPrompt } from '../src/pi.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('resuming a world starts a fresh model context without replaying old messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acacia-private-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const oldSession = freshPrivateSession(dir);
  oldSession.appendMessage({ role: 'user', content: [{ type: 'text', text: 'aycelol private chat' }], timestamp: Date.now() });
  const resumed = freshPrivateSession(dir);
  assert.notEqual(resumed.getSessionFile(), oldSession.getSessionFile());
  assert.doesNotMatch(JSON.stringify(resumed.getEntries()), /aycelol|private chat/);
  assert.match(initialAgentPrompt('Beat the dragon.', 'old-session.jsonl'), /Beat the dragon.*world has resumed/is);
});

test('the agent cannot use debug JavaScript to read the player table', () => {
  const tools = gameTools([
    { name: 'debug_execute_javascript', inputSchema: { properties: {} } },
    { name: 'view_status', inputSchema: { properties: {} } },
  ]);
  assert.deepEqual(tools.map(tool => tool.name), ['view_status']);
});

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

test('legacy sleep results omit the multiline player list in markdown and JSON', () => {
  const text = 'Slept.\n- Other players online:\n  - aycelol: awake\n  - AnotherPlayer: sleeping\n- Bed: 1, 64, 2';
  const raw = { content: [{ type: 'text', text }], structuredContent: {
    response: { format: 'json', data: { output: { result: { sleep: {
      otherPlayers: [{ username: 'aycelol', sleepState: 'awake' }], morning: true,
    } } } } },
  } };
  const filtered = filterStatusPlayers(raw);
  assert.doesNotMatch(JSON.stringify(filtered), /aycelol|AnotherPlayer/);
  assert.match(filtered.content[0].text, /Bed: 1, 64, 2/);
  assert.equal(filtered.structuredContent.response.data.output.result.sleep.morning, true);
});

test('legacy hunt results do not reveal another collector', () => {
  const result = filterStatusPlayers({ structuredContent: { drops: [{ item: 'string', collectedByBot: false, collectedByOther: true }] } });
  assert.deepEqual(result.structuredContent.drops, [{ item: 'string', collectedByBot: false }]);
});

test('status without a player list is left intact', () => {
  const raw = { content: [{ type: 'text', text: 'overworld (survival)\nHostiles: creeper nearby' }] };
  assert.deepEqual(filterStatusPlayers(raw), raw);
});
