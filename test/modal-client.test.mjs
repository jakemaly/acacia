import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { uploadWorkerFile, workerRequest } from '../src/modal-client.mjs';

test('worker requests carry the connection token only to the configured worker', async t => {
  let received;
  const server = createServer((request, response) => {
    received = request.headers.authorization;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{"state":"running"}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const worker = { url: `http://127.0.0.1:${server.address().port}`, token: 'connect-token' };
  assert.deepEqual(await workerRequest(worker, '/status'), { state: 'running' });
  assert.equal(received, 'Bearer connect-token');
  await assert.rejects(workerRequest(worker, 'https://example.invalid/status'), /relative worker path/);
  await assert.rejects(workerRequest({ url: 'http://example.invalid', token: 'secret' }, '/status'), /HTTPS/);
});

test('artifact upload sends only complete JSONL lines and rejects credential filenames', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-upload-'));
  const path = join(root, 'activity.jsonl');
  await writeFile(path, '{"ok":1}\n{"partial":');
  let received = '';
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer token');
    for await (const chunk of request) received += chunk;
    response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const worker = { url: `http://127.0.0.1:${server.address().port}`, token: 'token' };
  await uploadWorkerFile(worker, path, 'activity.jsonl');
  assert.equal(received, '{"ok":1}\n');
  await assert.rejects(uploadWorkerFile(worker, path, 'auth.json'), /Invalid artifact/);
});
