import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearStaleRunSockets, dragonAdvancement, inspectGameImage, mineImage, startRun } from '../src/run.mjs';

test('a missing default image is rebuilt and inspected before starting a run', async () => {
  let available = false;
  let builds = 0;
  const inspect = async () => {
    if (!available) throw Object.assign(new Error('image missing'), { stderr: `Error response from daemon: No such image: ${mineImage}` });
    return { stdout: '[{"Id":"sha256:current"}]' };
  };
  const result = await inspectGameImage(mineImage, { inspect, build: async () => { builds++; available = true; } });
  assert.equal(builds, 1);
  assert.equal(JSON.parse(result.stdout)[0].Id, 'sha256:current');
});

test('image recovery does not build for Docker failures or explicitly selected images', async () => {
  let builds = 0;
  const build = async () => { builds++; };
  await assert.rejects(inspectGameImage(mineImage, {
    build, inspect: async () => { throw Object.assign(new Error('Docker unavailable'), { stderr: 'Cannot connect to the Docker daemon' }); },
  }), /Docker unavailable/);
  await assert.rejects(inspectGameImage('minecraft-mine-ai:candidate', {
    build, inspect: async () => { throw Object.assign(new Error('candidate missing'), { stderr: 'No such image: minecraft-mine-ai:candidate' }); },
  }), /candidate missing/);
  assert.equal(builds, 0);
});

test('image recovery reports a failed rebuild instead of silently using an old image', async () => {
  await assert.rejects(inspectGameImage(mineImage, {
    inspect: async () => { throw Object.assign(new Error('missing'), { stderr: `No such image: ${mineImage}` }); },
    build: async () => { throw new Error('no space left on device'); },
  }), /no space left on device/);
});

test('only the bot’s server advancement proves a win', () => {
  const prefix = '[04:39:50] [Server thread/INFO]: ';
  const message = 'Acacia has made the advancement [Free the End]';
  const log = `${prefix}<Acacia> ${message}\n${prefix}AI_M1KE has made the advancement [Free the End]\n${prefix}Spectator has made the advancement [Free the End]\n`;
  assert.equal(dragonAdvancement(log), null);
  assert.equal(dragonAdvancement(`${log}${prefix}${message}\r\n`), `${prefix}${message}`);
  assert.equal(dragonAdvancement(`${prefix}${message}`), `${prefix}${message}`);
});

test('resume clears stale pinned and bot socket names before a new bot starts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-sockets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sockets = join(root, 'io');
  await mkdir(sockets);
  for (const directory of [root, sockets]) {
    for (const name of ['mcp', 'viewer', 'game']) await writeFile(join(directory, `${name}.sock`), 'stale');
  }
  await writeFile(join(sockets, 'keep.txt'), 'keep');
  await clearStaleRunSockets(root, sockets);
  for (const directory of [root, sockets]) {
    for (const name of ['mcp', 'viewer', 'game']) await assert.rejects(readFile(join(directory, `${name}.sock`)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(join(sockets, 'keep.txt'), 'utf8'), 'keep');
});

test('resuming a missing world fails instead of starting a fresh world under the old ID', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-resume-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = startRun({ root, id: 'aabbccddeeff', resume: true, hardcore: true });
  await run.done;
  assert.equal(run.state, 'incomplete');
  assert.match(run.detail, /resume|saved|ENOENT/i);
});
