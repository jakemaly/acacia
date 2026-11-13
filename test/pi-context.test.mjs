import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openai, play } from '../src/pi.mjs';

const overflow = 'Your input exceeds the context window of this model. Please adjust your input and try again.';
const checkpoint = 'Defeat the dragon. Acacia is at a Nether fortress. Retrieve the pending action before moving.';

for (const reason of ['threshold', 'overflow']) {
  test(`Pi continues a pending Minecraft action after ${reason} compaction`, { timeout: 10_000 }, async t => {
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
      if (method === 'tools/list') result = { tools: ['navigate', 'wait_for_action',
        ...Array.from({ length: 35 }, (_, i) => `fixture_${i}`)].map(name => ({ name, inputSchema: { type: 'object' } })) };
      if (method === 'tools/call') {
        calls.push(params.name);
        const reports = {
          fixture_0: 'Earlier exploration notes. '.repeat(4000),
          navigate: 'Action ID: 1234-abcd\nThe navigation is pending.',
          wait_for_action: 'Navigation completed.',
        };
        result = { content: [{ type: 'text', text: reports[params.name] }] };
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
      runtime.streamSimple = (_model, context) => {
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
        if (transcript.includes('<conversation>') || transcript.includes('# Conversation\\n')) {
          return reply([{ type: 'text', text: checkpoint }]);
        }
        if (++gameTurns === 1) return reply([tool('fixture_0')], 'toolUse', { input: 100 });
        if (gameTurns === 2) return reply([tool('navigate')], 'toolUse', { input: 100, cacheRead: reason === 'threshold' ? 630_000 : 0 });
        if (!transcript.includes(checkpoint)) return reply([], 'error', { errorMessage: overflow });
        assert.match(context.messages.findLast(message => message.role === 'toolResult').content[0].text, /1234-abcd/);
        return reply([tool('wait_for_action', { action_id: '1234-abcd' })], 'toolUse');
      };
      return { model, runtime };
    };
    const events = [];
    await assert.rejects(play({ directory, socket, agentDir: directory, signal: signal.signal, inference,
      promptText: 'Defeat the dragon.',
      record(type, payload) {
        events.push({ type, ...payload });
        if (type === 'tool_execution_end' && payload.tool.endsWith('__wait_for_action')) signal.abort(new Error('fixture complete'));
      },
    }), /fixture complete/);
    assert.deepEqual(calls, ['fixture_0', 'navigate', 'wait_for_action']);
    assert.equal(events.find(event => event.type === 'compaction_end')?.reason, reason);
    const transcript = (await readdir(directory)).find(name => name.endsWith('.jsonl'));
    const entries = (await readFile(join(directory, transcript), 'utf8')).trimEnd().split('\n').map(JSON.parse);
    assert.ok(entries.some(entry => entry.type === 'compaction' && entry.summary.includes(checkpoint)));
    assert.ok(entries.some(entry => entry.message?.toolName === 'mcp__minecraft__navigate'));
  });
}
