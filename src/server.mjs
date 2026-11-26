import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dragonAdvancement, mineImage, recoverRuns, startRun } from './run.mjs';
import { conversation, runId, savedRuns } from './history.mjs';
import { recoverInterruptedRecordings, serveRecording } from './recordings.mjs';
import { modelId, thinkingLevel } from './pi.mjs';
import { recoverCheckpoints } from './checkpoints.mjs';
import { labCheckpoints, labFixtures, resolveLabCheckpoint, validateLabChecks } from './labs.mjs';
import { deathReview, readReflection, recordedDeath, reflectDeath, writeReflection } from './primitives.mjs';
import { createModalBatchService } from './modal-batch-service.mjs';
import { modalArtifactStream, serveModalRecording, streamModalArtifact } from './modal-artifacts.mjs';

export async function dashboard({ host, port, root, agentDir, viewerPort, gamePort, allowed, jar, inference,
  candidateImage, hardcore = false, reflect = reflectDeath, modalService: suppliedModalService }) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const config = { host, root: await realpath(root), agentDir, viewerPort, gamePort, allowed, jar, inference, candidateImage };
  const assets = new Map(await Promise.all([
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/dashboard.mjs', 'dashboard.mjs', 'text/javascript; charset=utf-8'],
    ['/assets/dark-theme-enabled.svg', 'assets/dark-theme-enabled.svg', 'image/svg+xml'],
  ].map(async ([route, file, type]) => [route, { body: await readFile(new URL(`../web/${file}`, import.meta.url)), type }])));
  let run;
  let collection;
  let review;
  let closing = false;
  let modalService = suppliedModalService, modalPromise;
  const repo = fileURLToPath(new URL('..', import.meta.url));
  async function getModalService() {
    if (modalService) return modalService;
    modalPromise ??= createModalBatchService({ root: config.root, repo, agentDir: config.agentDir });
    try { modalService = await modalPromise; return modalService; } catch (error) { modalPromise = undefined; throw error; }
  }
  const modalStatus = item => ({ defaultMode: 'hardcore', id: item.id, seed: item.seed, state: item.state,
    detail: item.detail, hardcore: item.hardcore, parent: item.parent, death: item.death, activity: item.activity ?? [],
    player: item.player, decision: item.decision, model: modelId, thinkingLevel,
    viewer: item.state === 'running' ? item.viewer : null, spectator: null });
  const defaultMode = hardcore ? 'hardcore' : 'survival';
  const status = () => run ? {
    defaultMode,
    id: run.id, seed: run.seed, state: run.state, detail: run.detail, hardcore: run.hardcore, profile: run.profile, parent: run.parent, death: run.death,
    lab: run.lab, labOutcome: run.labOutcome, labStopReason: run.labStopReason, activity: run.activity ?? [], player: run.player,
    model: modelId, thinkingLevel, collectionSession: run.collectionSession, checkpoints: run.checkpointStatus?.(),
    decision: run.state === 'running' ? run.decision : undefined,
    viewer: run.state === 'running' ? run.viewer : null,
    spectator: run.state === 'running' ? run.spectator : null,
  } : { defaultMode, state: 'idle', activity: [], model: modelId, thinkingLevel };
  const active = () => Boolean(review) || ['starting', 'running', 'saving'].includes(run?.state);

  function begin({ hardcore, parent, collect = false, lab }) {
    if (!parent && !lab) collection = collect ? { id: randomUUID().replaceAll('-', '').slice(0, 12) } : undefined;
    const started = startRun({ ...config, hardcore, parent, collection: lab ? undefined : collection, lab });
    run = started;
    started.done.then(() => {
      if (!started.lab && started.state === 'dead' && started.hardcore && !closing) schedule(started);
    }).catch(error => {
      started.state = 'incomplete';
      started.detail = error.message;
      console.error(error);
    });
  }

  function schedule(ended) {
    const directory = join(config.root, ended.id);
    const controller = new AbortController();
    ended.state = 'reflecting';
    review = {
      controller,
      done: (async () => {
        let reflection = await readReflection(directory);
        if (!reflection) {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
          try {
            reflection = deathReview(await reflect({ directory, death: ended.death, agentDir, signal, inference }));
          } catch (error) {
            if (controller.signal.aborted) return;
            reflection = { error: String(error?.message ?? error) };
          }
          if (controller.signal.aborted) return;
          await writeReflection(directory, reflection);
        }
        if (controller.signal.aborted || closing || reflection.stopped) return;
        // Saved reviews are human-readable records, including older files with a proposed profile.
        begin({ hardcore: ended.hardcore, parent: ended.id });
      })().catch(error => {
        ended.detail = `Reflection could not continue: ${error.message}`;
        console.error(error);
      }).finally(() => {
        if (run === ended && ended.state === 'reflecting') ended.state = 'dead';
        if (!review?.stop) review = undefined;
      }),
    };
  }

  const server = createServer(async (request, response) => {
    const json = (statusCode, value) => {
      response.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const origin = `http://${host}:${server.address().port}`;
    const port = server.address().port;
    const hostHeader = request.headers.host;
    const forwardedHosts = ['localhost', '127.0.0.1', '[::1]'];
    const forwardedHost = forwardedHosts.some(name => hostHeader === `${name}:${port}`);
    const forwardedOrigin = forwardedHosts.some(name => request.headers.origin === `http://${name}:${port}`);
    if (!allowed.has(request.socket.remoteAddress) ||
        (hostHeader !== new URL(origin).host && !forwardedHost)) {
      return json(403, { error: 'Dashboard access is restricted.' });
    }
    const viewer = new URL(request.url, origin).pathname.match(/^\/api\/modal\/viewer\/([a-f0-9]{12})\//);
    if (viewer) {
      if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'Method unavailable.' });
      const selected = modalService?.getRun(viewer[1]);
      if (!selected) return json(404, { error: 'Viewer unavailable.' });
      return selected.proxyViewer(request, response);
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      const asset = assets.get(request.url);
      if (asset) {
        response.writeHead(200, {
          'content-type': asset.type, 'cache-control': 'no-store',
          'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
        });
        return response.end(asset.body);
      }
      if (request.url === '/favicon.ico') return response.writeHead(204).end();
      if (request.url === '/api/run' || request.url.startsWith('/api/run?')) {
        const id = new URL(request.url, origin).searchParams.get('modal');
        if (!id) return json(200, status());
        const selected = modalService?.getRun(id);
        return selected ? json(200, modalStatus(selected)) : json(404, { error: 'Run unavailable.' });
      }
      if (request.url === '/api/modal') return json(200, modalService?.status() ?? { state: 'idle', slots: [], desiredCount: 0 });
      try {
        const url = new URL(request.url, origin);
        if (url.pathname === '/api/runs') {
          const runs = await savedRuns(config.root);
          return json(200, runs.map(saved => {
            if (active() && saved.id === run.id) return { ...saved, ...status() };
            const remote = modalService?.getRun(saved.id);
            return remote ? { ...saved, ...modalStatus(remote) } : saved;
          }));
        }
        if (url.pathname === '/api/lab') {
          const [fixtures, checkpoints] = await Promise.all([labFixtures(), labCheckpoints(config.root)]);
          return json(200, { fixtures: fixtures.map(({ id, name, description, version, timeLimitMs, requiredBuild }) => ({
            id, name, description, version, timeLimitMs, requiredBuild,
          })),
            checkpoints: checkpoints.map(({ path: _path, ...checkpoint }) => checkpoint),
            candidateAvailable: Boolean(config.candidateImage), defaultBuild: mineImage });
        }
        if (url.pathname === '/api/modal/artifacts' || url.pathname === '/api/modal/artifact') {
          const id = url.searchParams.get('id');
          if (!runId.test(id ?? '')) return json(400, { error: 'Invalid run ID.' });
          const manifest = await readFile(join(config.root, id, 'run.json'), 'utf8').then(JSON.parse);
          if (!manifest.modal?.runKey) return json(404, { error: 'Remote artifacts unavailable.' });
          const service = await getModalService();
          const identity = { runKey: manifest.modal.runKey, runId: id };
          if (url.pathname === '/api/modal/artifacts') return json(200, await service.control({ command: 'artifact-list', ...identity }));
          if (request.method === 'HEAD') return json(405, { error: 'Use GET to download artifacts.' });
          const kind = url.searchParams.get('kind');
          if (kind === 'world' && ['starting', 'running', 'saving'].includes(service.getRun(id)?.state)) {
            return json(409, { error: 'Stop the run before downloading its world.' });
          }
          const python = await service.getPython();
          return streamModalArtifact(identity, kind, response,
            { stream: args => modalArtifactStream(args, { python, script: join(repo, 'deploy/modal_control.py') }) });
        }
        if (url.pathname === '/api/recording') {
          const id = url.searchParams.get('id');
          if (!runId.test(id ?? '')) return json(400, { error: 'Invalid run ID.' });
          const manifest = await readFile(join(config.root, id, 'run.json'), 'utf8').then(JSON.parse, error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (manifest?.modal?.runKey) {
            const service = await getModalService();
            const python = await service.getPython();
            return await serveModalRecording({ runId: id, runKey: manifest.modal.runKey,
              ...(url.searchParams.has('segment') && { segment: url.searchParams.get('segment') }) }, request, response,
            { stat: service.control, stream: args => modalArtifactStream(args, { python, script: join(repo, 'deploy/modal_control.py') }) });
          }
          return await serveRecording(config.root, id, request, response);
        }
        if (url.pathname === '/api/conversation') {
          const id = url.searchParams.get('id');
          const before = url.searchParams.has('before') ? Number(url.searchParams.get('before')) : undefined;
          if (!runId.test(id) || (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
            return json(400, { error: 'Invalid conversation request.' });
          }
          return json(200, await conversation(join(config.root, id), before));
        }
      } catch (error) {
        if (error.code === 'ENOENT') return json(404, { error: 'Run unavailable.' });
        console.error(error);
        return json(500, { error: 'Could not read saved run data.' });
      }
    }
    if (request.method === 'POST' && (request.headers.origin === origin || forwardedOrigin)) {
      const url = new URL(request.url, origin);
      if (['/api/modal/start', '/api/modal/stop', '/api/modal/resume', '/api/modal/resize'].includes(url.pathname)) {
        try {
          const service = await getModalService();
          if (url.pathname === '/api/modal/start') {
            const input = await readJsonBody(request);
            if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > 64 || !['hardcore', 'survival'].includes(input.mode)) {
              return json(400, { error: 'Choose a mode and between 1 and 64 worlds.' });
            }
            await service.start({ count: input.count, hardcore: input.mode === 'hardcore' });
          } else if (url.pathname === '/api/modal/resize') {
            const input = await readJsonBody(request);
            await service.resize(input.count);
          } else if (url.pathname === '/api/modal/stop') await service.stop();
          else await service.resume();
          return json(202, service.status());
        } catch (error) { return json(409, { error: error.message }); }
      }
      if (url.pathname === '/api/start') {
        if (closing || active()) return json(409, { error: 'A run is already active.' });
        const mode = url.searchParams.get('mode') ?? defaultMode;
        if (mode !== 'hardcore' && mode !== 'survival') return json(400, { error: 'Select Survival or Hardcore.' });
        const selectedHardcore = mode === 'hardcore';
        if (selectedHardcore && run?.hardcore && run.state === 'won') return json(409, { error: 'The Dragon has already been defeated.' });
        begin({ hardcore: selectedHardcore, collect: url.searchParams.get('collect') === '1' });
        return json(202, status());
      }
      if (url.pathname === '/api/lab/start') {
        if (closing || active()) return json(409, { error: 'A run is already active.' });
        let input;
        try {
          input = await readJsonBody(request);
        } catch (error) {
          return json(400, { error: error.message });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { error: 'Choose a fixture or checkpoint.' });
        const build = input.build ?? 'current';
        if (build !== 'current' && build !== 'candidate') return json(400, { error: 'Choose the current or candidate build.' });
        if (build === 'candidate' && !config.candidateImage) return json(400, { error: 'No candidate image is configured.' });
        const image = build === 'candidate' ? config.candidateImage : mineImage;
        const candidateImage = build === 'candidate';
        const timeLimitMs = input.timeLimitMs ?? (input.fixtureId ? undefined : 5 * 60_000);
        if (timeLimitMs !== undefined && (!Number.isSafeInteger(timeLimitMs) || timeLimitMs < 30_000 || timeLimitMs > 1_200_000)) {
          return json(400, { error: 'Set a time limit between 30 seconds and 20 minutes.' });
        }
        if (input.fixtureId) {
          const fixture = (await labFixtures()).find(item => item.id === input.fixtureId);
          if (!fixture) return json(404, { error: 'Fixture unavailable.' });
          if (fixture.requiredBuild && build !== fixture.requiredBuild) {
            return json(400, { error: `${fixture.name} requires the ${fixture.requiredBuild} build.` });
          }
          const limit = timeLimitMs ?? fixture.timeLimitMs;
          const summary = { type: 'fixture', fixtureId: fixture.id, fixtureName: fixture.name,
            fixtureVersion: fixture.version, build, timeLimitMs: limit };
          if (closing || active()) return json(409, { error: 'A run is already active.' });
          begin({ lab: { type: 'fixture', fixture, summary, image, candidateImage, timeLimitMs: limit } });
          return json(202, status());
        }
        if (input.checkpointId) {
          const checkpoints = await labCheckpoints(config.root);
          const checkpoint = resolveLabCheckpoint(config.root, input.checkpointId, checkpoints);
          if (!checkpoint) return json(404, { error: 'Checkpoint unavailable.' });
          const metadata = JSON.parse(await readFile(join(checkpoint.path, 'checkpoint.json'), 'utf8'));
          const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
          if (!metadata.context && !instruction) return json(400, { error: 'This checkpoint has no conversation. Enter a task to replay it.' });
          if (instruction.length > 2000) return json(400, { error: 'Keep the replay instruction under 2,000 characters.' });
          let checks;
          try {
            checks = validateLabChecks(input.checks ?? []);
          } catch (error) {
            return json(400, { error: error.message });
          }
          const limit = timeLimitMs ?? 5 * 60_000;
          const summary = { type: 'checkpoint', checkpointId: checkpoint.id, sourceRun: checkpoint.run,
            context: Boolean(metadata.context), contextAgeMs: metadata.contextAgeMs, instruction, checks, build, timeLimitMs: limit };
          if (closing || active()) return json(409, { error: 'A run is already active.' });
          begin({ lab: { type: 'checkpoint', checkpoint: { ...checkpoint, metadata }, summary,
            image, candidateImage, timeLimitMs: limit, instruction, checks } });
          return json(202, status());
        }
        return json(400, { error: 'Choose a fixture or checkpoint.' });
      }
      if (request.url === '/api/stop') {
        if (review) {
          const ended = run;
          const pending = review;
          pending.controller.abort(new Error('Stopped by operator.'));
          // Keep the lifecycle owned until the stop marker is durable.
          pending.stop ??= pending.done.then(async () => {
            const directory = join(config.root, ended.id);
            await writeReflection(directory, { ...await readReflection(directory), stopped: true });
            review = undefined;
          });
          await pending.stop.catch(error => {
            ended.detail = `Could not record stop: ${error.message}`;
            review = undefined;
            console.error(error);
          });
        } else if (active()) {
          void run.stop().catch(() => {});
        }
        return json(202, status());
      }
    }
    return json(404, { error: 'Route unavailable.' });
  });
  server.on('upgrade', (request, socket, head) => {
    const origin = `http://${host}:${server.address().port}`;
    const allowedHost = [new URL(origin).host, `localhost:${server.address().port}`, `127.0.0.1:${server.address().port}`, `[::1]:${server.address().port}`];
    const allowedOrigin = allowedHost.map(value => `http://${value}`);
    const match = new URL(request.url, origin).pathname.match(/^\/api\/modal\/viewer\/([a-f0-9]{12})\//);
    if (!match || !allowed.has(request.socket.remoteAddress) || !allowedHost.includes(request.headers.host) ||
        (request.headers.origin && !allowedOrigin.includes(request.headers.origin))) return socket.destroy();
    const selected = modalService?.getRun(match[1]);
    if (!selected) return socket.destroy();
    selected.proxyViewerUpgrade(request, socket, head);
  });
  // An abstract socket releases ownership even when the host process is killed.
  const lock = createSocket(client => client.destroy());
  const lockPath = `\0mine-ai-${createHash('sha256').update(config.root).digest('hex')}`;
  await new Promise((ready, reject) => lock.once('error', reject).listen(lockPath, ready));
  try {
    await recoverRuns(config.root);
    await recoverInterruptedRecordings(config.root);
    run = (await savedRuns(config.root)).find(saved => !saved.modal);
    if (run?.hardcore && run.state !== 'won') {
      const directory = join(config.root, run.id);
      // Recover a win written by vanilla before the launcher saved its result.
      for (const file of ['server/logs/latest.log', 'server.log']) {
        const log = await readFile(join(directory, file), 'utf8').catch(error => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        });
        const proof = dragonAdvancement(log);
        if (!proof) continue;
        Object.assign(run, { state: 'won', detail: proof });
        break;
      }
      if (run.state === 'incomplete' && run.interrupted) {
        const death = await recordedDeath(directory).catch(error => {
          console.error(`Could not recover death evidence for ${run.id}: ${error.message}`);
          return null;
        });
        if (death) Object.assign(run, { state: 'dead', death, detail: death.cause ?? 'Minecraft recorded Acacia’s death.' });
      }
    }
    await recoverCheckpoints(config.root, run).catch(error => {
      console.error(`Could not recover checkpoints: ${error.message}`);
    });
    const resumeReview = !run?.lab && run?.hardcore && run.state === 'dead' &&
      !(await readReflection(join(config.root, run.id)))?.stopped;
    await new Promise((ready, reject) => server.once('error', reject).listen(port, host, ready));
    if (!modalService && await readFile(join(config.root, 'modal-batch.json'), 'utf8').then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    })) {
      const service = await getModalService();
      void service.recover().catch(error => console.error(`Could not resume Modal batch: ${error.message}`));
    }
    if (resumeReview) {
      if (run.collectionSession) collection = { id: run.collectionSession, runtime: run.runtime };
      schedule(run);
    }
  } catch (error) {
    lock.close();
    throw error;
  }
  return {
    port: server.address().port,
    async close() {
      closing = true;
      const closed = new Promise(ready => server.close(ready));
      if (review) {
        review.controller.abort(new Error('Harness service shut down.'));
        await (review.stop ?? review.done);
      } else if (active()) await run.stop(new Error('Harness service shut down.')).catch(() => {});
      await modalService?.close();
      await closed;
      await new Promise(ready => lock.close(ready));
    },
  };
}

if (import.meta.main) {
  process.umask(0o077);
  const host = process.env.MINECRAFT_HOST ?? '127.0.0.1';
  const app = await dashboard({
    host, port: Number(process.env.MINECRAFT_PORT ?? 2718),
    viewerPort: Number(process.env.MINECRAFT_VIEWER_PORT ?? 3000),
    gamePort: Number(process.env.MINECRAFT_GAME_PORT ?? 25565),
    allowed: new Set([host, '127.0.0.1', process.env.MINECRAFT_CLIENT_TAILSCALE_IP].filter(Boolean)),
    root: resolve(process.env.MINECRAFT_RUNS ?? join(homedir(), '.local/share/mine-ai')),
    agentDir: resolve(process.env.PI_AGENT_DIR ?? join(homedir(), '.local/share/minecraft-agent/pi')),
    jar: process.env.MINECRAFT_SERVER_JAR,
    hardcore: process.env.MINECRAFT_HARDCORE === '1',
    candidateImage: process.env.MINE_AI_CANDIDATE_IMAGE,
  });
  console.log(`Dashboard at http://${host}:${app.port}`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { void app.close(); });
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new Error('Lab request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('Send valid JSON to start a lab run.');
  }
}
