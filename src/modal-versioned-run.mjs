import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Each new attempt loads its controller from the same immutable release as its worker.
export function startVersionedModalRun(config, { releaseManager, control, load = async path => import(pathToFileURL(path).href) }) {
  const id = config.id ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const runKey = config.runKey ?? randomUUID().replaceAll('-', '');
  const pending = { id, runKey, hardcore: Boolean(config.hardcore), parent: config.parent, state: 'starting', activity: [] };
  pending.proxyViewer = (_req, res) => res.writeHead(503).end();
  pending.proxyViewerUpgrade = (_req, socket) => socket.destroy();
  let actual, cancelled = false;
  const run = new Proxy(pending, {
    get(target, key) { return actual && key !== 'done' && key !== 'stop' ? actual[key] : target[key]; },
    set(target, key, value) { if (actual && key !== 'done' && key !== 'stop') actual[key] = value; else target[key] = value; return true; },
  });
  pending.stop = async () => { cancelled = true; if (actual) await actual.stop(); else pending.state = 'stopped'; };
  pending.done = (async () => {
    const release = config.release ?? await releaseManager.prepare();
    if (cancelled) { pending.state = 'stopped'; return; }
    const module = await load(join(release.path, 'src/modal-run.mjs'));
    if (cancelled) { pending.state = 'stopped'; return; }
    actual = module.startModalRun({ ...config, id, runKey, release }, { releaseManager, control });
    await actual.done;
  })();
  return run;
}
