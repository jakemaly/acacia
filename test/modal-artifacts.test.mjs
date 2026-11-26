import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { restoreModalSession, serveModalRecording } from '../src/modal-artifacts.mjs';

test('Modal recordings stream byte ranges without downloading the whole file locally', async t => {
  const bytes = Buffer.from('0123456789');
  const calls = [];
  const server = createServer((req, res) => void serveModalRecording({ runKey: 'a'.repeat(32), runId: 'b'.repeat(12) }, req, res, {
    stat: async () => ({ size: bytes.length }),
    stream: request => { calls.push(request); return { stdout: Readable.from(bytes.subarray(request.start, request.end + 1)), kill() {} }; },
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/recording`;
  const response = await fetch(url, { headers: { range: 'bytes=3-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(await response.text(), '3456');
  assert.equal(calls[0].start, 3);
  assert.equal(calls[0].end, 6);
  assert.equal((await fetch(url, { headers: { range: 'bytes=20-30' } })).status, 416);
  assert.equal((await fetch(url, { method: 'HEAD' })).headers.get('content-length'), '10');
});

test('an archived Pi session can be restored without accepting arbitrary paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-session-restore-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = '2026-11-25T21-01-24-737Z_01a21483-6380-7089-8f32-2f6b11d2a5ec.jsonl';
  const identity = { runKey: 'a'.repeat(32), runId: 'b'.repeat(12) };
  const path = await restoreModalSession(identity, root, {
    list: async () => ({ sessions: [name] }),
    stream: () => ({ stdout: Readable.from('{"type":"session"}\n'), completion: Promise.resolve() }),
  });
  assert.equal(await readFile(path, 'utf8'), '{"type":"session"}\n');
  await assert.rejects(restoreModalSession(identity, root, { list: async () => ({ sessions: ['../auth.json'] }) }), /Invalid session/);
});
