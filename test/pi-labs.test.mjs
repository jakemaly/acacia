import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { play } from '../src/pi.mjs';

test('a tool fixture stops its pending action when live evidence verifies success', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mine-pi-lab-'));
  const socket = join(directory, 'mcp.sock');
  let healthReads = 0;
  let actionStarted = false;
  let activated = false;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') return response.writeHead(405).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks));
    if (id === undefined) return response.writeHead(202).end();
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'lab-test', version: '1' } };
    } else if (method === 'tools/list') {
      result = { tools: ['view_status', 'wait_for_action', 'cancel_foreground_action', 'test_action'].map(name => ({
        name, description: 'Fixture tool.', inputSchema: name === 'test_action'
          ? { type: 'object', properties: { submission_id: { type: 'string' }, wait_timeout_ms: { type: 'integer' },
            execution_timeout_ms: { type: 'integer' }, response_format: { type: 'string' } }, required: ['submission_id'] }
          : { type: 'object', properties: {}, required: [] },
      })) };
    } else if (method === 'tools/call' && params.name === 'view_status') {
      healthReads++;
      const health = healthReads === 1 ? 10 : 20;
      result = { content: [], structuredContent: { response: { data: { result: { status: 'succeeded', situation: {
        vitals: { health, food: 20 }, inventory: { stacks: [] },
      } } } } } };
    } else if (method === 'tools/call' && params.name === 'test_action') {
      actionStarted = true;
      result = { content: [], structuredContent: { response: { format: 'json', data: { state: 'accepted', actionId: 'test-action' } } } };
    } else if (method === 'tools/call' && params.name === 'wait_for_action') {
      const timer = setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'pending' }],
            structuredContent: { response: { format: 'json', data: { state: 'pending', actionId: 'test-action' } } } } }));
        }
      }, 20_000);
      timer.unref();
      request.on('close', () => clearTimeout(timer));
      return;
    } else {
      throw new Error(`Unexpected MCP request: ${method} ${params.name ?? ''}`);
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

  const controller = new AbortController();
  const outcomes = [];
  const startedAt = Date.now();
  await play({
    directory, socket, agentDir: directory, signal: controller.signal, promptText: '',
    inference: async () => { throw new Error('Tool fixtures must not start model inference.'); },
    lab: { controller: { type: 'tool', name: 'test_action', arguments: {} }, checks: [{ kind: 'healthAtLeast', value: 15 }] },
    async onLabControllerStart() {
      assert.equal(actionStarted, true, 'the MCP action is dispatched before fixture activation');
      activated = true;
    },
    onLabOutcome(outcome) {
      outcomes.push(outcome);
      controller.abort();
    },
    record() {},
  }).catch(() => {});

  assert.equal(activated, true);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].passed, true);
  assert.ok(healthReads >= 2, 'the verifier observes changed world state while the tool is pending');
  assert.ok(Date.now() - startedAt < 8_000, 'the pending tool stops after verified state instead of its 20 second completion');
});
