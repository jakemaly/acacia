import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { snapshotRelease } from '../src/release.mjs';

test('a release captures edited and new source, excludes ignored files, and identifies exact content', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-release-test-'));
  const repo = join(root, 'repo');
  const output = join(root, 'releases');
  await mkdir(join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, '.gitignore'), 'src/secret.txt\n');
  await writeFile(join(repo, 'src', 'agent.mjs'), 'original\n');
  execFileSync('git', ['-C', repo, 'add', '.gitignore', 'src/agent.mjs']);
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'initial']);
  await writeFile(join(repo, 'src', 'agent.mjs'), 'edited\n');
  await writeFile(join(repo, 'src', 'new.mjs'), 'new\n');
  await writeFile(join(repo, 'src', 'secret.txt'), 'secret\n');
  t.after(() => rm(root, { recursive: true, force: true }));

  const first = await snapshotRelease({ repo, output });
  assert.equal(first.workingTree, 'dirty');
  assert.equal(await readFile(join(first.path, 'src', 'agent.mjs'), 'utf8'), 'edited\n');
  assert.equal(await readFile(join(first.path, 'src', 'new.mjs'), 'utf8'), 'new\n');
  await assert.rejects(readFile(join(first.path, 'src', 'secret.txt')), { code: 'ENOENT' });
  const same = await snapshotRelease({ repo, output });
  assert.equal(same.digest, first.digest);
  await writeFile(join(repo, 'src', 'agent.mjs'), 'later edit\n');
  const next = await snapshotRelease({ repo, output });
  assert.notEqual(next.digest, first.digest);
  assert.equal(await readFile(join(first.path, 'src', 'agent.mjs'), 'utf8'), 'edited\n');
});

test('Modal bot build context contains only the frozen bot source and deployment inputs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-context-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'deploy'));
  await mkdir(join(root, 'mine-ai-mcp'));
  for (const file of ['Dockerfile', 'inside.mjs', 'viewer.mjs', 'recording.mjs', 'browser-recording.mjs',
    'viewer.patch', 'viewer-package.json', 'viewer-package-lock.json']) await writeFile(join(root, 'deploy', file), file);
  await writeFile(join(root, 'mine-ai-mcp', 'bot.txt'), 'frozen bot');
  await writeFile(join(root, 'private.txt'), 'should not be shipped');
  const script = fileURLToPath(new URL('../deploy/modal_release.py', import.meta.url));
  const program = `import importlib.util,io,sys,tarfile\nspec=importlib.util.spec_from_file_location('release',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\ndata,digest=m.build_context(sys.argv[2],'a'*40)\nt=tarfile.open(fileobj=io.BytesIO(data));print(t.extractfile('deploy/mine-ai-source/bot.txt').read().decode());print(t.extractfile('deploy/mine-ai-source.commit').read().decode().strip());print('private.txt' in t.getnames());print(len(digest))`;
  const result = execFileSync('python3', ['-c', program, script, root], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(result, ['frozen bot', 'a'.repeat(40), 'False', '64']);
});
