import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const filename = 'recording.webm';
const temporaryFilename = 'recording.part.webm';
const stopRequestFilename = 'stop.request';

export function attachRecording(bot, { directory, createRecorder }) {
  const output = join(directory, temporaryFilename);
  const destination = join(directory, filename);
  let recorder;
  let state = 'waiting';
  let stopping = false;
  let terminal = false;
  let recorderError;
  let encoderLog = '';
  let stopRequested = false;
  let writes = Promise.resolve();
  let resolveStarted;
  let resolveDone;
  let stopPoll;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const done = new Promise(resolve => { resolveDone = resolve; });

  let status = {
    state,
    filename,
    width: 512,
    height: 512,
    framesPerSecond: 15,
  };

  function persist(changes) {
    status = { ...status, ...changes, updatedAt: new Date().toISOString() };
    const snapshot = JSON.stringify(status, null, 2);
    writes = writes.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, 'recording.json.tmp');
      await writeFile(temporary, `${snapshot}\n`, { mode: 0o600 });
      await rename(temporary, join(directory, 'recording.json'));
    });
    return writes;
  }

  async function finishFailure(error) {
    if (terminal) return;
    terminal = true;
    clearInterval(stopPoll);
    state = 'failed';
    const failure = String(error?.message ?? error);
    try {
      await persist({ state, finishedAt: new Date().toISOString(), error: failure });
    } catch (writeError) {
      console.error(`Could not record video failure: ${writeError.message}`);
    }
    await rm(output, { force: true }).catch(() => {});
    resolveStarted(status);
    resolveDone(status);
  }

  async function finishSuccess() {
    if (terminal) return;
    try {
      await rename(output, destination);
      state = 'complete';
      try {
        await persist({ state, finishedAt: new Date().toISOString() });
      } catch (error) {
        console.error(`Could not record completed video status: ${error.message}`);
      }
      terminal = true;
      clearInterval(stopPoll);
      resolveDone(status);
    } catch (error) {
      await finishFailure(error);
    }
  }

  async function onRecorderClose(code, signal) {
    if (!stopping) {
      await finishFailure(recorderError ?? new Error('The video recorder exited before the bot run ended.'));
      return;
    }
    if (recorderError || code !== 0) {
      const detail = recorderError?.message ?? `Recorder exited with code ${code ?? signal ?? 'unknown'}`;
      await finishFailure(encoderLog ? `${detail}: ${encoderLog.trim()}` : detail);
      return;
    }
    await finishSuccess();
  }

  async function start() {
    if (state !== 'waiting') return;
    state = 'starting';
    try {
      await persist({ state, startedAt: new Date().toISOString() });
      recorder = await createRecorder({ output, frames: -1, width: 512, height: 512 });
      if (!recorder?.once || typeof recorder.stopCapture !== 'function') {
        throw new Error('The headless renderer did not return a stoppable encoder.');
      }
      recorder.once('error', error => { recorderError = error; });
      recorder.once('close', (code, signal) => { void onRecorderClose(code, signal); });
      recorder.stderr?.on('data', chunk => {
        encoderLog = `${encoderLog}${chunk}`.slice(-2000);
      });
      recorder.stdin?.on('error', error => { recorderError = error; });
      state = 'recording';
      await persist({ state });
      resolveStarted(status);
      if (stopping) void stop();
    } catch (error) {
      await finishFailure(error);
    }
  }

  async function stop() {
    if (terminal) return done;
    clearInterval(stopPoll);
    stopping = true;
    if (state === 'waiting') {
      await finishFailure(new Error('The bot ended before it spawned.'));
      return done;
    }
    if (state === 'starting') await started;
    if (terminal) return done;
    if (state === 'recording' && !stopRequested) {
      stopRequested = true;
      state = 'finalizing';
      const statusWrite = persist({ state });
      try {
        await recorder.stopCapture();
      } catch (error) {
        await finishFailure(error);
        return done;
      }
      await statusWrite.catch(error => {
        console.error(`Could not update video status: ${error.message}`);
      });
    }
    return done;
  }

  // The host installs the viewer after Mineflayer's initial spawn has settled.
  if (bot.entity) void start();
  else bot.once('spawn', () => { void start(); });
  bot.once('end', () => { void stop(); });
  let checkingStopRequest = false;
  stopPoll = setInterval(() => {
    if (checkingStopRequest || terminal) return;
    checkingStopRequest = true;
    void access(join(directory, stopRequestFilename)).then(() => stop()).catch(error => {
      if (error.code !== 'ENOENT') console.error(`Could not read video stop request: ${error.message}`);
    }).finally(() => { checkingStopRequest = false; });
  }, 200);
  stopPoll.unref?.();
  return { started, done, stop };
}
