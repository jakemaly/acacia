import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createBatch } from './batch.mjs';
import { modalArtifactStream, restoreModalSession } from './modal-artifacts.mjs';
import { evaluateBudget } from './modal-budget.mjs';
import { modalControl } from './modal-client.mjs';
import { createReleaseManager } from './modal-release.mjs';
import { startVersionedModalRun } from './modal-versioned-run.mjs';
import { createDependencyInstaller, createModalPython } from './modal-setup.mjs';
import { piSessionFile } from './history.mjs';
import { deathReview, reflectDeath, writeReflection } from './primitives.mjs';

export async function createModalBatchService({ root, repo, agentDir, pollMs = 60_000, retryMs = 60_000, control: suppliedControl,
  startRun: suppliedStart, releaseManager: suppliedReleases, reviewDeath: suppliedReview, restoreSession: suppliedRestore, budgetVerified } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const ensurePython = createModalPython({ directory: join(root, 'modal-python'), requirements: join(repo, 'deploy/modal-requirements.txt') });
  const control = suppliedControl ?? (async request => modalControl(request, {
    python: await ensurePython(), script: join(repo, 'deploy/modal_control.py'),
  }));
  const releases = suppliedReleases ?? createReleaseManager({ repo, output: join(root, 'modal-releases'),
    install: createDependencyInstaller({ output: join(root, 'modal-releases', 'dependencies') }),
    build: (release, baseImageId) => control({ command: 'build', ...release, ...(baseImageId && { baseImageId }) }),
  });
  const activeRuns = new Map();
  const statePath = join(root, 'modal-batch.json');
  let desiredCount = 0, hardcore = true, budget, pauseKind, autoResume = false, resumeAfter = 0;
  let writing = Promise.resolve(), writeError, timer, checking = false, resizing = false, closed = false, generation = 0;
  let saved;
  try { saved = JSON.parse(await readFile(statePath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const persist = snapshot => {
    const payload = JSON.stringify({ ...snapshot, desiredCount, hardcore, pauseKind, autoResume, resumeAfter }, null, 2);
    writing = writing.catch(() => {}).then(async () => {
      const temp = `${statePath}.${randomUUID()}.tmp`;
      try { await writeFile(temp, payload, { mode: 0o600 }); await rename(temp, statePath); }
      finally { await rm(temp, { force: true }); }
    }).catch(error => { writeError = error; throw error; });
    return writing;
  };
  let batch;
  const changed = snapshot => {
    if (snapshot.state === 'paused' && snapshot.detail?.startsWith('Could not stop every worker:')) {
      pauseKind = 'cleanup';
      autoResume = false;
    }
    if (snapshot.state === 'paused' && !pauseKind) {
      pauseKind = snapshot.slots.some(slot => slot.run?.pauseReason === 'rollover') ? 'rollover'
        : snapshot.slots.some(slot => slot.run?.state === 'paused') ? 'provider' : 'failure';
      autoResume = pauseKind === 'provider' || pauseKind === 'rollover';
      resumeAfter = Date.now() + (pauseKind === 'rollover' ? 0 : 15 * 60_000);
    }
    void persist(snapshot).catch(() => {
      if (batch?.status().state === 'running') void batch.pause('Could not persist the batch state.');
    });
  };
  batch = createBatch({
    onChange: changed,
    startRun({ hardcore: mode, parent, resume }) {
      const options = { root, agentDir, hardcore: mode, parent, ...(resume ?? {}),
        onChange: () => persist(batch.status()) };
      const run = suppliedStart ? suppliedStart(options) : startVersionedModalRun(options, { releaseManager: releases, control });
      activeRuns.set(run.id, run);
      return run;
    },
    async reviewDeath(run) {
      if (suppliedReview) return suppliedReview(run);
      const directory = join(root, run.id);
      let reflection;
      try { reflection = deathReview(await reflectDeath({ directory, death: run.death, agentDir, signal: AbortSignal.timeout(90_000) })); }
      catch (error) { reflection = { error: error.message }; }
      await writeReflection(directory, reflection);
      if (run.runKey) await control({ command: 'write-reflection', runKey: run.runKey, runId: run.id, reflection });
    },
  });

  async function budgetCheck(count, pilotStats) {
    const verified = budgetVerified ?? await readFile(join(root, 'modal-budget-verified.json'), 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (verified !== true && verified?.workspaceSpendLimitUsd !== 0) {
      throw new Error('The $0 Modal out-of-pocket spend limit has not been verified. Set it in Modal Usage & Billing before starting.');
    }
    const sample = await control({ command: 'budget' });
    budget = evaluateBudget({ sample, activeWorkers: count, pilotStats });
    if (!budget.allowed) throw new Error(budget.reason);
    return budget;
  }
  async function resumeSlots(snapshot) {
    return Promise.all(snapshot.slots.map(async slot => {
      const run = slot.run;
      if (!run?.id || !run.runKey || !run.release || ['dead', 'won', 'incomplete'].includes(run.state)) return undefined;
      const directory = join(root, run.id);
      const session = await piSessionFile(directory).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
      let sessionPath = session && join(directory, session);
      if (!sessionPath && run.startedAt) {
        if (suppliedRestore) sessionPath = await suppliedRestore({ runKey: run.runKey, runId: run.id }, directory);
        else {
          const python = await ensurePython();
          sessionPath = await restoreModalSession({ runKey: run.runKey, runId: run.id }, directory,
            { list: control, stream: request => modalArtifactStream(request, { python, script: join(repo, 'deploy/modal_control.py') }) });
        }
        if (!sessionPath) throw new Error(`Cannot resume ${run.id}: its Pi session is unavailable.`);
      }
      return { id: run.id, runKey: run.runKey, release: run.release, workerId: run.workerId, workerCreatedAt: run.workerCreatedAt, resume: true,
        ...(sessionPath && { resumeSession: sessionPath }), parent: run.parent };
    }));
  }
  async function start({ count = 4, hardcore: mode = true, restore } = {}) {
    if (['running', 'stopping'].includes(batch.status().state)) throw new Error('A Modal batch is already active.');
    const current = ++generation;
    if (writeError) throw new Error(`Cannot persist Modal batch state: ${writeError.message}`);
    await budgetCheck(count);
    if (current !== generation || closed) throw new Error('Modal batch start was cancelled.');
    desiredCount = count;
    hardcore = mode;
    autoResume = true;
    pauseKind = undefined;
    const slots = restore ? await resumeSlots(restore) : undefined;
    if (current !== generation || closed) throw new Error('Modal batch start was cancelled.');
    await batch.start({ count, hardcore, ...(slots && { resumeSlots: slots }) });
    saved = undefined;
    await persist(batch.status());
  }
  async function stop() {
    generation++;
    autoResume = false;
    pauseKind = 'operator';
    if (saved && batch.status().state === 'idle') {
      saved = { ...saved, state: 'stopped', pauseKind, autoResume: false };
      await persist(saved);
    } else {
      await batch.stop();
      await persist(batch.status());
    }
  }
  async function resize(count) {
    if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error('Choose between 1 and 64 runs.');
    if (batch.status().state !== 'running' || resizing) throw new Error('A running batch is required to change the world count.');
    resizing = true;
    try {
      await budgetCheck(count);
      if (batch.status().state !== 'running') throw new Error('The batch stopped while checking its budget.');
      desiredCount = count;
      try { await batch.resize(count); }
      catch (error) { desiredCount = batch.status().slots.length; await persist(batch.status()); throw error; }
      await persist(batch.status());
    } finally { resizing = false; }
  }
  async function check() {
    if (checking || closed) return;
    checking = true;
    try {
      const current = batch.status();
      if (current.state === 'idle' && autoResume && saved?.slots?.length && Date.now() >= resumeAfter) {
        try { await start({ count: desiredCount, hardcore, restore: saved }); }
        catch (error) { resumeAfter = Date.now() + retryMs; budget = { allowed: false, reason: error.message }; }
      } else if (current.state === 'running') {
        try {
          let stats;
          if (desiredCount === 4 && current.slots.length === 4 && current.slots.every(slot => slot.run?.workerId &&
              slot.run.state === 'running' && Date.now() - slot.run.startedAt >= 15 * 60_000)) {
            stats = await Promise.all(current.slots.map(slot => control({ command: 'stats', sandboxId: slot.run.workerId })));
          }
          await budgetCheck(desiredCount, stats);
        } catch (error) {
          pauseKind = /pilot exceeds/i.test(error.message) ? 'pilot' : 'budget';
          autoResume = pauseKind !== 'pilot';
          resumeAfter = Date.now() + retryMs;
          await batch.pause(error.message);
        }
      } else if (current.state === 'paused' && autoResume && Date.now() >= resumeAfter) {
        try { await start({ count: desiredCount, hardcore, restore: current }); }
        catch (error) { resumeAfter = Date.now() + retryMs; budget = { allowed: false, reason: error.message }; }
      }
    } finally { checking = false; }
  }
  if (saved) {
    desiredCount = saved.desiredCount;
    hardcore = saved.hardcore;
    pauseKind = saved.pauseKind;
    autoResume = Boolean(saved.autoResume) && ['running', 'starting', 'saving', 'paused', 'stopping'].includes(saved.state);
    resumeAfter = saved.resumeAfter ?? 0;
  }
  if (pollMs > 0) { timer = setInterval(() => { void check().catch(error => { budget = { allowed: false, reason: error.message }; }); }, pollMs); timer.unref(); }
  return {
    start, stop, resize, check,
    control, getPython: ensurePython,
    async resume() { await start({ count: desiredCount, hardcore, restore: saved ?? batch.status() }); },
    status() { return { ...(batch.status().state === 'idle' && saved ? saved : batch.status()), budget, desiredCount, pauseKind, autoResume }; },
    getRun(id) { return activeRuns.get(id); },
    async recover() { if (autoResume && saved?.slots?.length) await start({ count: desiredCount, hardcore, restore: saved }); },
    async close() { closed = true; generation++; clearInterval(timer); if (batch.status().state === 'running') { pauseKind = 'host'; autoResume = true; await batch.pause('Acacia service stopped.'); } await persist(batch.status().state === 'idle' && saved ? saved : batch.status()); },
  };
}
