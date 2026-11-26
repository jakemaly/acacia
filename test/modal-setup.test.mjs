import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDependencyInstaller } from '../src/modal-setup.mjs';

test('releases with the same dependency lock share an immutable installation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-deps-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releases = [join(root, 'r1'), join(root, 'r2')];
  for (const dir of releases) {
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), '{"name":"fixture"}');
    await writeFile(join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
  }
  let installs = 0;
  const install = createDependencyInstaller({ output: join(root, 'deps'), run: async (_command, _args, options) => {
    installs++;
    await mkdir(join(options.cwd, 'node_modules'));
    await writeFile(join(options.cwd, 'node_modules', 'fixture.txt'), 'installed');
  } });
  await Promise.all(releases.map(path => install({ path })));
  assert.equal(installs, 1);
  assert.equal(await readFile(join(releases[0], 'node_modules', 'fixture.txt'), 'utf8'), 'installed');
  assert.equal(await readFile(join(releases[1], 'node_modules', 'fixture.txt'), 'utf8'), 'installed');
});
