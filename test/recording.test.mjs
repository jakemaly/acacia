import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { attachRecording } from '../deploy/recording.mjs';

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), 'minecraft-recording-'));
}

test('records one WebM across Survival deaths and respawns, then finalizes on bot end', async () => {
  const directory = await temporaryDirectory();
  const bot = new EventEmitter();
  let starts = 0;
  let stops = 0;
  let recorder;
  try {
    const recording = attachRecording(bot, {
      directory,
      createRecorder: async ({ output }) => {
        starts++;
        await writeFile(output, 'webm');
        recorder = new EventEmitter();
        recorder.stopCapture = () => { stops++; };
        return recorder;
      },
    });

    bot.emit('spawn');
    await recording.started;
    bot.emit('death');
    bot.emit('spawn');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(stops, 0);

    bot.emit('end');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(stops, 1);
    recorder.emit('close', 0);
    await recording.done;

    assert.equal(await readFile(join(directory, 'recording.webm'), 'utf8'), 'webm');
    assert.equal((await readdir(directory)).includes('recording.part.webm'), false);
    assert.equal(JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8')).state, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('starts recording immediately when attached after Mineflayer has spawned', async () => {
  const directory = await temporaryDirectory();
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  let recorder;
  try {
    const recording = attachRecording(bot, {
      directory,
      createRecorder: async ({ output }) => {
        await writeFile(output, 'webm');
        recorder = new EventEmitter();
        recorder.stopCapture = () => {};
        return recorder;
      },
    });

    await recording.started;
    assert.equal(JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8')).state, 'recording');
    bot.emit('end');
    await new Promise(resolve => setImmediate(resolve));
    recorder.emit('close', 0);
    await recording.done;
    assert.equal(JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8')).state, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('finalizes when the run controller writes a stop request', async () => {
  const directory = await temporaryDirectory();
  const bot = new EventEmitter();
  bot.entity = { position: { x: 0, y: 64, z: 0 } };
  let recorder;
  let stops = 0;
  try {
    const recording = attachRecording(bot, {
      directory,
      createRecorder: async ({ output }) => {
        await writeFile(output, 'webm');
        recorder = new EventEmitter();
        recorder.stopCapture = () => {
          stops++;
          setImmediate(() => recorder.emit('close', 0));
        };
        return recorder;
      },
    });

    await recording.started;
    await writeFile(join(directory, 'stop.request'), '');
    await recording.done;

    assert.equal(stops, 1);
    assert.equal(await readFile(join(directory, 'recording.webm'), 'utf8'), 'webm');
    assert.equal(JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8')).state, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('recorder startup failure is recorded without throwing through the bot event', async () => {
  const directory = await temporaryDirectory();
  const bot = new EventEmitter();
  try {
    const recording = attachRecording(bot, {
      directory,
      createRecorder: () => { throw new Error('Chromium unavailable'); },
    });

    assert.doesNotThrow(() => bot.emit('spawn'));
    await recording.started;
    await recording.done;
    const status = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
    assert.equal(status.state, 'failed');
    assert.match(status.error, /Chromium unavailable/);
    assert.equal((await readdir(directory)).includes('recording.webm'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('encoder failure leaves no completed video and is recorded as a nonfatal failure', async () => {
  const directory = await temporaryDirectory();
  const bot = new EventEmitter();
  let recorder;
  try {
    const recording = attachRecording(bot, {
      directory,
      createRecorder: async ({ output }) => {
        await writeFile(output, 'partial');
        recorder = new EventEmitter();
        recorder.stopCapture = () => {};
        return recorder;
      },
    });

    bot.emit('spawn');
    await recording.started;
    bot.emit('end');
    await new Promise(resolve => setImmediate(resolve));
    recorder.emit('close', 1);
    await recording.done;

    const status = JSON.parse(await readFile(join(directory, 'recording.json'), 'utf8'));
    assert.equal(status.state, 'failed');
    assert.match(status.error, /Recorder exited with code 1/);
    assert.equal((await readdir(directory)).includes('recording.webm'), false);
    assert.equal((await readdir(directory)).includes('recording.part.webm'), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
