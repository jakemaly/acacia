import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, appendFileSync, createWriteStream } from 'node:fs';
import { link, lstat, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual, promisify } from 'node:util';
import { Agent, fetch } from 'undici';
import { play, modelId, thinkingLevel } from './pi.mjs';
import { createCheckpointCollector, restoreCheckpoint } from './checkpoints.mjs';
import { defaultPrimitives, minePolicy, recordedDeath } from './primitives.mjs';

const docker = promisify(execFile).bind(null, 'docker');
const serverImage = 'eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda';
export const mineImage = 'minecraft-mine-ai:acacia-fork-compat';
const revision = 'de4fef3260424d973bf81d0eaa15ff1a2f73ecff';
const forkRepository = 'https://github.com/jakemaly/mine-ai-mcp';
const forkCommit = 'a8ca9f9cfacd33be12448a4a55f97cc210a37b56';
const jarHash = '4707d00eb834b446575d89a61a11b5d548d8c001';
const bot = 'Acacia';
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

export function createLabEvidenceCollector({ id, serverOutput, write, waitFor, serverExit }) {
  let sample = 0;
  return async checks => {
    const items = [...new Set(checks.filter(check => check.kind === 'inventoryOrNearbyAtLeast').map(check => check.item))];
    if (!items.length) return {};
    const itemChecks = checks.filter(check => check.kind === 'inventoryOrNearbyAtLeast');
    const firstLine = serverOutput.length;
    const marker = `LAB_ITEMS_${id}_${++sample}`;
    write(`/say ${marker}_BEGIN\n/scoreboard objectives add acacialab dummy\n`);
    for (const item of items) {
      const center = itemChecks.find(check => check.item === item)?.center;
      const radius = center?.radius ?? 4;
      const selector = `@e[type=minecraft:item,nbt={Item:{id:"minecraft:${item}"}},distance=..${radius}]`;
      write('/scoreboard players set #total acacialab 0\n');
      const origin = center
        ? `/execute in ${center.dimension} positioned ${center.x} ${center.y} ${center.z}`
        : '/execute at Acacia';
      write(`${origin} as ${selector} store result score @s acacialab run data get entity @s Item.Count\n`);
      write(`${origin} as ${selector} run scoreboard players operation #total acacialab += @s acacialab\n`);
      write('/scoreboard players get #total acacialab\n');
    }
    write(`/say ${marker}_END\n`);
    await waitFor(() => serverOutput.some(line => line.includes(`${marker}_END`)), serverExit);
    const segment = serverOutput.slice(firstLine).join('\n');
    const values = [...segment.matchAll(/#total has (\d+) \[acacialab\]/g)].map(match => Number(match[1]));
    return { groundItems: Object.fromEntries(items.map((item, index) => [item, values[index] ?? 0])) };
  };
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
  const seed = config.lab?.fixture?.seed ?? config.lab?.checkpoint?.metadata?.runtime?.seed ?? randomBytes(8).readBigInt64BE().toString();
  const directory = join(config.root, id);
  const hardcore = config.lab ? config.lab.checkpoint?.metadata?.runtime?.hardcore === true : config.hardcore === true;
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
    id, seed, hardcore, profile, parent: config.parent, lab: config.lab?.summary, state: 'starting', activity: [], detail: null,
    collectionSession: config.collection?.id,
    checkpointStatus: collector?.status,
    viewer: `http://${config.host}:${config.viewerPort}/`, spectator: `${config.host}:${config.gamePort}`,
    stop(reason = operatorStop) {
      if (config.lab) run.labStopReason = 'operator_stop';
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
      await Promise.all([data, recording, sockets].map(path => mkdir(path, { mode: 0o700 })));
      if (config.lab?.checkpoint) await restoreCheckpoint(config.lab.checkpoint.path, world);
      else await mkdir(world, { mode: 0o700 });
      if (Buffer.byteLength(join(sockets, 'viewer.sock')) >= 108) throw new Error('Run directory is too long for Unix sockets.');
      const [gameplay, decision] = await Promise.all([
        readFile(prompt, 'utf8'), readFile(new URL('../deploy/decision.txt', import.meta.url), 'utf8'),
      ]);
      const extraInstructions = decision.trim();
      const promptText = config.lab?.instruction ?? (extraInstructions ? `${gameplay.trimEnd()}\n\n${extraInstructions}` : gameplay);
      const selectedImage = config.lab?.image ?? config.collection?.runtime?.image ?? mineImage;
      const inspected = await docker(['image', 'inspect', selectedImage], { timeout: 10_000 });
      const [image] = JSON.parse(inspected.stdout);
      const labels = image.Config.Labels ?? {};
      if (labels['org.opencontainers.image.revision'] !== revision ||
          labels['org.opencontainers.image.base-revision'] !== revision ||
          labels['org.opencontainers.image.source'] !== forkRepository ||
          !/^[a-f0-9]{40}$/.test(labels['org.opencontainers.image.fork-revision'] ?? '') ||
          (!config.lab?.candidateImage && labels['org.opencontainers.image.fork-revision'] !== forkCommit)) {
        throw new Error('The Mine AI image does not match the pinned private fork and upstream base.');
      }
      const runtime = { image: image.Id, imageDigest: image.Id, forkRepository,
        forkCommit: labels['org.opencontainers.image.fork-revision'],
        forkWorkingTree: labels['org.opencontainers.image.fork-working-tree'] ?? 'clean',
        jarHash, promptSha256: createHash('sha256').update(promptText).digest('hex'),
        hardcore, profile, model: modelId, thinkingLevel,
        lab: config.lab?.summary, candidateImage: Boolean(config.lab?.candidateImage) };
      if (config.collection?.runtime && !isDeepStrictEqual(config.collection.runtime, runtime)) {
        throw new Error('The current Minecraft runtime differs from this collection session.');
      }
      if (config.collection) config.collection.runtime = runtime;
      await writeFile(join(directory, 'run.json.tmp'), JSON.stringify({
        id, seed, bot, version: '1.21.4', revision, forkRepository, forkCommit, imageDigest: image.Id, ...runtime,
        parent: config.parent, collectionSession: config.collection?.id, lab: config.lab?.summary,
      }, null, 2));
      await rename(join(directory, 'run.json.tmp'), join(directory, 'run.json'));
      hasManifest = true;
      signal.throwIfAborted();
      const jar = config.jar ?? join(config.root, 'server.jar');
      await verifiedJar(config.root, jar, signal);
      signal.throwIfAborted();
      await writeFile(join(world, 'eula.txt'), 'eula=true\n');
      if (!config.lab?.checkpoint) await writeFile(join(world, 'server.properties'), [
        'online-mode=false', 'gamemode=spectator', 'force-gamemode=true',
        `difficulty=${config.lab?.fixture?.difficulty ?? (hardcore ? 'hard' : 'normal')}`, `hardcore=${hardcore}`,
        `level-seed=${seed}`, ...(config.lab?.fixture?.worldType === 'flat' ? ['level-type=minecraft:flat'] : []),
        'view-distance=10', 'simulation-distance=10', 'spawn-protection=0',
        'enable-rcon=false', 'enable-command-block=false', '',
      ].join('\n'));
      await docker(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', '--label', label, network], { timeout: 15_000 });
      networkCreated = true;
      signal.throwIfAborted();
      let playing = false;
      let botPromoted = false;
      const serverOutput = [];
      ({ child: server, done: serverExit } = launch('server', [
        ...common, '--name', serverName, '--network-alias', 'minecraft', '-i',
        '--memory', '3584m', '--cpus', '3', '--pids-limit', '256',
        '-v', `${world}:/data:rw`, '-v', `${jar}:/server.jar:ro`, '-w', '/data',
        serverImage, 'java', '-Xmx2G', '-jar', '/server.jar', 'nogui',
      ], line => {
        serverOutput.push(line);
        if (serverOutput.length > 500) serverOutput.shift();
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
        if (minecraft?.username === bot && (hardcore || collector || config.lab)) {
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
            if (hardcore || config.lab) {
              run.labStopReason = config.lab ? 'death' : undefined;
              finish(death.cause);
              abort.abort();
            } else {
              void collector.death(death);
            }
          }
        }
        if (!status.ok || !status.minecraft?.connected || status.minecraft.username !== bot) return null;
        const { health, food, inventory, gamemode } = status.minecraft;
        run.player = { health, food, inventory, position: status.minecraft.position };
        if (run.state === 'running' && gamemode === 'survival') void collector?.sample(status.minecraft);
        return { gamemode, health, food };
      };
      try {
        await waitFor(async () => playing && (await health().catch(() => null))?.gamemode === 'survival', mineExit);
        if (config.lab?.fixture) {
          const marker = `LAB_SETUP_${id}`;
          for (const command of config.lab.fixture.prepareBefore ?? []) server.stdin.write(`${command}\n`);
          server.stdin.write(`/say ${marker}_WORLD_READY\n`);
          await waitFor(() => serverOutput.some(line => line.includes(`${marker}_WORLD_READY`)), serverExit);
          for (const [index, check] of (config.lab.fixture.preflight ?? []).entries()) {
            const { x, y, z } = check.pos;
            const block = check.name.includes(':') ? check.name : `minecraft:${check.name}`;
            const passed = `${marker}_PREFLIGHT_${index}_PASS`;
            const failed = `${marker}_PREFLIGHT_${index}_FAIL`;
            server.stdin.write(`/execute in ${check.dimension} if block ${x} ${y} ${z} ${block} run say ${passed}\n`);
            server.stdin.write(`/execute in ${check.dimension} unless block ${x} ${y} ${z} ${block} run say ${failed}\n`);
            await waitFor(() => serverOutput.some(line => line.includes(passed) || line.includes(failed)), serverExit);
            if (serverOutput.some(line => line.includes(failed))) throw new Error(`Fixture preflight failed at ${x}, ${y}, ${z}.`);
          }
          for (const command of config.lab.fixture.prepare ?? []) server.stdin.write(`${command}\n`);
          const setupComplete = `${marker}_SETUP_COMPLETE`;
          server.stdin.write(`/say ${setupComplete}\n`);
          await waitFor(() => serverOutput.some(line => line.includes(setupComplete)), serverExit);
          const readyAt = config.lab.fixture.startWhen?.foodAtMost;
          if (readyAt !== undefined) {
            await waitFor(async () => (await health())?.food <= readyAt, serverExit);
            for (const command of config.lab.fixture.startCommands ?? []) server.stdin.write(`${command}\n`);
            const startMarker = `${marker}_START`;
            server.stdin.write(`/say ${startMarker}\n`);
            await waitFor(() => serverOutput.some(line => line.includes(startMarker)), serverExit);
          }
        }
        if (!await pinSocket('viewer') || !await pinSocket('game')) throw new Error('Mine AI viewer or spectator socket is missing.');
        forwards.push(await forward(config.host, config.viewerPort, join(directory, 'viewer.sock'), config.allowed));
        forwards.push(await forward(config.host, config.gamePort, join(directory, 'game.sock'), config.allowed));
        signal.throwIfAborted();
        run.state = 'running';
        const collectLabEvidence = createLabEvidenceCollector({ id, serverOutput,
          write: command => server.stdin.write(command), waitFor, serverExit });
        agent = play({ directory, socket: mcp, agentDir: config.agentDir, signal, record, promptText,
          collectContext: Boolean(collector), inference: config.inference,
          lab: config.lab?.fixture ?? (config.lab?.checkpoint ? { controller: { type: 'agent' }, checks: config.lab.checks } : undefined),
          resumeSession: config.lab?.checkpoint?.metadata?.context ? join(world, 'pi.jsonl') : undefined,
          resumeSettings: config.lab?.checkpoint?.metadata?.contextSettings,
          instruction: config.lab?.instruction, collectLabEvidence,
          async onLabControllerStart() {
            const commands = config.lab?.fixture?.activateCommands ?? [];
            if (!commands.length) return;
            for (const command of commands) server.stdin.write(`${command}\n`);
            const marker = `LAB_ACTIVATED_${id}`;
            server.stdin.write(`/say ${marker}\n`);
            await waitFor(() => serverOutput.some(line => line.includes(marker)), serverExit);
          },
          onLabOutcome(outcome) {
            run.labOutcome = outcome;
            run.labStopReason = outcome.passed ? 'verified_outcome' : 'criteria_failed';
            run.detail = outcome.passed ? 'Lab outcome passed.'
              : outcome.controllerResult?.error ?? 'Lab controller finished without satisfying its checks.';
            finish(run.detail);
            abort.abort();
          },
        });
        const limitMs = config.lab?.timeLimitMs ?? config.lab?.fixture?.timeLimitMs;
        const timeout = limitMs ? delay(limitMs, undefined, { signal }).then(() => {
          if (signal.aborted) return null;
          run.labStopReason = 'time_limit';
          finish('Lab time limit reached.');
          abort.abort(new Error('Lab time limit reached.'));
          return null;
        }) : new Promise(() => {});
        const watchdog = async () => {
          let failures = 0;
          while (!signal.aborted) {
            await delay(hardcore ? 1000 : 3000, undefined, { signal });
            failures = await health().catch(() => false) ? 0 : failures + 1;
            if (failures >= (hardcore ? 12 : 4)) throw new Error('Mine AI lost its Minecraft connection.');
          }
          return null;
        };
        run.detail = await Promise.race([agent, terminal, timeout, watchdog(), exited(serverExit), exited(mineExit)]);
      } finally {
        await dispatcher.destroy();
      }
    } catch (failure) {
      stopped = signal.reason === operatorStop;
      if (!stopped && !proof && !run.labStopReason) error ??= signal.reason?.message ?? failure.message;
      if (config.lab && !run.labStopReason && !stopped) run.labStopReason = 'run_error';
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
      if ((hardcore || config.lab) && hasManifest && !proof && !death) {
        try {
          death = await recordedDeath(directory);
        } catch (failure) {
          error ??= `Could not read death evidence: ${failure.message}`;
        }
      }
      await collector?.finish(hardcore ? death : undefined);
      if (config.lab && !run.labStopReason) run.labStopReason = 'incomplete';
      const labResult = config.lab ? labTerminalResult(run, { death, error, operatorStop }) : undefined;
      const state = labResult?.state ?? (proof ? 'won' : stopped ? 'stopped' : hardcore && death ? 'dead' : 'incomplete');
      const detail = proof ?? (config.lab
        ? run.detail ?? labResult.detail
        : state === 'dead' ? death.cause ?? 'Minecraft recorded Acacia’s death.'
          : stopped ? operatorStop.message : error ?? run.detail ?? 'Attempt ended before a verified outcome.');
      if (hasManifest) {
        await writeFile(join(directory, 'result.json.tmp'), JSON.stringify({
          state, detail, death, player: run.player, labOutcome: run.labOutcome, stopReason: run.labStopReason,
          cleanupError: state !== 'incomplete' ? error : undefined,
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

function labTerminalResult(run, { death, error, operatorStop }) {
  if (run.labOutcome?.passed) return { state: 'passed', detail: 'Lab outcome passed.' };
  const terminal = {
    criteria_failed: { state: 'failed', detail: 'Lab controller finished without satisfying its checks.' },
    death: { state: 'dead', detail: death?.cause ?? 'Acacia died during the lab attempt.' },
    time_limit: { state: 'timed_out', detail: 'Lab time limit reached.' },
    operator_stop: { state: 'stopped', detail: operatorStop.message },
    run_error: { state: 'failed', detail: error ?? 'The lab run failed before it could verify an outcome.' },
    incomplete: { state: 'incomplete', detail: error ?? run.detail ?? 'The attempt ended without a verified outcome.' },
  };
  return terminal[run.labStopReason] ?? { state: 'incomplete', detail: error ?? 'The lab attempt ended without a verified outcome.' };
}

async function exited(done) {
  throw new Error(await done);
}
