import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createSocket } from 'node:net';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { dragonAdvancement, mineImage, recoverRuns, startRun } from './run.mjs';
import { conversation, runId, savedRuns } from './history.mjs';
import { recoverInterruptedRecordings, serveRecording } from './recordings.mjs';
import { modelId, thinkingLevel } from './pi.mjs';
import { recoverCheckpoints } from './checkpoints.mjs';
import { labCheckpoints, labFixtures, resolveLabCheckpoint, validateLabChecks } from './labs.mjs';
import { deathReview, readReflection, recordedDeath, reflectDeath, writeReflection } from './primitives.mjs';

export async function dashboard({ host, port, root, agentDir, viewerPort, gamePort, allowed, jar, inference,
  candidateImage, hardcore = false, reflect = reflectDeath }) {
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
      if (request.url === '/api/run') return json(200, status());
      try {
        const url = new URL(request.url, origin);
        if (url.pathname === '/api/runs') {
          const runs = await savedRuns(config.root);
          if (active()) return json(200, runs.map(saved => saved.id === run.id ? { ...saved, ...status() } : saved));
          return json(200, runs);
        }
        if (url.pathname === '/api/lab') {
          const [fixtures, checkpoints] = await Promise.all([labFixtures(), labCheckpoints(config.root)]);
          return json(200, { fixtures: fixtures.map(({ id, name, description, version, timeLimitMs, requiredBuild }) => ({
            id, name, description, version, timeLimitMs, requiredBuild,
          })),
            checkpoints: checkpoints.map(({ path: _path, ...checkpoint }) => checkpoint),
            candidateAvailable: Boolean(config.candidateImage), defaultBuild: mineImage });
        }
        if (url.pathname === '/api/recording') {
          return await serveRecording(config.root, url.searchParams.get('id'), request, response);
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
  // An abstract socket releases ownership even when the host process is killed.
  const lock = createSocket(client => client.destroy());
  const lockPath = `\0mine-ai-${createHash('sha256').update(config.root).digest('hex')}`;
  await new Promise((ready, reject) => lock.once('error', reject).listen(lockPath, ready));
  try {
    await recoverRuns(config.root);
    await recoverInterruptedRecordings(config.root);
    [run] = await savedRuns(config.root);
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
