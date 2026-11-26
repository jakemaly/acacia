import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createReleaseManager } from '../src/modal-release.mjs';

test('concurrent slots share a build and a changed release never falls back to the old image', async t => {
  const root = await mkdtemp(join(tmpdir(), 'acacia-modal-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let digest = 'a'.repeat(64), builds = 0, fail = false;
  const manager = createReleaseManager({ output: root,
    snapshot: async () => ({ digest, path: root, commit: 'b'.repeat(40), workingTree: 'dirty' }),
    install: async () => {},
    build: async release => { builds++; if (fail) throw new Error('build failed'); return { imageId: `im-${release.digest.slice(0, 8)}`, sourceDigest: release.digest }; },
  });
  const [one, two] = await Promise.all([manager.prepare(), manager.prepare()]);
  assert.equal(builds, 1);
  assert.equal(one.imageId, two.imageId);
  digest = 'c'.repeat(64);
  fail = true;
  await assert.rejects(manager.prepare(), /build failed/);
  fail = false;
  const updated = await manager.prepare();
  assert.equal(updated.sourceDigest, 'c'.repeat(64));
  assert.notEqual(updated.imageId, one.imageId);
});
