import { createServer, request as httpRequest } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { connect } from 'node:net';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startRun as defaultStartRun } from './run.mjs';
import { reflectionEvidence } from './primitives.mjs';

export async function createRemoteWorker({ host = '127.0.0.1', port = 8080, root, heartbeatMs = 120_000,
  startRun = defaultStartRun, onAbandon = () => {}, commit = () => promisify(execFile)('sync', [root], { timeout: 60_000 }) }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  let run, context, resolvePlay, stopping, closed = false, viewerPrefix;
  let heartbeat = Date.now();
  const status = () => run ? { id: run.id, seed: run.seed, hardcore: run.hardcore, state: run.state,
    detail: run.detail, player: run.player, death: run.death, activity: run.activity,
    recordingSegment: run.recordingSegment } : { state: 'idle' };

  const remotePlay = ({ socket, promptText, signal }) => {
    context = { socket, promptText };
    return new Promise(resolve => {
      const finish = detail => { signal.removeEventListener('abort', aborted); resolve(detail); };
      const aborted = () => finish('Worker run stopped.');
      resolvePlay = finish;
      if (signal.aborted) aborted();
      else signal.addEventListener('abort', aborted, { once: true });
    });
  };
  async function stop() {
    if (!run) return;
    stopping ??= Promise.resolve().then(() => run.stop()).then(() => commit());
    try { await stopping; } catch (error) { stopping = undefined; throw error; }
  }
  const server = createServer(async (req, res) => {
    const json = (code, value) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/mcp' || (viewerPrefix && url.pathname.startsWith(`${viewerPrefix}/`))) {
        const target = url.pathname === '/mcp' ? context?.socket : run && join(root, run.id, 'viewer.sock');
        if (!target || !context) return json(503, { error: 'Minecraft tools are not ready.' });
        const headers = { ...req.headers };
        delete headers.authorization;
        delete headers.cookie;
        headers.host = url.pathname === '/mcp' ? '127.0.0.1:25575' : '127.0.0.1:3000';
        const upstream = httpRequest({ socketPath: target, path: req.url, method: req.method, headers }, response => {
          res.writeHead(response.statusCode, response.headers);
          response.pipe(res);
        });
        upstream.on('error', () => { if (!res.headersSent) json(502, { error: 'Minecraft tool connection failed.' }); else res.destroy(); });
        req.pipe(upstream);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/status') return json(200, status());
      if (req.method === 'GET' && url.pathname === '/manifest') {
        if (!run?.id) return json(404, { error: 'Run not started.' });
        try { return json(200, JSON.parse(await readFile(join(root, run.id, 'run.json'), 'utf8'))); }
        catch (error) { if (error.code === 'ENOENT') return json(503, { error: 'Manifest not ready.' }); throw error; }
      }
      if (req.method === 'GET' && url.pathname === '/context') {
        if (!context) return json(503, { error: 'Minecraft tools are not ready.' });
        return json(200, { prompt: context.promptText });
      }
      if (req.method === 'GET' && url.pathname === '/reflection-evidence') {
        if (!run?.id || run.state !== 'dead') return json(409, { error: 'Death evidence is not ready.' });
        return json(200, { evidence: await reflectionEvidence(join(root, run.id), run.death) });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/archive/')) {
        const name = url.pathname.slice('/archive/'.length);
        if (!/^(?:activity\.jsonl|result\.json|reflection\.json|reflection-evidence\.json|\d{4}-\d\d-\d\dT[\d-Z]+_[a-f0-9-]+\.jsonl)$/i.test(name)) {
          return json(400, { error: 'Invalid artifact name.' });
        }
        if (!run?.id) return json(409, { error: 'Run not started.' });
        const directory = join(root, run.id, 'controller');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.upload-${randomUUID()}`);
        let size = 0;
        const limit = new Transform({ transform(chunk, _encoding, done) {
          size += chunk.length;
          done(size > 512 * 1024 * 1024 ? new Error('Artifact exceeds size limit.') : null, chunk);
        } });
        try {
          await pipeline(req, limit, createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
          await rename(temporary, join(directory, name));
        } finally { await rm(temporary, { force: true }); }
        return json(200, { size });
      }
      if (req.method === 'POST' && url.pathname === '/sync') { await commit(); return json(200, { synced: true }); }
      if (req.method === 'POST' && url.pathname === '/heartbeat') { heartbeat = Date.now(); return json(200, status()); }
      if (req.method === 'POST' && url.pathname === '/stop') { await stop(); return json(200, status()); }
      if (req.method === 'POST' && url.pathname === '/finish') {
        resolvePlay?.('Local Pi finished.');
        return json(202, status());
      }
      if (req.method === 'POST' && url.pathname === '/start') {
        if (run) return json(409, { error: 'This worker already owns a run.' });
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096) return json(413, { error: 'Request too large.' });
          chunks.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (input.hardcore !== undefined && typeof input.hardcore !== 'boolean') return json(400, { error: 'Invalid mode.' });
        if (input.id !== undefined && !/^[a-f0-9]{12}$/.test(input.id)) return json(400, { error: 'Invalid run ID.' });
        if (input.resume !== undefined && typeof input.resume !== 'boolean') return json(400, { error: 'Invalid resume setting.' });
        if (input.resume && !input.id) return json(400, { error: 'A run ID is required to resume.' });
        if (input.parent !== undefined && !/^[a-f0-9]{12}$/.test(input.parent)) return json(400, { error: 'Invalid parent run ID.' });
        viewerPrefix = input.id ? `/api/modal/viewer/${input.id}` : undefined;
        heartbeat = Date.now();
        run = startRun({ root, host: '127.0.0.1', viewerPort: 3000, gamePort: 25565,
          allowed: new Set(['127.0.0.1']), agentDir: root, id: input.id, resume: input.resume === true,
          hardcore: input.hardcore === true, parent: input.parent, viewerPrefix, play: remotePlay });
        run.done.catch(error => { run.state = 'incomplete'; run.detail = error.message; });
        return json(202, status());
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof SyntaxError) return json(400, { error: 'Invalid request.' });
      console.error('Worker request failed:', error.message);
      if (!res.headersSent) return json(500, { error: 'Worker request failed.' });
      res.destroy();
    }
  });
  server.on('upgrade', (req, client, head) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (!run || !context || !viewerPrefix || !path.startsWith(`${viewerPrefix}/`)) return client.destroy();
    const upstream = connect(join(root, run.id, 'viewer.sock'));
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.once('connect', () => {
      const headers = [];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (['authorization', 'cookie'].includes(req.rawHeaders[index].toLowerCase())) continue;
        headers.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
      }
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
  const timer = heartbeatMs > 0 ? setInterval(() => {
    if (closed || Date.now() - heartbeat < heartbeatMs) return;
    clearInterval(timer);
    void stop().catch(error => console.error('Worker failed to stop after heartbeat loss:', error.message)).finally(() => onAbandon());
  }, Math.min(heartbeatMs, 5000)) : undefined;
  timer?.unref();
  return { port: server.address().port, async close() {
    closed = true;
    clearInterval(timer);
    await stop();
    server.closeAllConnections();
    await Promise.race([new Promise(resolve => server.close(resolve)), delay(5000, undefined, { ref: false })]);
  } };
}

if (import.meta.main) {
  const worker = await createRemoteWorker({ host: '0.0.0.0', root: process.env.ACACIA_WORKER_ROOT ?? '/runs',
    onAbandon: () => { process.exitCode = 1; void worker.close(); } });
  console.log(`Acacia worker listening on ${worker.port}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void worker.close(); });
}
