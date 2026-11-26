import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const git = promisify(execFile);
const sources = ['src', 'web', 'deploy', 'mine-ai-mcp', 'scripts', 'fixtures', 'package.json', 'package-lock.json'];

export async function snapshotRelease({ repo, output }) {
  repo = resolve(repo);
  output = resolve(output);
  const args = { cwd: repo, maxBuffer: 32 * 1024 * 1024 };
  const [{ stdout: files }, { stdout: revision }, { stdout: changes }] = await Promise.all([
    git('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...sources], args),
    git('git', ['rev-parse', 'HEAD'], args),
    git('git', ['status', '--porcelain', '--untracked-files=all', '--', ...sources], args),
  ]);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const temporary = join(output, `.building-${randomUUID()}`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    const hash = createHash('sha256');
    for (const path of [...new Set(files.split('\0').filter(Boolean))].sort()) {
      const name = basename(path);
      if (/^\.env(?:\.|$)/i.test(name) || /^(?:auth|credentials)\.json$/i.test(name) || /\.(?:pem|key)$/i.test(name)) continue;
      const source = join(repo, path);
      let info;
      try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      // A symlink can point outside the checkout or into an ignored credential directory.
      if (!info.isFile()) throw new Error(`Release source is not a regular file: ${path}`);
      const content = await readFile(source);
      const mode = info.mode & 0o111 ? 0o755 : 0o644;
      hash.update(`${Buffer.byteLength(path)}:${path}:${mode}:${content.length}:`);
      hash.update(content);
      const destination = join(temporary, path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, content, { mode });
      await chmod(destination, mode);
    }
    const digest = hash.digest('hex');
    const destination = join(output, digest);
    try { await rename(temporary, destination); } catch (error) {
      if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
    }
    return { path: destination, digest, commit: revision.trim(), workingTree: changes.trim() ? 'dirty' : 'clean' };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
