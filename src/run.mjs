import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, appendFileSync, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { Agent, fetch } from 'undici';
import { play, modelId, thinkingLevel } from './pi.mjs';
import { createCheckpointCollector } from './checkpoints.mjs';
import { defaultPrimitives, minePolicy, recordedDeath } from './primitives.mjs';

const docker = promisify(execFile).bind(null, 'docker');
const serverImage = 'eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda';
const mineImage = 'minecraft-mine-ai:acacia-fork-compat';
const revision = 'de4fef3260424d973bf81d0eaa15ff1a2f73ecff';
const forkRepository = 'https://github.com/jakemaly/mine-ai-mcp';
const forkCommit = 'a8ca9f9cfacd33be12448a4a55f97cc210a37b56';
const jarHash = '4707d00eb834b446575d89a61a11b5d548d8c001';
const bot = 'Acacia';
const seed = '97996358';
const advancement = 'minecraft:end/kill_dragon';
const owner = root => `minecraft-mine-ai=${root}`;

export async function recoverRuns(root) {
  const selector = ['--filter', `label=${owner(root)}`, '--quiet'];
  const containers = (await docker(['ps', '-a', ...selector], { timeout: 15_000 })).stdout.trim().split(/\s+/).filter(Boolean);
  if (containers.length) await docker(['stop', '-t', '20', ...containers], { timeout: 30_000 });
  const networks = (await docker(['network', 'ls', ...selector], { timeout: 15_000 })).stdout.trim().split(/\s+/).filter(Boolean);
  if (networks.length) await docker(['network', 'rm', ...networks], { timeout: 15_000 });
}

export function dragonAdvancement(log, username = bot) {
  return log.match(new RegExp(
    String.raw`^\[\d{2}:\d{2}:\d{2}\] \[Server thread/INFO\]: ${RegExp.escape(username)} has made the advancement \[Free the End\]\r?$`,
    'm',
  ))?.[0].trimEnd() ?? null;
}

async function verifiedJar(root, path, signal) {
  const check = async file => {
    const hash = createHash('sha1');
    for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
    if (hash.digest('hex') !== jarHash) throw new Error('Minecraft server JAR checksum mismatch.');
  };
  try {
    await check(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://piston-data.mojang.com/v1/objects/${jarHash}/server.jar`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
    });
    if (!response.ok) throw new Error(`Minecraft server download failed (HTTP ${response.status}).`);
    const temporary = join(root, `server-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, response.body, { mode: 0o600, signal });
      await check(temporary);
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

function forward(host, port, path, allowed) {
  const clients = new Set();
  const server = createServer(client => {
    if (!allowed.has(client.remoteAddress)) return client.destroy();
    clients.add(client);
    const upstream = connect(path);
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.on('close', () => { clients.delete(client); upstream.destroy(); });
    upstream.on('close', () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(() => {
      for (const client of clients) client.destroy();
      server.close();
    }));
  });
}

export function startRun(config) {
  const id = randomUUID().replaceAll('-', '').slice(0, 12);
  const directory = join(config.root, id);
  const hardcore = config.hardcore === true;
  const profile = defaultPrimitives;
  const sockets = join(directory, 'io');
  const serverName = `mineai-${id}-server`;
  const mineName = `mineai-${id}-bot`;
  const network = `mineai-${id}`;
  const abort = new AbortController();
  const { signal } = abort;
  const operatorStop = new Error('Stopped by operator.');
  const collector = config.collection && createCheckpointCollector({
    root: config.root, run: directory, id, session: config.collection.id, collection: config.collection, bot,
  });
  let error;
  const fail = failure => {
    error ??= failure.message;
    abort.abort(failure);
  };
  const run = {
    id, seed, hardcore, profile, parent: config.parent, state: 'starting', activity: [], detail: null,
    collectionSession: config.collection?.id,
    checkpointStatus: collector?.status,
    viewer: `http://${config.host}:${config.viewerPort}/`, spectator: `${config.host}:${config.gamePort}`,
    stop(reason = operatorStop) {
      if (!signal.aborted) abort.abort(reason);
      return run.done;
    },
  };
  const record = (type, payload) => {
    const event = { time: new Date().toISOString(), type, ...payload };
    try {
      appendFileSync(join(directory, 'activity.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
      if (type === 'action_progress') {
        // Preserve the active tool start even when a long objective spans many polls.
        run.activity = [...run.activity.filter(previous => previous.type !== type || previous.id !== event.id).slice(-79), event];
      } else if (type !== 'catalogue') {
        run.activity = [...run.activity.slice(-79), event];
      }
      if (payload.decision) run.decision = payload.decision;
    } catch (failure) {
      fail(new Error(`Could not record run activity: ${failure.message}`));
    }
  };
  run.done = execute();
  return run;

  async function execute() {
    const world = join(directory, 'server');
    const data = join(directory, 'bot');
    const recording = join(directory, 'recording');
    const forwards = [];
    const label = owner(config.root);
    const common = [
      '--rm', '--pull=never', '--init', '--user', `${process.getuid()}:${process.getgid()}`,
      '--label', label, '--network', network, '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    ];
    let server, serverExit, mineExit, agent, networkCreated, hasManifest, proof, stopped = false;
    let ready = false;
    let savedWorld = false;
    let death;
    let survivalStarted = false;
    let finish;
    const terminal = new Promise(resolve => { finish = resolve; });
    const prompt = new URL(hardcore ? '../deploy/hardcore.txt' : '../deploy/prompt.txt', import.meta.url);
    try {
      await mkdir(directory, { mode: 0o700 });
      await Promise.all([world, data, recording, sockets].map(path => mkdir(path, { mode: 0o700 })));
      if (Buffer.byteLength(join(sockets, 'viewer.sock')) >= 108) throw new Error('Run directory is too long for Unix sockets.');
      const [gameplay, decision] = await Promise.all([
        readFile(prompt, 'utf8'), readFile(new URL('../deploy/decision.txt', import.meta.url), 'utf8'),
      ]);
      const extraInstructions = decision.trim();
      const promptText = extraInstructions ? `${gameplay.trimEnd()}\n\n${extraInstructions}` : gameplay;
      const inspected = await docker(['image', 'inspect', config.collection?.runtime?.image ?? mineImage], { timeout: 10_000 });
      const [image] = JSON.parse(inspected.stdout);
      const labels = image.Config.Labels ?? {};
      if (labels['org.opencontainers.image.revision'] !== revision ||
          labels['org.opencontainers.image.base-revision'] !== revision ||
          labels['org.opencontainers.image.source'] !== forkRepository ||
          labels['org.opencontainers.image.fork-revision'] !== forkCommit) {
        throw new Error('The Mine AI image does not match the pinned private fork and upstream base.');
      }
      const runtime = { image: image.Id, imageDigest: image.Id, forkRepository, forkCommit,
        jarHash, promptSha256: createHash('sha256').update(promptText).digest('hex'),
        hardcore, profile, model: modelId, thinkingLevel };
      if (config.collection?.runtime && !isDeepStrictEqual(config.collection.runtime, runtime)) {
        throw new Error('The current Minecraft runtime differs from this collection session.');
      }
      if (config.collection) config.collection.runtime = runtime;
      await writeFile(join(directory, 'run.json.tmp'), JSON.stringify({
        id, seed, bot, version: '1.21.4', revision, forkRepository, forkCommit, imageDigest: image.Id, ...runtime,
        parent: config.parent, collectionSession: config.collection?.id,
      }, null, 2));
      await rename(join(directory, 'run.json.tmp'), join(directory, 'run.json'));
      hasManifest = true;
      signal.throwIfAborted();
      const jar = config.jar ?? join(config.root, 'server.jar');
      await verifiedJar(config.root, jar, signal);
      signal.throwIfAborted();
      await writeFile(join(world, 'eula.txt'), 'eula=true\n');
      await writeFile(join(world, 'server.properties'), [
        'online-mode=false', 'gamemode=spectator', 'force-gamemode=true',
        `difficulty=${hardcore ? 'hard' : 'normal'}`, `hardcore=${hardcore}`,
        `level-seed=${seed}`, 'view-distance=10', 'simulation-distance=10', 'spawn-protection=0',
        'enable-rcon=false', 'enable-command-block=false', '',
      ].join('\n'));
      await docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', label, network], { timeout: 15_000 });
      networkCreated = true;
      signal.throwIfAborted();
      let playing = false;
      let botPromoted = false;
      ({ child: server, done: serverExit } = launch('server', [
        ...common, '--name', serverName, '--network-alias', 'minecraft', '-i',
        '--memory', '3584m', '--cpus', '3', '--pids-limit', '256',
        '-v', `${world}:/data:rw`, '-v', `${jar}:/server.jar:ro`, '-w', '/data',
        serverImage, 'java', '-Xmx2G', '-jar', '/server.jar', 'nogui',
      ], line => {
        if (line.includes(']: Done (')) ready = true;
        if (line.endsWith('All dimensions are saved')) savedWorld = true;
        // The public game port opens later. Only the initial private bot join can gain Survival.
        if (!botPromoted && line.endsWith(`]: ${bot} joined the game`)) {
          botPromoted = true;
          server.stdin.write(`gamemode survival ${bot}\n`);
        }
        if (line.endsWith(`]: Set ${bot}'s game mode to Survival Mode`)) playing = true;
        const joined = line.match(/\[Server thread\/INFO\]: (\w+) joined the game$/)?.[1];
        if (joined && joined !== bot) record('spectator', { name: joined });
        const evidence = dragonAdvancement(line);
        if (evidence && !proof) {
          proof = evidence;
          record('advancement', { advancement, evidence });
          finish(evidence);
          abort.abort();
        }
      }));
      await waitFor(() => ready, serverExit);
      ({ done: mineExit } = launch('mine-ai', [
        ...common, '--name', mineName, '--memory', '3g', '--cpus', '2', '--pids-limit', '512',
        '-v', `${data}:/data:rw`, '-v', `${recording}:/recording:rw`, '-v', `${sockets}:/sockets:rw`,
        '-e', 'HOME=/data', '-e', `MINECRAFT_BOT=${bot}`, '-e', 'MINE_AI_RECORDING_DIR=/recording',
        '-e', `MINE_AI_BASE_POLICY=${JSON.stringify(minePolicy(profile))}`, image.Id,
      ]));
      const mcp = join(directory, 'mcp.sock');
      await waitFor(() => pinSocket('mcp'), mineExit);
      const dispatcher = new Agent({ connect: { socketPath: mcp } });
      const health = async () => {
        const response = await fetch('http://127.0.0.1:25575/health', {
          dispatcher, signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
        });
        const status = await response.json();
        const minecraft = status.minecraft;
        if (minecraft?.username === bot && (hardcore || collector)) {
          if (minecraft.gamemode === 'survival') survivalStarted = true;
          const reportedDeath = minecraft.lastDeath;
          let newDeath = false;
          if (reportedDeath && (!death || reportedDeath.observedAt !== death.observedAt)) {
            death = reportedDeath;
            newDeath = true;
          } else if (hardcore && survivalStarted && minecraft.gamemode === 'spectator' && !death) {
            // Hardcore death changes the player to spectator, even when /health omits lastDeath.
            death = await recordedDeath(directory).catch(() => null) ?? {
              observedAt: new Date().toISOString(),
              cause: 'Acacia entered spectator mode after entering Survival.',
            };
            newDeath = true;
          }
          if (newDeath) {
            record('death', { death });
            if (hardcore) {
              finish(death.cause);
              abort.abort();
            } else {
              void collector.death(death);
            }
          }
        }
        if (!status.ok || !status.minecraft?.connected || status.minecraft.username !== bot) return null;
        const { health, food, inventory, gamemode } = status.minecraft;
        run.player = { health, food, inventory };
        if (run.state === 'running' && gamemode === 'survival') void collector?.sample(status.minecraft);
        return { gamemode };
      };
      try {
        await waitFor(async () => playing && (await health().catch(() => null))?.gamemode === 'survival', mineExit);
        if (!await pinSocket('viewer') || !await pinSocket('game')) throw new Error('Mine AI viewer or spectator socket is missing.');
        forwards.push(await forward(config.host, config.viewerPort, join(directory, 'viewer.sock'), config.allowed));
        forwards.push(await forward(config.host, config.gamePort, join(directory, 'game.sock'), config.allowed));
        signal.throwIfAborted();
        run.state = 'running';
        agent = play({ directory, socket: mcp, agentDir: config.agentDir, signal, record, promptText, collectContext: Boolean(collector), inference: config.inference });
        const watchdog = async () => {
          let failures = 0;
          while (!signal.aborted) {
            await delay(hardcore ? 1000 : 3000, undefined, { signal });
            failures = await health().catch(() => false) ? 0 : failures + 1;
            if (failures >= (hardcore ? 12 : 4)) throw new Error('Mine AI lost its Minecraft connection.');
          }
          return null;
        };
        run.detail = await Promise.race([agent, terminal, watchdog(), exited(serverExit), exited(mineExit)]);
      } finally {
        await dispatcher.destroy();
      }
    } catch (failure) {
      stopped = signal.reason === operatorStop;
      if (!stopped && !proof) error ??= signal.reason?.message ?? failure.message;
    } finally {
      stopped ||= signal.reason === operatorStop;
      run.state = 'saving';
      collector?.stop();
      abort.abort();
      forwards.forEach(close => close());
      if (agent) {
        const settled = await Promise.race([agent.then(() => true, () => true), delay(5000, false, { ref: false })]);
        if (!settled) error ??= 'Pi did not stop promptly.';
      }
      if (mineExit) {
        try {
          const recordingStatus = await requestRecordingStop(recording);
          if (recordingStatus?.state === 'failed') console.error(`[recording] ${recordingStatus.error}`);
        } catch (failure) {
          console.error(`[recording] Could not request finalization: ${failure.message}`);
        }
        await stopContainer(mineName, mineExit, 45);
      }
      if (serverExit) {
        server.stdin.end('stop\n');
        const saved = await Promise.race([serverExit, delay(25_000, false, { ref: false })]);
        if (!saved) await stopContainer(serverName, serverExit);
        if (ready && !savedWorld) error ??= 'Minecraft exited without confirming the world save.';
      }
      if (networkCreated) {
        await docker(['network', 'rm', network], { timeout: 15_000 }).catch(failure => { error ??= failure.message; });
      }
      if (hasManifest) {
        for (const name of ['mcp', 'viewer', 'game']) await rm(join(directory, `${name}.sock`), { force: true });
      }
      // Death and a disconnect can arrive in the same tick. The bot's durable
      // server event still identifies the outcome after the containers stop.
      if (hardcore && hasManifest && !proof && !death) {
        try {
          death = await recordedDeath(directory);
        } catch (failure) {
          error ??= `Could not read death evidence: ${failure.message}`;
        }
      }
      await collector?.finish(hardcore ? death : undefined);
      const state = proof ? 'won' : stopped ? 'stopped' : hardcore && death ? 'dead' : 'incomplete';
      const detail = proof ?? (state === 'dead' ? death.cause ?? 'Minecraft recorded Acacia’s death.'
        : stopped ? operatorStop.message : error ?? run.detail ?? 'Attempt ended before a verified outcome.');
      if (hasManifest) {
        await writeFile(join(directory, 'result.json.tmp'), JSON.stringify({
          state, detail, death, player: run.player, cleanupError: state !== 'incomplete' ? error : undefined,
        }, null, 2));
        await rename(join(directory, 'result.json.tmp'), join(directory, 'result.json'));
      }
      Object.assign(run, { state, detail, death });
    }

    function launch(name, args, onLine) {
      const child = spawn('docker', ['run', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.on('error', () => {});
      const log = createWriteStream(join(directory, `${name}.log`), { mode: 0o600 });
      log.on('error', fail);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          onLine?.(line);
          log.write(`${line}\n`);
        } catch (failure) {
          fail(failure);
        }
      });
      child.stderr.pipe(log, { end: false });
      const done = new Promise(resolve => {
        child.once('error', failure => resolve(`${name}: ${failure.message}`));
        child.once('close', code => { log.end(); resolve(`${name} exited (${code}).`); });
      });
      return { child, done };
    }

    async function pinSocket(name) {
      const filename = `${name}.sock`;
      const pinned = join(directory, filename);
      try {
        // Link first so the sandbox cannot replace a checked name with a symlink to a host socket.
        await link(join(sockets, filename), pinned);
      } catch (failure) {
        if (failure.code === 'ENOENT') return false;
        throw failure;
      }
      if (!(await lstat(pinned)).isSocket()) throw new Error(`Invalid ${name} socket from Mine AI.`);
      return true;
    }

    async function stopContainer(name, done, graceSeconds = 12) {
      try {
        await docker(['stop', '-t', String(graceSeconds), name], { timeout: (graceSeconds + 8) * 1000 });
      } catch (failure) {
        const gone = await Promise.race([done, delay(1000, false, { ref: false })]);
        if (!gone) error ??= failure.message;
      }
      if (!await Promise.race([done, delay(3000, false, { ref: false })])) {
        error ??= `Docker did not release ${name} after stop.`;
      }
    }

    async function requestRecordingStop(directory) {
      const request = join(directory, 'stop.request');
      try {
        await writeFile(request, '', { flag: 'wx', mode: 0o600 });
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            const status = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
            if (status.state === 'complete' || status.state === 'failed') return status;
          } catch (failure) {
            if (failure.code !== 'ENOENT') throw failure;
            if (attempt >= 10) return null;
          }
          await delay(200);
        }
        return null;
      } finally {
        await rm(request, { force: true });
      }
    }

    async function waitFor(check, done) {
      await Promise.race([exited(done), (async () => {
        for (let attempt = 0; attempt < 180; attempt++) {
          signal.throwIfAborted();
          if (await check()) return;
          await delay(500, undefined, { signal, ref: false });
        }
        throw new Error('Minecraft startup timed out. See the run logs.');
      })()]);
    }
  }
}

async function exited(done) {
  throw new Error(await done);
}
