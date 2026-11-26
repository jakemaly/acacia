import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseRange } from './recordings.mjs';
import { modalControl } from './modal-client.mjs';

export function modalArtifactStream(request, { python = 'python3', script = fileURLToPath(new URL('../deploy/modal_control.py', import.meta.url)) } = {}) {
  const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 600_000 });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  child.stdin.end(JSON.stringify(request));
  return child;
}

export async function serveModalRecording(identity, req, res, { stat = request => modalControl(request), stream = modalArtifactStream } = {}) {
  const { runKey, runId, segment } = identity;
  if (!/^[a-f0-9]{24,64}$/.test(runKey ?? '') || !/^[a-f0-9]{12}$/.test(runId ?? '') ||
      (segment !== undefined && !/^[a-f0-9]{12}$/.test(segment))) {
    return res.writeHead(400).end();
  }
  let info;
  try { info = await stat({ command: 'recording-stat', runKey, runId, ...(segment && { segment }) }); }
  catch { return res.writeHead(502, { 'cache-control': 'no-store' }).end('Recording unavailable.'); }
  if (!Number.isSafeInteger(info.size) || info.size <= 0) return res.writeHead(404).end();
  const range = req.method === 'HEAD' ? undefined : parseRange(req.headers.range, info.size);
  if (range === null) return res.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${info.size}` }).end();
  const start = range?.start ?? 0, end = range?.end ?? info.size - 1;
  const headers = { 'accept-ranges': 'bytes', 'cache-control': 'private, no-store', 'content-length': end - start + 1,
    'content-type': 'video/webm', 'x-content-type-options': 'nosniff' };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const child = stream({ command: 'recording-stream', runKey, runId, start, end, ...(segment && { segment }) });
  child.once?.('error', () => res.destroy());
  child.once?.('close', code => { if (code && !res.writableFinished) res.destroy(); });
  child.stdout.on('error', () => res.destroy());
  res.once('close', () => { if (!res.writableFinished) child.kill(); });
  child.stdout.pipe(res);
}

export function streamModalArtifact(identity, kind, res, { stream = modalArtifactStream } = {}) {
  const { runKey, runId } = identity;
  if (!/^[a-f0-9]{24,64}$/.test(runKey ?? '') || !/^[a-f0-9]{12}$/.test(runId ?? '') ||
      !['world', 'server-log', 'bot-log'].includes(kind)) return res.writeHead(400).end();
  const extension = kind === 'world' ? 'tar' : 'log';
  res.writeHead(200, { 'content-type': kind === 'world' ? 'application/x-tar' : 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${runId}-${kind}.${extension}"`, 'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff' });
  const child = stream({ command: 'artifact-stream', runKey, runId, kind });
  child.once?.('error', () => res.destroy());
  child.once?.('close', code => { if (code && !res.writableFinished) res.destroy(); });
  child.stdout.on('error', () => res.destroy());
  res.once('close', () => { if (!res.writableFinished) child.kill(); });
  child.stdout.pipe(res);
}

export async function restoreModalSession(identity, directory, { list = request => modalControl(request), stream = modalArtifactStream } = {}) {
  const { runKey, runId } = identity;
  if (!/^[a-f0-9]{24,64}$/.test(runKey ?? '') || !/^[a-f0-9]{12}$/.test(runId ?? '')) throw new Error('Invalid run identity.');
  const result = await list({ command: 'session-list', runKey, runId });
  const name = result.sessions?.[0];
  if (!name) return undefined;
  if (!/^\d{4}-\d\d-\d\dT[\d-Z]+_[a-f0-9-]+\.jsonl$/i.test(name)) throw new Error('Invalid session name.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.session-${randomUUID()}.tmp`);
  const destination = join(directory, name);
  const child = stream({ command: 'session-stream', runKey, runId, name });
  const completion = child.completion ?? new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Could not retrieve the Pi session.')));
  });
  try {
    await Promise.all([pipeline(child.stdout, createWriteStream(temporary, { flags: 'wx', mode: 0o600 })), completion]);
    try { await link(temporary, destination); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return destination;
  } finally { await rm(temporary, { force: true }); }
}
