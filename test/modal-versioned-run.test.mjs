import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startVersionedModalRun } from '../src/modal-versioned-run.mjs';

test('each new attempt loads its controller from its selected release', async () => {
  let version = 0;
  const seen = [];
  const releaseManager = { async prepare() { version++; return { path: `/release/${version}`, digest: String(version), imageId: `im-${version}` }; } };
  const load = async path => ({ startModalRun(config) {
    seen.push([path, config.release.imageId, config.id, config.runKey]);
    return { ...config, state: 'won', done: Promise.resolve() };
  } });
  const first = startVersionedModalRun({ hardcore: true }, { releaseManager, load });
  await first.done;
  const second = startVersionedModalRun({ hardcore: true }, { releaseManager, load });
  await second.done;
  assert.equal(first.state, 'won');
  assert.equal(second.state, 'won');
  assert.deepEqual(seen.map(item => item.slice(0, 2)), [
    ['/release/1/src/modal-run.mjs', 'im-1'], ['/release/2/src/modal-run.mjs', 'im-2'],
  ]);
  assert.match(seen[0][2], /^[a-f0-9]{12}$/);
  assert.match(seen[0][3], /^[a-f0-9]{32}$/);
});

test('stopping while a release is building prevents a worker from starting', async () => {
  let complete, loaded = false;
  const releaseManager = { prepare: () => new Promise(resolve => { complete = resolve; }) };
  const run = startVersionedModalRun({}, { releaseManager, load: async () => { loaded = true; } });
  await run.stop();
  assert.equal(run.state, 'stopped');
  complete({ path: '/release' });
  await run.done;
  assert.equal(run.state, 'stopped');
  assert.equal(loaded, false);
});
