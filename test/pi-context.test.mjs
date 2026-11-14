import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openai, play } from '../src/pi.mjs';
import { gameTools, gameArguments, statusContent, continueProductiveAction } from '../src/game-tools.mjs';

const overflow = 'Your input exceeds the context window of this model. Please adjust your input and try again.';
const checkpoint = 'Defeat the dragon. Acacia is at a Nether fortress. Retrieve the pending action before moving.';

test('construction and storage expose separate argument sets', () => {
  const definition = (name, fields, required) => ({
    name, inputSchema: { type: 'object', additionalProperties: false,
      properties: Object.fromEntries(fields.map(field => [field, {}])), required },
  });
  const tools = gameTools([
    definition('build_structure', ['blocks', 'portal_frame', 'rationale'], ['rationale']),
    definition('use_container', ['operation', 'items', 'item_order', 'x'], ['x']),
    definition('view_status', ['response_format'], []),
    definition('view_blocks', ['find', 'cells'], []),
    definition('collect_block', ['block_name', 'count', 'x', 'y', 'z', 'rationale'], ['block_name', 'rationale']),
  ]);
  const find = name => tools.find(tool => tool.name === name);
  assert.deepEqual(Object.keys(find('build_structure').inputSchema.properties), ['blocks', 'rationale']);
  assert.deepEqual(find('build_portal_frame').inputSchema.required, ['rationale', 'portal_frame']);
  assert.equal(find('build_portal_frame').target, 'build_structure');
  assert.equal(find('use_container').inputSchema.properties.item_order, undefined);
  assert.equal(find('organize_container').inputSchema.properties.items, undefined);
  assert.deepEqual(gameArguments(find('organize_container'), { x: 2, item_order: ['stone'] }),
    { x: 2, item_order: ['stone'], operation: 'organize' });
  assert.deepEqual(gameArguments(find('view_status'), { rationale: 'Check.' }),
    { rationale: 'Check.', response_format: 'json' });
  assert.deepEqual(gameArguments(find('view_status'), { detail: 'full', rationale: 'Count.' }),
    { rationale: 'Count.' });
  assert.deepEqual(gameArguments(find('view_blocks'), { find: { block_names: ['lava'] } }).find,
    { block_names: ['lava'], limit: 4 });
  assert.equal(gameArguments(find('view_blocks'), { find: { limit: 20 } }).find.limit, 20);
  assert.deepEqual(Object.keys(find('collect_block').inputSchema.properties), ['block_name', 'count', 'rationale']);
  assert.ok(find('collect_block').inputSchema.required.includes('count'));
  assert.deepEqual(find('collect_exact_block').inputSchema.required, ['block_name', 'rationale', 'x', 'y', 'z']);
  assert.equal(find('collect_exact_block').inputSchema.properties.count, undefined);
  assert.equal(find('collect_exact_block').target, 'collect_block');
});

test('compact status keeps actionable facts and foreground IDs', () => {
  const payload = {
    foreground: { active: null, awaitingResult: { actionId: 'carry-123', action: 'navigate' } },
    response: { format: 'json', data: { result: { status: 'succeeded', situation: {
      observedAt: '2026-11-14T01:00:00Z', dimension: 'the_nether', gameMode: 'survival',
      vitals: { health: 14, food: 19, saturation: 3, burning: false, airSupplyTicks: 300 },
      position: { x: -68.4, y: 66, z: 82.2, onGround: true, inWater: false, inLava: false },
      activity: { owner: 'idle', activeAction: null }, clock: { phase: null },
      mobility: { scaffold: { item: 'cobblestone', blocks: 42 } },
      inventory: { freeSlots: 3, stacks: [{ name: 'shield', count: 1, slot: 45, location: 'off-hand', durability: { remaining: 12, maximum: 336 } },
        { name: 'blaze_rod', count: 6, slot: 12, location: 'main', durability: null }] },
      nearby: { rangeBlocks: 16, hostiles: [{ name: 'blaze', distance: 4, position: { x: -66, y: 67, z: 83 }}],
        mobs: [{ name: 'remote_example' }], droppedItems: [] },
    } } } },
  };
  const [block] = statusContent(payload);
  assert.match(block.text, /the_nether.*-68\.4/s);
  assert.match(block.text, /14\/20/);
  assert.match(block.text, /shield.*12\/336/);
  assert.match(block.text, /blaze_rod.*6/);
  assert.match(block.text, /carry-123/);
  assert.match(block.text, /blaze.*-66/);
  assert.doesNotMatch(block.text, /remote_example/);
});

test('productive batches keep running across a wait, and danger goes back to the model', () => {
  const pending = { state: 'pending', actionId: 'mine-1', progress: { progress: { state: 'running' } },
    survival: { vitals: { health: 20 } }, vitalsDuringWait: { healthBefore: 20, healthAfter: 20 },
    duringWait: { checkpointDelta: { gained: 4 }, reflexActivity: [], toolChanges: [] } };
  assert.equal(continueProductiveAction(pending, 'collect_block', 8), true);
  assert.equal(continueProductiveAction(pending, 'collect_block', 1), false);
  assert.equal(continueProductiveAction(pending, 'navigate', 8), false);
  assert.equal(continueProductiveAction({ ...pending, vitalsDuringWait: { healthBefore: 20, healthAfter: 19 } }, 'collect_block', 8), false);
  assert.equal(continueProductiveAction({ ...pending, duringWait: { ...pending.duringWait, checkpointDelta: { gained: 0 } } },
    'collect_block', 8), false);
  assert.equal(continueProductiveAction({ ...pending, progress: { progress: { state: 'suspended' } } }, 'collect_mob_drop', 8), false);
  assert.equal(continueProductiveAction({ ...pending, duringWait: { ...pending.duringWait, reflexActivity: [{ kind: 'response' }] } },
    'collect_mob_drop', 8), false);
});

for (const reason of ['threshold', 'overflow', 'productive wait']) {
  const batch = reason === 'productive wait';
  test(batch ? 'Pi waits through a productive collection and hands back the final receipt'
    : `Pi continues a pending Minecraft action after ${reason} compaction`, { timeout: 10_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'mine-pi-'));
    const socket = join(directory, 'mcp.sock');
    const calls = [];
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST') return response.writeHead(405).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { id, method, params } = JSON.parse(Buffer.concat(chunks));
      if (id === undefined) return response.writeHead(202).end();
      let result;
      if (method === 'initialize') result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (method === 'tools/list') result = { tools: [batch ? 'collect_block' : 'navigate', 'wait_for_action',
        ...Array.from({ length: 35 }, (_, i) => `fixture_${i}`)].map(name => ({ name, inputSchema: { type: 'object' } })) };
      if (method === 'tools/call') {
        calls.push(params.name);
        const reports = {
          fixture_0: 'Earlier exploration notes. '.repeat(4000),
          navigate: 'Action ID: 1234-abcd\nThe navigation is pending.',
          wait_for_action: 'Navigation completed.',
        };
        result = { content: [{ type: 'text', text: reports[params.name] }] };
        if (batch) {
          const { response_format: format } = params.arguments;
          assert.equal(format, calls.length < 3 ? 'json' : 'markdown');
          const pending = { state: 'pending', actionId: '1234-abcd', progress: { progress: { state: 'running' } },
            vitalsDuringWait: { healthBefore: 20, healthAfter: 20 },
            duringWait: { toolChanges: [], reflexActivity: [], checkpointDelta: { gained: 4 } } };
          const settled = { state: 'settled', actionId: '1234-abcd', output: { action: 'collect_block' } };
          const markdown = 'Action ID: 1234-abcd\n\n## `collect_block`\nInventory gained: 8';
          const data = calls.length === 1 ? pending : settled;
          result = format === 'json' ? { content: [], structuredContent: { response: { format, data } } } :
            { content: [{ type: 'text', text: markdown }], structuredContent: { response: { format, markdown } } };
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    }).listen(socket);
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    });
    await once(server, 'listening');
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ openai: {
      type: 'oauth', access: 'fixture', refresh: 'fixture', expires: Date.now() + 3_600_000,
    } }));
    const signal = new AbortController();
    let gameTurns = 0;
    const inference = async agentDir => {
      const { model, runtime } = await openai(agentDir);
      const stream = runtime.streamSimple.bind(runtime);
      const prepareRequest = runtime.prepareRequest.bind(runtime);
      runtime.prepareRequest = async (target, options) => {
        const prepared = await prepareRequest(target, options);
        return { ...prepared, provider: { ...prepared.provider, streamSimple: (_model, context) => {
          assert.match(JSON.stringify(context.messages), /<conversation>|# Conversation/);
          return scriptedReply(context);
        } } };
      };
      runtime.streamSimple = (target, context, options) => {
        if (JSON.stringify(context.messages).match(/<conversation>|# Conversation/)) {
          return stream(target, context, options);
        }
        return scriptedReply(context);
      };
      function scriptedReply(context) {
        const tool = (name, args = {}) => ({ type: 'toolCall', id: `call_${gameTurns}`, name: `mcp__minecraft__${name}`, arguments: args });
        const reply = (content, stopReason = 'stop', { input = 0, cacheRead = 0, errorMessage } = {}) => {
          const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
            stopReason, errorMessage, timestamp: Date.now(), usage: { input, output: 0, cacheRead, cacheWrite: 0,
              totalTokens: input + cacheRead, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
          return {
            async *[Symbol.asyncIterator]() { yield stopReason === 'error'
              ? { type: 'error', reason: 'error', error: message } : { type: 'done', reason: stopReason, message }; },
            async result() { return message; },
          };
        };
        const transcript = JSON.stringify(context.messages);
        if (batch) {
          assert.equal(++gameTurns, 1);
          return reply([tool('collect_block', { count: 8, wait_timeout_ms: 2000 })], 'toolUse');
        }
        if (transcript.includes('<conversation>') || transcript.includes('# Conversation\\n')) {
          return reply([{ type: 'text', text: checkpoint }]);
        }
        if (++gameTurns === 1) return reply([tool('fixture_0')], 'toolUse', { input: 100 });
        if (gameTurns === 2) return reply([tool('navigate')], 'toolUse', { input: 100, cacheRead: reason === 'threshold' ? 630_000 : 0 });
        if (!transcript.includes(checkpoint)) return reply([], 'error', { errorMessage: overflow });
        assert.match(context.messages.findLast(message => message.role === 'toolResult').content[0].text, /1234-abcd/);
        return reply([tool('wait_for_action', { action_id: '1234-abcd' })], 'toolUse');
      }
      return { model, runtime };
    };
    const events = [];
    await assert.rejects(play({ directory, socket, agentDir: directory, signal: signal.signal, inference,
      actionWaitMs: batch ? 500 : undefined,
      promptText: 'Defeat the dragon.',
      record(type, payload) {
        events.push({ type, ...payload });
        if (type === 'tool_execution_end' && payload.tool.endsWith(batch ? '__collect_block' : '__wait_for_action')) {
          signal.abort(new Error('fixture complete'));
        }
      },
    }), /fixture complete/);
    const transcript = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
    const entries = (await readFile(join(directory, transcript), 'utf8')).trimEnd().split('\n').map(JSON.parse);
    if (batch) {
      assert.deepEqual(calls, ['collect_block', 'wait_for_action', 'wait_for_action']);
      assert.equal(events.find(event => event.type === 'tool_execution_end')?.outcome, 'settled');
      assert.ok(entries.some(entry => entry.message?.content?.[0]?.text?.includes('Inventory gained: 8')));
      return;
    }
    assert.deepEqual(calls, ['fixture_0', 'navigate', 'wait_for_action']);
    assert.equal(events.find(event => event.type === 'compaction_end')?.reason, reason);
    assert.ok(entries.some(entry => entry.type === 'compaction' && entry.summary.includes(checkpoint)));
    assert.ok(entries.some(entry => entry.message?.toolName === 'mcp__minecraft__navigate'));
  });
}
