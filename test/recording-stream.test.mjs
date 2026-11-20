import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRecording } from '../src/recordings.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'acacia-recording-'));
  const run = join(root, 'abcdef123456');
  const directory = join(run, 'recording');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'recording.webm'), '0123456789');
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    void serveRecording(root, url.searchParams.get('id'), request, response);
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/recording?id=abcdef123456`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, url };
}

test('streams WebM recordings and supports byte ranges for browser playback', async t => {
  const { url } = await fixture(t);
  const whole = await fetch(url);
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('content-type'), 'video/webm');
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal(await whole.text(), '0123456789');

  const range = await fetch(url, { headers: { range: 'bytes=2-5' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await range.text(), '2345');
});

test('supports HEAD and rejects invalid ranges without streaming a body', async t => {
  const { url } = await fixture(t);
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal(await head.text(), '');

  const range = await fetch(url, { headers: { range: 'bytes=30-40' } });
  assert.equal(range.status, 416);
  assert.equal(range.headers.get('content-range'), 'bytes */10');
});

test('validates run IDs and refuses symlinked recording files', async t => {
  const { root, directory, url } = await fixture(t);
  const invalid = await fetch(url.replace('abcdef123456', '../outside'));
  assert.equal(invalid.status, 400);

  await rm(join(directory, 'recording.webm'));
  await symlink('/etc/passwd', join(directory, 'recording.webm'));
  const symlinked = await fetch(url);
  assert.equal(symlinked.status, 404);

  const missing = await fetch(`http://127.0.0.1:${new URL(url).port}/api/recording?id=123456abcdef`);
  assert.equal(missing.status, 404);
  await rm(root, { recursive: true, force: true });
});
