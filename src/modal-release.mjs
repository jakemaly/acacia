import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snapshotRelease } from './release.mjs';

export function createReleaseManager({ repo, output, snapshot = () => snapshotRelease({ repo, output: join(output, 'trees') }), install, build }) {
  const pending = new Map();
  let latestImage;
  async function prepare() {
    const release = await snapshot();
    if (!/^[a-f0-9]{64}$/.test(release.digest)) throw new Error('Invalid release digest.');
    if (pending.has(release.digest)) return pending.get(release.digest);
    const operation = (async () => {
      await install(release);
      const directory = join(output, 'metadata');
      const path = join(directory, `${release.digest}.json`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let previous;
      try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (previous?.sourceDigest === release.digest && /^im-[A-Za-z0-9]+$/.test(previous.imageId ?? '')) {
        latestImage = previous.imageId;
        return { ...release, ...previous };
      }
      const built = await build(release, latestImage);
      if (built.sourceDigest !== release.digest || !/^im-[A-Za-z0-9]+$/.test(built.imageId ?? '')) {
        throw new Error('Modal returned an image for the wrong release.');
      }
      const temporary = join(directory, `.building-${randomUUID()}`);
      try {
        await writeFile(temporary, JSON.stringify(built), { mode: 0o600 });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      latestImage = built.imageId;
      return { ...release, ...built };
    })();
    pending.set(release.digest, operation);
    try { return await operation; } finally { pending.delete(release.digest); }
  }
  return { prepare };
}
