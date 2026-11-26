import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function createDependencyInstaller({ output, run = execute }) {
  const pending = new Map();
  return async ({ path }) => {
    const [pkg, lock] = await Promise.all([readFile(join(path, 'package.json')), readFile(join(path, 'package-lock.json'))]);
    const digest = createHash('sha256').update(`${pkg.length}:`).update(pkg).update(lock).digest('hex');
    const destination = join(output, digest);
    if (!pending.has(digest)) {
      const operation = (async () => {
        try { await access(join(destination, '.ready')); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await mkdir(output, { recursive: true, mode: 0o700 });
        const temporary = join(output, `.building-${randomUUID()}`);
        await mkdir(temporary, { mode: 0o700 });
        try {
          await Promise.all([writeFile(join(temporary, 'package.json'), pkg), writeFile(join(temporary, 'package-lock.json'), lock)]);
          await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: temporary, timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
          await writeFile(join(temporary, '.ready'), digest, { mode: 0o600 });
          try { await rename(temporary, destination); } catch (error) {
            if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
            await access(join(destination, '.ready'));
          }
        } finally { await rm(temporary, { recursive: true, force: true }); }
      })();
      pending.set(digest, operation);
      operation.finally(() => pending.delete(digest)).catch(() => {});
    }
    await pending.get(digest);
    const link = join(path, 'node_modules');
    const target = join(destination, 'node_modules');
    try { await symlink(target, link, 'dir'); } catch (error) {
      if (error.code !== 'EEXIST' || await readlink(link).catch(() => '') !== target) throw error;
    }
  };
}

export function createModalPython({ directory, requirements, run = execute }) {
  let pending;
  return async () => {
    if (!pending) pending = (async () => {
      const python = join(directory, 'bin', 'python');
      const check = async () => run(python, ['-c', 'import modal; assert modal.__version__ == "1.6.4"'], { timeout: 15_000 });
      try { await check(); return python; } catch {}
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await run('python3', ['-m', 'venv', directory], { timeout: 60_000 });
      await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
      await check();
      return python;
    })().catch(error => { pending = undefined; throw error; });
    return pending;
  };
}
