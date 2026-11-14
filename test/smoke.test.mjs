import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Agent, fetch as socketFetch } from 'undici';
import { openai } from '../src/pi.mjs';
import { dashboard } from '../src/server.mjs';
import { restoreCheckpoint } from '../src/checkpoints.mjs';

const host = '127.0.0.1';
const send = (port, path) => fetch(`http://${host}:${port}${path}`, {
  method: 'POST', headers: { origin: `http://${host}:${port}` },
});
const firstDecision = {
  objective: 'Find a sheltered route to the cave.',
  observation: 'Solid ground leads to the west entrance.',
  changeCourse: 'Hostile mobs block the entrance.',
};
const secondDecision = {
  objective: 'Scout the east entrance.',
  observation: 'Two skeletons are guarding the west entrance.',
  changeCourse: 'The east route has exposed ledges.',
};

export async function scriptedInference(agentDir, scenario) {
  const { model, runtime } = await openai(agentDir);
  let step = 0;
  let actionId;
  runtime.streamSimple = (_model, context, { signal } = {}) => {
    const messages = context.messages ?? context;
    const lastResult = messages.findLast(message => message.role === 'toolResult');
    const stage = step;
    const earlyReply = [{ type: 'text', text: 'I defeated the dragon.' }];
    let content = earlyReply;
    if (scenario === 'tool-interface') {
      const work = { wait_timeout_ms: 30_000, rationale: 'Verify the fixture action.' };
      const next = [
        () => call('view_status', { rationale: 'Find the test location.' }),
        () => {
          assert.match(lastResult.content[0].text, /Health 20\/20/);
          assert.doesNotMatch(lastResult.content[0].text, /every loaded chunk/);
          const position = lastResult.details.structuredContent.response.data.result.situation.position;
          const { x, y, z } = Object.fromEntries(['x', 'y', 'z'].map(axis => [axis, Math.floor(position[axis])]));
          return call('use_container', { ...work, x: x + 1, y, z, operation: 'deposit',
            items: [{ item_name: 'cobblestone', count: 2 }], submission_id: 'transfer-fixture' });
        },
        () => {
          assert.equal(lastResult.isError, false, lastResult.content[0].text);
          const chest = messages.findLast(message => message.role === 'assistant' &&
            message.content.some(block => block.name === 'mcp__minecraft__use_container')).content[0].arguments;
          return call('use_container', { ...work, x: chest.x, y: chest.y, z: chest.z,
            operation: 'inspect', submission_id: 'inspect-fixture' });
        },
        () => {
          assert.match(lastResult.content[0].text, /cobblestone.*(?:2|two)/i);
          const chest = messages.findLast(message => message.role === 'assistant' &&
            message.content.some(block => block.name === 'mcp__minecraft__use_container')).content[0].arguments;
          return call('build_structure', { ...work,
            blocks: [{ x: chest.x + 1, y: chest.y, z: chest.z, block_name: 'cobblestone' }],
            submission_id: 'build-fixture' });
        },
        () => {
          assert.equal(lastResult.isError, false, lastResult.content[0].text);
          return call('collect_block', { ...work, block_name: 'diamond_ore', count: 2,
            scaffold: false, submission_id: 'collect-batch-fixture' });
        },
        () => {
          assert.equal(lastResult.isError, false, lastResult.content[0].text);
          assert.match(lastResult.content[0].text, /Inventory gained: 2/);
          const build = messages.findLast(message => message.role === 'assistant' &&
            message.content.some(block => block.name === 'mcp__minecraft__build_structure')).content[0].arguments;
          const [{ x, y, z }] = build.blocks;
          return call('collect_exact_block', { ...work, x, y, z, block_name: 'cobblestone',
            scaffold: false, submission_id: 'collect-exact-fixture' });
        },
        () => {
          assert.equal(lastResult.isError, false, lastResult.content[0].text);
          assert.match(lastResult.content[0].text, /Inventory gained: 1/);
          return call('view_status', { detail: 'full', rationale: 'Get slot and mob details.' });
        },
        () => {
          assert.match(lastResult.content[0].text, /Loaded mobs/);
          const build = messages.findLast(message => message.role === 'assistant' &&
            message.content.some(block => block.name === 'mcp__minecraft__build_structure')).content[0].arguments;
          const [{ x, y, z }] = build.blocks;
          return call('view_blocks', { cells: [{ x, y, z }], rationale: 'Confirm the construction completed.' });
        },
      ][stage];
      if (next) content = [next()];
    }
    if (scenario === 'long-route') {
      const work = { wait_timeout_ms: 45_000, rationale: 'Cross the fixture and verify the next action can run.' };
      if (stage === 0) content = [call('view_status', { rationale: 'Get the fixture start position.' })];
      if (stage === 1) {
        const { x, y, z } = lastResult.details.structuredContent.response.data.result.situation.position;
        assert.equal(y, 150, 'the route must start on the fixture platform');
        content = [call('navigate', { ...work, x: Math.floor(x) + 96, y, z: Math.floor(z), range: 1,
          dig: false, scaffold: false, submission_id: 'long-route' })];
      }
      if (stage === 2) {
        assert.equal(lastResult.isError, false, lastResult.content[0].text);
        assert.match(lastResult.content[0].text, /\*\*Status:\*\* succeeded/);
        assert.match(lastResult.content[0].text, /Final Pathfinder node is \*\*(?:0\.\d{2}|1\.00) blocks/);
        content = [call('raw_action', { operation: 'control', state: 'jump', ticks: 5,
          submission_id: 'after-route', ...work })];
      }
    }
    if (scenario === 'decision' && stage < 3) {
      const decision = stage === 0 ? firstDecision : secondDecision;
      content = [call('view_status', { rationale: stage === 1 ? 'Check whether anything moved.' :
        `Objective: ${decision.objective}\nObservation: ${decision.observation}\nChange course if: ${decision.changeCourse}` })];
    }
    if (['expired', 'logging'].includes(scenario) && stage === 1) content = [call('view_status', { rationale: 'Read the bot after reconnecting.' })];
    if (scenario === 'continue') {
      if (stage === 0) {
        content = [call('raw_action', {
          operation: 'control', state: 'jump', ticks: 30,
          submission_id: 'smoke-jump', rationale: 'Check the live viewer.',
          response_format: 'json',
        })];
      }
      if (stage === 2 || stage === 4 || stage === 6 || stage === 8) {
        assert.ok(messages.some(message => message.role === 'assistant' &&
          message.content.some(block => block.type === 'text' && block.text === earlyReply[0].text)));
        if (!actionId) {
          const result = JSON.parse(lastResult.content[0].text).response.data;
          assert.equal(result.state, 'accepted');
          actionId = result.actionId;
        }
        content = [call('wait_for_action', {
          action_id: actionId, timeout_ms: 120_000, rationale: 'Retrieve the existing jump.',
          ...(stage === 4 ? { response_format: 'json' } : {}),
        })];
      }
      if (stage === 3) {
        assert.ok(lastResult.content[0].text.startsWith(`Action ID: ${actionId}\n\n## `));
        assert.match(lastResult.content[0].text, /\*\*Status:\*\* succeeded/);
      }
    }
    const errorMessage = scenario === 'provider' && stage > 0 ? '401: OAuth session expired' : undefined;
    const stopReason = errorMessage ? 'error' : content[0].type === 'toolCall' ? 'toolUse' : 'stop';
    step++;
    const message = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id, content, stopReason,
      timestamp: Date.now(), errorMessage,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    return {
      async *[Symbol.asyncIterator]() {
        if (stage === 0) await delay(3000, undefined, { signal });
        if (stage === 0 && scenario === 'long-route') await delay(7000, undefined, { signal });
        if (stage === 0 && scenario === 'tool-interface') await delay(3500, undefined, { signal });
        if (stage > 0 && ['stop', 'win', 'disconnect'].includes(scenario)) await delay(90_000, undefined, { signal });
        if ((stage === 8 && scenario === 'tool-interface') || (stage === 3 && scenario === 'long-route')) await delay(90_000, undefined, { signal });
        if (stage > 0 && scenario === 'decision') {
          await delay(stage === 3 ? 90_000 : stage === 2 ? 4000 : 1500, undefined, { signal });
        }
        if (stage > 0 && scenario === 'checkpoint') await delay(420_000, undefined, { signal });
        if (stage === 1 && ['expired', 'logging'].includes(scenario)) await delay(3000, undefined, { signal });
        yield { type: 'start', partial: message };
        if (errorMessage) yield { type: 'error', reason: 'error', error: message };
        else yield { type: 'done', reason: stopReason, message };
      },
      async result() { return message; },
    };
  };
  return { model, runtime };

  function call(name, args) {
    return { type: 'toolCall', id: `call_${step}`, name: `mcp__minecraft__${name}`, arguments: args };
  }
}

async function sparePort() {
  const server = createServer().listen(0, host);
  await new Promise(ready => server.once('listening', ready));
  const { port } = server.address();
  await new Promise(ready => server.close(ready));
  return port;
}

export async function smokeDashboard(root, viewerPort, gamePort, scenario = 'continue', options = {}) {
  const agentDir = join(root, 'pi');
  await mkdir(agentDir);
  // This fixture exercises Pi’s real session and tool execution with a scripted provider stream.
  await writeFile(join(agentDir, 'auth.json'), JSON.stringify({
    openai: { type: 'oauth', access: 'smoke-test', refresh: 'smoke-test', expires: Date.now() + 3_600_000 },
  }));
  return dashboard({
    host, port: 0, root, viewerPort, gamePort, allowed: new Set([host]), agentDir,
    jar: process.env.MINECRAFT_SERVER_JAR,
    inference: agentDir => scriptedInference(agentDir, scenario), ...options,
  });
}

const smokeOptions = { skip: process.env.MINECRAFT_SMOKE !== '1', timeout: 140_000 };
const checkpointSmokeOptions = { skip: process.env.MINECRAFT_CHECKPOINT_SMOKE !== '1', timeout: 480_000 };

async function attempt(scenario, verify, options) {
  const root = await mkdtemp(join(tmpdir(), 'mine-ai-'));
  const viewerPort = await sparePort();
  const gamePort = await sparePort();
  const { collect, mode, pollCount = 180, ...dashboardOptions } = options ?? {};
  const app = await smokeDashboard(root, viewerPort, gamePort, scenario, dashboardOptions);
  const status = async () => (await fetch(`http://${host}:${app.port}/api/run`)).json();
  const waitFor = async condition => {
    for (let n = 0; n < pollCount; n++) {
      const run = await status();
      if (condition(run)) return run;
      await delay(500);
    }
    assert.fail(`Timed out with ${JSON.stringify(await status())}`);
  };
  try {
    assert.equal((await fetch(`http://${host}:${app.port}/api/start`, { method: 'POST' })).status, 404);
    assert.equal((await send(app.port, '/api/start?mode=invalid')).status, 400);
    const query = new URLSearchParams();
    if (collect) query.set('collect', '1');
    if (mode) query.set('mode', mode);
    const start = query.size ? `/api/start?${query}` : '/api/start';
    assert.equal((await send(app.port, start)).status, 202);
    assert.equal((await send(app.port, '/api/start')).status, 409);
    const run = await waitFor(status => status.state === 'running' || status.state === 'incomplete');
    assert.equal(run.state, 'running', run.detail);
    assert.equal(Boolean(run.collectionSession), Boolean(collect));
    const terminal = () => waitFor(status => ['won', 'incomplete', 'stopped'].includes(status.state));
    const directory = join(root, run.id);
    if (mode) {
      await waitFor(status => status.activity.some(event => event.type === 'assistant'));
      const transcript = await (await fetch(`http://${host}:${app.port}/api/conversation?id=${run.id}`)).json();
      const hardcore = mode === 'hardcore';
      const manifest = JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
      assert.equal(manifest.hardcore, hardcore);
      const base = (await readFile(new URL(hardcore ? '../deploy/hardcore.txt' : '../deploy/prompt.txt', import.meta.url), 'utf8')).trimEnd();
      const prompt = transcript.messages.find(message => message.role === 'user')?.text;
      assert.ok(prompt.startsWith(base + '\n\n'));
      assert.match(prompt.slice(base.length), /Objective:.*Observation:.*Change course if:/s);
      assert.equal(manifest.promptSha256, createHash('sha256').update(prompt).digest('hex'));
      const properties = await readFile(join(directory, 'server/server.properties'), 'utf8');
      assert.ok(properties.split('\n').includes(`hardcore=${hardcore}`));
      assert.ok(properties.split('\n').includes(`difficulty=${hardcore ? 'hard' : 'normal'}`));
    }
    const consoleCommand = command => execFileSync('docker', ['exec', `mineai-${run.id}-server`,
      'sh', '-c', 'printf "%s\n" "$1" > /proc/1/fd/0', 'sh', command], { timeout: 5000 });
    await verify({ run, app, gamePort, directory, root, status, waitFor, terminal, consoleCommand });
    await stat(join(directory, 'server/world/level.dat'));
    assert.ok((await readdir(directory)).some(name => name.endsWith('.jsonl') && name !== 'activity.jsonl'));
    const serverLog = await readFile(join(directory, 'server.log'), 'utf8');
    assert.match(serverLog, /Acacia joined the game/);
    assert.match(serverLog, /Set Acacia's game mode to Survival Mode/);
    assert.match(serverLog, /All dimensions are saved/);
  } finally {
    await app.close();
    if (process.env.MINECRAFT_KEEP_SMOKE === '1') console.log(root);
    else await rm(root, { recursive: true, force: true });
  }
}

test('a premature final reply preserves a pending action and stale results do not extend retries', smokeOptions, () =>
  attempt('continue', async ({ run, gamePort, terminal }) => {
    assert.equal((await fetch(run.viewer)).status, 200);
    assert.equal(run.player.health, 20);
    assert.ok(Array.isArray(run.player.inventory));
    await new Promise((resolve, reject) => {
      const client = createConnection({ host, port: gamePort });
      client.on('error', reject);
      client.on('connect', () => { client.end(); resolve(); });
    });
    await assert.rejects(fetch(`http://${host}:25575/health`));
    const final = await terminal();
    assert.equal(final.state, 'incomplete');
    const earlyFinal = final.activity.findIndex(event => event.type === 'assistant' && event.stopReason === 'stop');
    const settled = final.activity.findIndex(event => event.type === 'tool_execution_end' &&
      event.tool === 'mcp__minecraft__wait_for_action' && event.outcome === 'settled' && !event.isError);
    assert.ok(earlyFinal >= 0 && settled > earlyFinal);
    assert.deepEqual(final.activity.filter(event => event.type === 'continuation').map(event => event.attempt), [1, 1, 2, 3]);
    assert.match(final.detail, /3 follow-ups produced no completed Minecraft action/);
  }));

test('a terminal provider error during continuation saves and reports the error', smokeOptions, () =>
  attempt('provider', async ({ terminal }) => {
    const final = await terminal();
    assert.equal(final.state, 'incomplete');
    assert.equal(final.detail, '401: OAuth session expired');
    assert.equal(final.activity.filter(event => event.type === 'continuation').length, 1);
  }));

test('Survival selection overrides the Hardcore default and operator stop saves the world', smokeOptions, () =>
  attempt('stop', async ({ app, waitFor, terminal }) => {
    await waitFor(run => run.activity.some(event => event.type === 'continuation'));
    assert.equal((await send(app.port, '/api/stop')).status, 202);
    const final = await terminal();
    assert.equal(final.state, 'stopped');
    assert.equal(final.detail, 'Stopped by operator.');
  }, { mode: 'survival', hardcore: true }));

test('Acacia reports a current decision through Pi and routine calls preserve it', smokeOptions, () =>
  attempt('decision', async ({ app, waitFor, terminal }) => {
    const afterCalls = count => waitFor(run => run.activity.filter(event =>
      event.type === 'tool_execution_end' && event.tool === 'mcp__minecraft__view_status').length >= count);
    assert.deepEqual((await afterCalls(1)).decision, firstDecision);
    assert.deepEqual((await afterCalls(2)).decision, firstDecision);
    assert.deepEqual((await afterCalls(3)).decision, secondDecision);
    assert.equal((await send(app.port, '/api/stop')).status, 202);
    assert.equal((await terminal()).decision, undefined);
  }));

test('Pi follows a long route with one model call and releases the next action', smokeOptions, () =>
  attempt('long-route', async ({ app, waitFor, terminal, consoleCommand }) => {
    consoleCommand('gamerule doMobSpawning false');
    consoleCommand('gamerule fallDamage false');
    consoleCommand('forceload add -64 -16 80 16');
    await delay(2000);
    consoleCommand('fill -44 149 -3 65 149 3 minecraft:stone');
    consoleCommand('tp Acacia -40.5 150 0.5');
    const done = await waitFor(run => run.state !== 'running' || run.activity.some(event =>
      event.type === 'tool_execution_end' && event.tool === 'mcp__minecraft__raw_action'));
    assert.equal(done.state, 'running', done.state === 'saving' ? (await terminal()).detail : done.detail);
    const progress = done.activity.filter(event => event.type === 'action_progress');
    assert.ok(progress.length >= 3, 'route must span at least three internal waits');
    assert.equal(new Set(progress.map(event => event.actionId)).size, 1);
    assert.ok(progress[0].remainingDistance - progress.at(-1).remainingDistance >= 30, JSON.stringify(progress));
    assert.equal(progress.at(-1).health, 20);
    const nav = done.activity.filter(event => event.tool === 'mcp__minecraft__navigate');
    assert.equal(nav.length, 2);
    assert.equal(nav[1].outcome, 'settled');
    const jump = done.activity.find(event => event.type === 'tool_execution_end' && event.tool === 'mcp__minecraft__raw_action');
    assert.equal(jump.outcome, 'settled');
    assert.equal(jump.isError, false);
    const duration = Date.parse(nav[1].time) - Date.parse(nav[0].time);
    console.log(`Long route fixture: ${progress.length} polls, ${duration} ms, health ${progress.at(-1).health}/20.`);
    assert.equal((await send(app.port, '/api/stop')).status, 202);
    assert.equal((await terminal()).state, 'stopped');
  }, { hardcore: true }));

test('Pi can deposit, build, and use both collection modes in Minecraft', smokeOptions, () =>
  attempt('tool-interface', async ({ app, directory, waitFor, terminal, consoleCommand }) => {
    // A chest beside the spawn square gives the real Mine AI operation something to open.
    const dispatcher = new Agent({ connect: { socketPath: join(directory, 'io/mcp.sock') } });
    let position;
    try {
      const health = await socketFetch('http://localhost:25575/health', { dispatcher });
      position = (await health.json()).minecraft.position;
    } finally {
      await dispatcher.destroy();
    }
    const x = Math.floor(position.x);
    const y = Math.floor(position.y);
    const z = Math.floor(position.z);
    consoleCommand(`setblock ${x + 1} ${y - 1} ${z} minecraft:stone`);
    consoleCommand(`setblock ${x + 1} ${y} ${z} minecraft:chest`);
    consoleCommand(`setblock ${x + 2} ${y - 1} ${z} minecraft:stone`);
    consoleCommand(`setblock ${x + 2} ${y} ${z} minecraft:air`);
    consoleCommand(`setblock ${x} ${y - 1} ${z + 1} minecraft:stone`);
    consoleCommand(`setblock ${x} ${y} ${z + 1} minecraft:diamond_ore`);
    consoleCommand(`setblock ${x - 1} ${y - 1} ${z + 1} minecraft:stone`);
    consoleCommand(`setblock ${x - 1} ${y} ${z + 1} minecraft:diamond_ore`);
    consoleCommand('give Acacia minecraft:cobblestone 3');
    consoleCommand('give Acacia minecraft:iron_pickaxe 1');
    const progressed = await waitFor(status => status.state !== 'running' || status.activity.some(event =>
      event.type === 'tool_execution_end' && event.tool === 'mcp__minecraft__view_blocks'));
    assert.equal(progressed.state, 'running', progressed.detail);
    assert.ok(progressed.activity.some(event => event.type === 'tool_execution_end' &&
      event.tool === 'mcp__minecraft__view_blocks' && !event.isError));
    await waitFor(status => status.player?.inventory.some(item => item.name === 'diamond' && item.count === 2));
    assert.equal((await send(app.port, '/api/stop')).status, 202);
    assert.equal((await terminal()).state, 'stopped');
  }));

test('the server advancement ends continuation and proves the win', smokeOptions, () =>
  attempt('win', async ({ waitFor, terminal, consoleCommand }) => {
    await waitFor(run => run.activity.some(event => event.type === 'continuation'));
    // Exercise Minecraft's real advancement log without a full playthrough.
    consoleCommand('advancement grant Acacia only minecraft:end/kill_dragon');
    const final = await terminal();
    assert.equal(final.state, 'won', final.detail);
    assert.match(final.detail, /Acacia has made the advancement \[Free the End\]/);
  }));

test('death and a temporary game-mode change keep the run live until an actual disconnect', smokeOptions, () =>
  attempt('disconnect', async ({ waitFor, terminal, consoleCommand }) => {
    await waitFor(run => run.activity.some(event => event.type === 'continuation'));
    consoleCommand('kill Acacia');
    consoleCommand('gamemode spectator Acacia');
    await delay(15_000);
    await waitFor(run => run.state === 'running');
    consoleCommand('kick Acacia smoke test disconnect');
    const final = await terminal();
    assert.equal(final.state, 'incomplete');
    assert.match(final.detail, /Mine AI lost its Minecraft connection/);
  }));

test('Hardcore death saves a review and launches one fresh world on the same settings', smokeOptions, async () => {
  const reviewed = [];
  await attempt('disconnect', async ({ run, directory, root, app, waitFor, consoleCommand }) => {
    await waitFor(state => state.activity.some(event => event.type === 'continuation'));
    consoleCommand('kill Acacia');
    const successor = await waitFor(state => state.id !== run.id && state.state === 'running');
    assert.equal(reviewed.length, 1);
    assert.match(reviewed[0].cause, /Acacia/);
    assert.equal(successor.parent, run.id);
    assert.deepEqual(successor.profile, run.profile);
    const reflection = JSON.parse(await readFile(join(directory, 'reflection.json'), 'utf8'));
    assert.equal(reflection.category, 'environment');
    assert.equal(reflection.summary, 'The test operator issued a kill command.');
    assert.equal(reflection.profile, undefined);
    assert.equal(reflection.stopped, undefined);
    const history = await (await fetch(`http://${host}:${app.port}/api/runs`)).json();
    assert.deepEqual(history.find(saved => saved.id === run.id).reflection, reflection);
    const result = JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'));
    assert.equal(result.state, 'dead');
    const properties = await readFile(join(root, successor.id, 'server/server.properties'), 'utf8');
    assert.match(properties, /^hardcore=true$/m);
    assert.match(properties, /^difficulty=hard$/m);
    const environment = execFileSync('docker', ['inspect', '--format', '{{json .Config.Env}}',
      `mineai-${successor.id}-bot`], { encoding: 'utf8' });
    const policy = JSON.parse(JSON.parse(environment).find(value => value.startsWith('MINE_AI_BASE_POLICY=')).split('=')[1]);
    assert.equal(policy.combat.critical_health, run.profile.criticalHealth);
    assert.equal(policy.navigation.hostile_avoidance_multiplier, run.profile.hostileAvoidance);
  }, {
    mode: 'hardcore',
    reflect: async ({ death }) => {
      reviewed.push(death);
      return {
        category: 'environment', summary: 'The test operator issued a kill command.',
        evidence: [death.cause], uncertainty: '', reviewQuestion: '',
        profile: { criticalHealth: 14, hostileAvoidance: 3 }, stopped: true,
      };
    },
  });
});

test('an expired MCP session reconnects without restarting Pi or Minecraft', smokeOptions, () =>
  attempt('expired', async ({ directory, waitFor, terminal }) => {
    await waitFor(run => run.activity.some(event => event.type === 'continuation'));
    const log = await readFile(join(directory, 'mine-ai.log'), 'utf8');
    const sessionId = log.match(/MCP client session connected: ([a-f0-9-]+)/)?.[1];
    assert.ok(sessionId);
    const dispatcher = new Agent({ connect: { socketPath: join(directory, 'mcp.sock') } });
    try {
      const closed = await socketFetch('http://127.0.0.1:25575/mcp', {
        method: 'DELETE', headers: { 'mcp-session-id': sessionId }, dispatcher,
      });
      assert.ok(closed.ok);
      await closed.body?.cancel();
    } finally {
      await dispatcher.destroy();
    }
    const final = await terminal();
    assert.equal(final.state, 'incomplete');
    assert.ok(final.activity.some(event => event.type === 'tool_execution_end' &&
      event.tool === 'mcp__minecraft__view_status' && !event.isError));
    const after = await readFile(join(directory, 'mine-ai.log'), 'utf8');
    assert.equal([...after.matchAll(/MCP client session connected:/g)].length, 2);
    assert.equal([...after.matchAll(/runtime ready on port/g)].length, 1);
  }));

test('activity logging failure still saves the world and reports the error', smokeOptions, () =>
  attempt('logging', async ({ directory, waitFor, terminal }) => {
    await waitFor(run => run.activity.some(event => event.type === 'continuation'));
    const activity = join(directory, 'activity.jsonl');
    await rename(activity, join(directory, 'activity-before-failure.jsonl'));
    await mkdir(activity);
    const final = await terminal();
    assert.equal(final.state, 'incomplete');
    assert.match(final.detail, /Could not record run activity/);
  }));

test('a natural Hardcore autosave restores a playable world and survives a death retry', checkpointSmokeOptions, async () => {
  await attempt('checkpoint', async ({ run, directory, root, waitFor, consoleCommand, app }) => {
    await waitFor(state => state.activity.some(event => event.type === 'continuation'));
    // Distinct fixture state makes a fallback spawn or lost inventory observable.
    consoleCommand('difficulty peaceful');
    consoleCommand('tp Acacia 32.5 150 -16.5 30 15');
    consoleCommand('fill 30 149 -19 35 149 -14 minecraft:stone');
    consoleCommand('give Acacia minecraft:diamond_pickaxe[minecraft:damage=27] 1');
    consoleCommand('experience set Acacia 7 levels');
    consoleCommand('experience set Acacia 4 points');
    await waitFor(state => state.checkpoints?.captured === 1);
    const store = join(root, 'checkpoints', run.collectionSession, run.id);
    const indexFile = join(store, 'index.json');
    const index = JSON.parse(await readFile(indexFile, 'utf8'));
    const checkpoint = join(store, index.slots.recent);
    const restore = join(root, 'replay');
    const snapshot = await restoreCheckpoint(checkpoint, restore);
    assert.ok(snapshot.context?.leaf);
    assert.ok(snapshot.contextSettings.tools.some(tool => tool.name === 'mcp__minecraft__view_status'));
    const saved = await readFile(join(restore, 'world/playerdata', `${snapshot.player}.dat`));
    const live = await readFile(join(directory, 'server/world/playerdata', `${snapshot.player}.dat`));
    assert.deepEqual(saved, live);
    await writeFile(join(restore, 'eula.txt'), 'eula=true\n');
    const jar = process.env.MINECRAFT_SERVER_JAR ?? join(root, 'server.jar');
    const replay = `mineai-checkpoint-replay-${run.id}`;
    const docker = (...args) => execFileSync('docker', args, { timeout: 20_000 }).toString();
    try {
      docker('run', '--rm', '--pull=never', '-di', '--name', replay, '--network=none',
        '--user', `${process.getuid()}:${process.getgid()}`, '-v', `${restore}:/data:rw`,
        '-v', `${jar}:/server.jar:ro`, '-w', '/data',
        'eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda',
        'java', '-Xmx1G', '-jar', '/server.jar', 'nogui');
      for (let attempt = 0; attempt < 60 && !docker('logs', replay).includes('Done ('); attempt++) await delay(500);
      assert.match(docker('logs', replay), /Done \(/);
      const replayCommand = command => docker('exec', replay, 'sh', '-c', 'printf "%s\n" "$1" > /proc/1/fd/0', 'sh', command);
      // Join the actual replay over its private loopback using the existing Mineflayer installation.
      const client = docker('run', '--rm', '--pull=never', `--network=container:${replay}`, '--entrypoint=bun',
        'minecraft-mine-ai:de4fef3-primitives', '-e', `
          import mineflayer from 'mineflayer';
          const bot = mineflayer.createBot({ host: '127.0.0.1', username: 'Acacia', version: '1.21.4', auth: 'offline' });
          bot.once('error', error => { console.error(error); process.exit(1); });
          bot.once('spawn', () => setTimeout(() => {
            console.log(JSON.stringify({
              health: bot.health, position: [bot.entity.position.x, bot.entity.position.y, bot.entity.position.z],
              dimension: bot.game.dimension, mode: bot.game.gameMode, xp: bot.experience.level,
              tool: bot.inventory.items().find(item => item.name === 'diamond_pickaxe')?.durabilityUsed,
            }));
            bot.quit(); process.exit(0);
          }, 500));
        `);
      const player = JSON.parse(client.trim().split('\n').at(-1));
      assert.deepEqual(player, { health: 20, position: [32.5, 150, -16.5],
        dimension: 'overworld', mode: 'survival', xp: 7, tool: 27 });
      replayCommand('stop');
    } finally {
      try { docker('rm', '-f', replay); } catch {}
    }
    consoleCommand('damage Acacia 12 minecraft:generic');
    await waitFor(state => state.checkpoints?.incidents === 1);
    consoleCommand('kill Acacia');
    const next = await waitFor(state => state.id !== run.id && state.state === 'running');
    assert.equal(next.collectionSession, run.collectionSession);
    assert.deepEqual(next.profile, run.profile);
    const retained = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.equal(retained.incidents.length, 1);
    assert.equal(retained.incidents[0].outcome, 'death');
    assert.equal(retained.incidents[0].slots.recent, index.slots.recent);
    assert.equal((await send(app.port, '/api/stop')).status, 202);
  }, { hardcore: true, collect: true, pollCount: 760, reflect: async () => ({ category: 'decision',
    summary: 'Synthetic death', evidence: [], uncertainty: '', reviewQuestion: '' }) });
});
