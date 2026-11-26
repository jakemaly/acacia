import { setTimeout as delay } from 'node:timers/promises';

// The launcher owns one generation at a time, so late completions cannot revive a stopped batch.
export function createBatch({ startRun, reviewDeath, onChange = () => {}, retryDelay = failures => delay(1000 * 2 ** (failures - 1)) }) {
  let state = 'idle';
  let slots = [];
  let retiring = [], resizing = false;
  let generation = 0;
  let hardcore = true;
  let detail;
  const batch = {
    reviewDeath,
    status() {
      return { state, detail, hardcore, slots: slots.map(({ index, run, failures, reviewError }) => ({
        index, failures, reviewError, run: run && {
          id: run.id, runKey: run.runKey, workerId: run.workerId, workerCreatedAt: run.workerCreatedAt, release: run.release, startedAt: run.startedAt, pauseReason: run.pauseReason,
          state: run.state, detail: run.detail, seed: run.seed, hardcore: run.hardcore,
          player: run.player, activity: run.activity, decision: run.decision, viewer: run.viewer,
          death: run.death, parent: run.parent,
        },
      })) };
    },
    async start(options = {}) {
      if (state === 'running' || state === 'stopping') throw new Error('A batch is already active.');
      const count = options.count ?? 4;
      if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error('Choose between 1 and 64 runs.');
      if (options.resumeSlots && (!Array.isArray(options.resumeSlots) || options.resumeSlots.length !== count)) throw new Error('Invalid saved batch slots.');
      hardcore = options.hardcore !== false;
      detail = undefined;
      state = 'running';
      const current = ++generation;
      slots = Array.from({ length: count }, (_, index) => ({ index, failures: 0, run: undefined }));
      for (const slot of slots) launch(slot, undefined, current, options.resumeSlots?.[slot.index]);
      onChange(batch.status());
    },
    async stop() { await finish('stopped'); },
    async pause(reason) { await finish('paused', reason); },
    async resize(count) {
      if (state !== 'running' || resizing) throw new Error('A running batch is required to change the world count.');
      if (!Number.isSafeInteger(count) || count < 1 || count > 64) throw new Error('Choose between 1 and 64 runs.');
      resizing = true;
      try {
        if (count < slots.length) {
          const removed = slots.splice(count);
          retiring.push(...removed);
          onChange(batch.status());
          const results = await Promise.allSettled(removed.map(slot => Promise.resolve().then(() => slot.run?.stop?.())));
          retiring = retiring.filter(slot => !removed.includes(slot));
          const failed = results.find(result => result.status === 'rejected');
          if (failed) {
            await finish('paused', `Could not stop a removed worker: ${failed.reason?.message ?? String(failed.reason)}`);
            throw new Error('Could not stop a removed worker; the batch was paused.');
          }
        } else {
          while (slots.length < count && state === 'running') {
            const slot = { index: slots.length, failures: 0, run: undefined };
            slots.push(slot);
            launch(slot, undefined, generation);
          }
        }
        onChange(batch.status());
      } finally { resizing = false; }
    },
  };

  async function finish(next, reason) {
    if (state !== 'running') return;
    ++generation;
    state = 'stopping';
    detail = reason;
    onChange(batch.status());
    const results = await Promise.allSettled([...slots, ...retiring].map(slot => Promise.resolve().then(() => slot.run?.stop?.())));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) {
      state = 'paused';
      detail = `Could not stop every worker: ${failed.reason?.message ?? String(failed.reason)}`;
    } else if (state === 'stopping') state = next;
    onChange(batch.status());
  }

  function launch(slot, parent, current, resume) {
    if (state !== 'running' || generation !== current || !slots.includes(slot)) return;
    try {
      const run = startRun({ slot: slot.index, parent, hardcore, ...(resume && { resume }) });
      slot.run = run;
      onChange(batch.status());
      Promise.resolve(run.done).then(() => settled(slot, run, current), error => {
        run.state = 'incomplete';
        run.detail = error.message;
        return settled(slot, run, current);
      }).catch(error => finish('paused', error.message));
    } catch (error) {
      slot.run = { state: 'incomplete', detail: error.message };
      void settled(slot, slot.run, current).catch(failure => finish('paused', failure.message));
    }
  }

  async function settled(slot, run, current) {
    if (state !== 'running' || generation !== current || slot.run !== run || !slots.includes(slot)) return;
    onChange(batch.status());
    if (run.state === 'won') return finish('won', `Run ${run.id} defeated the dragon.`);
    if (run.state === 'paused') return finish('paused', run.detail ?? 'A run needs attention.');
    if (run.state === 'dead' && hardcore) {
      slot.failures = 0;
      try {
        await batch.reviewDeath?.(run);
        slot.reviewError = undefined;
      } catch (error) {
        slot.reviewError = error.message;
      }
      return launch(slot, run.id, current);
    }
    if (run.state === 'incomplete') {
      if (++slot.failures >= 3) return finish('paused', `Slot ${slot.index + 1} failed three times: ${run.detail ?? 'run incomplete'}`);
      await retryDelay(slot.failures);
      return launch(slot, run.id, current);
    }
    // A completed Survival run or unexpected stop is not a new attempt.
  }
  return batch;
}
