import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { modalControl, uploadWorkerFile, workerRequest } from './modal-client.mjs';
import { proxyViewerHttp, proxyViewerUpgrade } from './modal-viewer.mjs';

export function startModalRun(config, { releaseManager, control = modalControl, request = workerRequest, play,
  upload = uploadWorkerFile, pollMs = 2000, heartbeatMs = 10_000, archiveMs = 60_000, rolloverMs = 23.75 * 60 * 60_000 } = {}) {
  const id = config.id ?? randomUUID().replaceAll('-', '').slice(0, 12);
  const runKey = config.runKey ?? randomUUID().replaceAll('-', '');
  if (!/^[a-f0-9]{12}$/.test(id) || !/^[a-f0-9]{24,64}$/.test(runKey)) throw new Error('Invalid remote run identity.');
  const directory = join(config.root, id);
  const abort = new AbortController();
  let operatorStopped = false, cleanupFailure;
  let worker;
  const run = { id, runKey, hardcore: Boolean(config.hardcore), parent: config.parent, state: 'starting', activity: [],
    async stop() { operatorStopped = true; abort.abort(); await run.done; if (cleanupFailure) throw cleanupFailure; },
    proxyViewer(req, res) { if (worker && run.state === 'running') void proxyViewerHttp(worker, req, res); else res.writeHead(503).end(); },
    proxyViewerUpgrade(req, socket, head) { if (worker && run.state === 'running') proxyViewerUpgrade(worker, req, socket, head); else socket.destroy(); },
  };
  const record = (type, payload) => {
    const event = { time: new Date().toISOString(), type, ...payload };
    appendFileSync(join(directory, 'activity.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 });
    run.activity = [...run.activity.slice(-79), event];
    if (payload.decision) run.decision = payload.decision;
  };
  run.done = execute();
  return run;

  async function execute() {
    let release, agent, manifestWritten = false, remoteStopped = false, failure, finalState, finalDetail;
    let heartbeatTimer, heartbeatBusy = false, archiveTimer, archivePending, rolloverTimer, rollover = false;
    const archive = () => {
      if (!worker) return Promise.resolve();
      if (archivePending) return archivePending;
      const pending = (async () => {
        const names = (await readdir(directory)).filter(name => /^(?:activity\.jsonl|reflection-evidence\.json|\d{4}-\d\d-\d\dT[\d-Z]+_[a-f0-9-]+\.jsonl)$/i.test(name));
        for (const name of names) await upload(worker, join(directory, name), name);
      })();
      archivePending = pending;
      void pending.finally(() => { if (archivePending === pending) archivePending = undefined; }).catch(() => {});
      return pending;
    };
    const heartbeat = async () => {
      if (heartbeatBusy || !worker) return;
      heartbeatBusy = true;
      try { await request(worker, '/heartbeat', { method: 'POST', body: {}, timeoutMs: 10_000 }); }
      catch (error) { try { record('worker_heartbeat_error', { error: error.message }); } catch {} }
      finally { heartbeatBusy = false; }
    };
    try {
      await mkdir(directory, { recursive: Boolean(config.resume), mode: 0o700 });
      release = config.release ?? await releaseManager.prepare();
      run.release = { digest: release.digest, imageId: release.imageId, path: release.path };
      await config.onChange?.();
      abort.signal.throwIfAborted();
      let attached = false;
      if (config.workerId) {
        const recovered = await control({ command: 'recover', sandboxId: config.workerId });
        if (recovered.alive) { worker = recovered; attached = true; }
      }
      worker ??= await control({ command: 'create', imageId: release.imageId, runKey });
      run.workerId = worker.sandboxId;
      run.workerCreatedAt = attached ? config.workerCreatedAt ?? Date.now() : Date.now();
      rolloverTimer = setTimeout(() => { rollover = true; abort.abort(); }, Math.max(0, rolloverMs - (Date.now() - run.workerCreatedAt)));
      rolloverTimer.unref();
      await config.onChange?.();
      heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
      heartbeatTimer.unref();
      await heartbeat();
      abort.signal.throwIfAborted();
      const existing = attached ? await request(worker, '/status', { signal: abort.signal }) : { state: 'idle' };
      const created = existing.state === 'idle' ? await request(worker, '/start', { method: 'POST', body: { id, hardcore: run.hardcore,
        resume: Boolean(config.resume), ...(run.parent && { parent: run.parent }) }, signal: abort.signal }) : existing;
      if (created.id !== id) throw new Error('Modal worker returned a different run ID.');
      let status;
      for (;;) {
        abort.signal.throwIfAborted();
        status = await request(worker, '/status', { signal: abort.signal });
        if (status.id !== id) throw new Error('Modal worker status belongs to a different run.');
        if (status.state === 'running' || ['dead', 'won', 'incomplete', 'stopped'].includes(status.state)) break;
        await delay(pollMs, undefined, { signal: abort.signal });
      }
      const terminal = status.state !== 'running';
      if (terminal) { finalState = status.state; finalDetail = status.detail; run.death = status.death; }
      const [context, manifest] = await Promise.all([
        terminal ? null : request(worker, '/context', { signal: abort.signal }), request(worker, '/manifest', { signal: abort.signal }),
      ]);
      if (manifest.id !== id || manifest.sourceDigest !== release.digest) throw new Error('Worker manifest does not match the selected release.');
      const previous = config.resume ? await readFile(join(directory, 'run.json'), 'utf8').then(JSON.parse, error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }) : null;
      const segment = status.recordingSegment?.match(/^recording\/segments\/([a-f0-9]{12})$/)?.[1];
      const recordingSegments = [...new Set([...(previous?.modal?.recordingSegments ?? []), ...(segment ? [segment] : [])])];
      await writeFile(join(directory, 'run.json.tmp'), JSON.stringify({ ...manifest,
        modal: { runKey, sandboxId: worker.sandboxId, imageId: release.imageId, sourceDigest: release.digest, recordingSegments } }, null, 2), { mode: 0o600 });
      await rename(join(directory, 'run.json.tmp'), join(directory, 'run.json'));
      manifestWritten = true;
      if (terminal) return;
      Object.assign(run, { state: 'running', startedAt: Date.now(), seed: status.seed, player: status.player, viewer: `/api/modal/viewer/${id}/` });
      await config.onChange?.();
      archiveTimer = setInterval(() => { void archive().catch(error => { try { record('archive_error', { error: error.message }); } catch {} }); }, archiveMs);
      archiveTimer.unref();
      const runPlay = play ?? (await import(pathToFileURL(join(release.path, 'src', 'pi.mjs')).href)).play;
      agent = Promise.resolve().then(() => runPlay({ directory, agentDir: config.agentDir, signal: abort.signal,
        remoteMcp: { url: new URL('/mcp', worker.url).href, token: worker.token }, record, promptText: context.prompt,
        ...(config.resumeSession && { resumeSession: config.resumeSession,
          instruction: 'The world has resumed from a saved state. First inspect view_status and any pending foreground action before choosing a new action. Do not blindly retry an action whose outcome is unknown.' }),
      })).then(value => ({ kind: 'agent', value }), error => ({ kind: 'agentError', error }));
      const monitor = (async () => {
        let failures = 0;
        for (;;) {
          await delay(pollMs, undefined, { signal: abort.signal });
          let next;
          try { next = await request(worker, '/status', { signal: abort.signal }); failures = 0; }
          catch (error) { if (abort.signal.aborted || ++failures >= 4) throw error; continue; }
          if (next.id !== id) throw new Error('Modal worker status belongs to a different run.');
          Object.assign(run, { player: next.player, death: next.death, seed: next.seed });
          if (['dead', 'won', 'incomplete', 'stopped'].includes(next.state)) return { kind: 'worker', status: next };
        }
      })();
      const result = await Promise.race([agent, monitor]);
      if (result.kind === 'worker') {
        finalState = result.status.state;
        finalDetail = result.status.detail;
        run.death = result.status.death;
      } else if (result.kind === 'agentError') {
        if (!operatorStopped && !rollover) { failure = result.error; finalState = 'paused'; }
      } else if (!operatorStopped) {
        finalState = 'incomplete';
        finalDetail = result.value ?? 'Pi ended before the world reached a terminal state.';
      }
    } catch (error) {
      if (!operatorStopped && !rollover) failure = error;
    } finally {
      run.state = 'saving';
      clearInterval(archiveTimer);
      clearTimeout(rolloverTimer);
      abort.abort();
      if (agent) await Promise.race([agent, delay(5000, undefined, { ref: false })]);
      if (worker) {
        if (manifestWritten) {
          try { await archive(); } catch (error) { failure ??= new Error(`Could not archive the Pi session: ${error.message}`); }
        }
        try {
          const stopped = await request(worker, '/stop', { method: 'POST', body: {}, timeoutMs: 120_000 });
          remoteStopped = true;
          if (stopped.state === 'won' || stopped.state === 'dead') {
            finalState = stopped.state; finalDetail = stopped.detail; run.death = stopped.death;
          }
          if (finalState === 'dead') {
            try {
              const { evidence } = await request(worker, '/reflection-evidence', { timeoutMs: 30_000 });
              await writeFile(join(directory, 'reflection-evidence.json'), JSON.stringify(evidence), { mode: 0o600 });
            } catch (error) { record('reflection_evidence_error', { error: error.message }); }
          }
        } catch (error) { cleanupFailure = new Error(`Could not save the Modal worker: ${error.message}`); failure ??= cleanupFailure; }
      }
      clearInterval(heartbeatTimer);
      if (worker && remoteStopped) {
        try { await control({ command: 'terminate', sandboxId: worker.sandboxId }); }
        catch (error) { cleanupFailure = new Error(`Could not terminate the Modal worker: ${error.message}`); failure ??= cleanupFailure; }
      }
      if (rollover && !failure && finalState !== 'won' && finalState !== 'dead') {
        finalState = 'paused'; finalDetail = 'Saving before the Modal worker time limit.'; run.pauseReason = 'rollover';
      }
      const state = finalState === 'won' || finalState === 'dead' ? finalState
        : failure ? (finalState === 'paused' ? 'paused' : 'incomplete') : operatorStopped ? 'stopped' : finalState ?? 'incomplete';
      const detail = failure ? [finalDetail, failure.message].filter(Boolean).join(' ') :
        finalDetail ?? (operatorStopped ? 'Stopped by operator.' : 'Run ended.');
      if (manifestWritten) {
        await writeFile(join(directory, 'result.json.tmp'), JSON.stringify({ state, detail, death: run.death,
          ...(failure && { cleanupError: failure.message }) }, null, 2), { mode: 0o600 });
        await rename(join(directory, 'result.json.tmp'), join(directory, 'result.json'));
      }
      Object.assign(run, { state, detail });
      await config.onChange?.();
    }
  }
}
