import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { test } from 'node:test';
import { mineImage } from '../src/run.mjs';

const repository = resolve(import.meta.dirname, '..');

function command(program, args, options = {}) {
  return spawnSync(program, args, { encoding: 'utf8', timeout: 120_000, ...options });
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'acacia-monorepo-'));
  const checkout = join(root, 'checkout');
  await cp(repository, checkout, {
    recursive: true,
    filter: source => !['.git', 'node_modules', 'recordings', 'runs', '.venv', '.cache', '.bun', '.gradle', 'dist', 'coverage'].includes(basename(source)) &&
      source.slice(repository.length + 1) !== 'deploy/mine-ai-source',
  });
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'baseline']]) {
    const result = command('git', args, { cwd: checkout });
    assert.equal(result.status, 0, result.stderr);
  }
  return { root, checkout };
}

async function filesUnder(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesUnder(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

async function dockerStub(root) {
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TEST_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'build' || (args[0] === 'buildx' && args[1] === 'build')) {
  if (process.env.TEST_BUILD_FAIL === '1') process.exit(42);
  const context = path.resolve(args.at(-1));
  fs.cpSync(context, process.env.TEST_BUILD_CONTEXT, { recursive: true });
}
if (args[0] === 'image' && args[1] === 'inspect') console.log('[]');
`, { mode: 0o755 });
  const realGit = command('which', ['git']).stdout.trim();
  await writeFile(join(bin, 'git'), `#!/bin/sh
for arg in "$@"; do
  case "$arg" in fetch|clone|pull) echo 'network Git operation forbidden' >&2; exit 99;; esac
done
exec '${realGit}' "$@"
`, { mode: 0o755 });
  return {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MINE_AI_FORK_DIR: join(root, 'missing-private-checkout'),
    TEST_DOCKER_LOG: join(root, 'docker.jsonl'),
    TEST_BUILD_CONTEXT: join(root, 'build-context'),
  };
}

test('the Minecraft checkout contains the current Mine AI server and Enderman tool', async () => {
  const packagePath = join(repository, 'mine-ai-mcp/package.json');
  const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.ok(pkg.scripts.test, 'the imported MCP server must retain its test command');
  await readFile(join(repository, 'mine-ai-mcp/bun.lock'));
  await readFile(join(repository, 'mine-ai-mcp/LICENSE'));
  const contract = await readFile(join(repository, 'mine-ai-mcp/src/actions/hunt-endermen-under-umbrella/contract.ts'), 'utf8');
  assert.match(contract, /hunt_endermen_under_umbrella/);
});

test('the repository exposes the documented bot build command', async () => {
  const pkg = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts['build:bot'], 'npm run build:bot must be available from the repository root');
});

test('the root build command uses edited and new MCP files without a private checkout', async () => {
  const { root, checkout } = await workspace();
  try {
    const source = join(checkout, 'mine-ai-mcp/src/server/runtime-host.ts');
    const original = await readFile(source, 'utf8');
    await writeFile(source, `${original}\n// ACACIA_EDITED_SOURCE_8d2e\n`);
    await writeFile(join(checkout, 'mine-ai-mcp/src/monorepo-build-probe.ts'), 'export const probe = "ACACIA_NEW_SOURCE_12b4";\n');
    await rm(join(checkout, 'mine-ai-mcp/src/actions/hunt-endermen-under-umbrella/contract.test.ts'));
    const env = await dockerStub(root);
    const result = command('npm', ['run', 'build:bot'], { cwd: checkout, env });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = (await readFile(env.TEST_DOCKER_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(args => args.includes(mineImage)), 'the build must update the image used by gameplay');
    const paths = await filesUnder(env.TEST_BUILD_CONTEXT);
    const contents = await Promise.all(paths.map(path => readFile(path, 'utf8')));
    assert.ok(contents.some(content => content.includes('ACACIA_EDITED_SOURCE_8d2e')), 'edited MCP source must reach Docker');
    assert.ok(contents.some(content => content.includes('ACACIA_NEW_SOURCE_12b4')), 'new MCP source must reach Docker');
    assert.ok(paths.some(path => basename(path) === 'browser-recording.mjs'));
    assert.ok(paths.some(path => basename(path) === 'recording.mjs'));
    assert.ok(!paths.some(path => path.endsWith('/hunt-endermen-under-umbrella/contract.test.ts')),
      'deleted source must stay deleted in the build');
    assert.equal(await readFile(source, 'utf8'), `${original}\n// ACACIA_EDITED_SOURCE_8d2e\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed bot build reports failure without deleting or retagging an existing image', async () => {
  const { root, checkout } = await workspace();
  try {
    await readFile(join(checkout, 'mine-ai-mcp/package.json'));
    const env = { ...await dockerStub(root), TEST_BUILD_FAIL: '1' };
    const result = command('npm', ['run', 'build:bot'], { cwd: checkout, env });
    assert.notEqual(result.status, 0, 'a failed Docker build must fail the root command');
    const calls = (await readFile(env.TEST_DOCKER_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(args => args[0] === 'build' || (args[0] === 'buildx' && args[1] === 'build')));
    assert.ok(!calls.some(args => args[0] === 'tag' || args[0] === 'rmi' ||
      (args[0] === 'image' && ['tag', 'rm'].includes(args[1]))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
