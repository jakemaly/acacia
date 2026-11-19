import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer-core';

const browserArgs = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--renderer-process-limit=2',
  '--num-raster-threads=2',
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
];
const framesPerSecond = 15;

async function waitForViewer(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const ready = response.ok;
      await response.body?.cancel();
      if (ready) return;
    } catch {}
    await delay(250);
  }
  throw new Error('The Prismarine viewer did not start listening for Chromium.');
}

async function finalizeWebm(filename, frameRate) {
  const output = `${filename}.final.webm`;
  const encoder = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', filename,
    '-map', '0:v:0', '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8',
    '-b:v', '1500k', '-r', String(frameRate), '-g', String(frameRate * 2), '-pix_fmt', 'yuv420p', output,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  encoder.stderr.on('data', chunk => { log = `${log}${chunk}`.slice(-2000); });
  try {
    const [code, signal] = await once(encoder, 'close');
    if (code !== 0) throw new Error(`FFmpeg could not finalize WebM (code ${code ?? signal ?? 'unknown'}). ${log.trim()}`);
    await rename(output, filename);
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  }
}

export async function createBrowserRecording({ output, width, height, url }) {
  const recorder = new EventEmitter();
  const file = createWriteStream(output, { flags: 'wx', mode: 0o600 });
  let browser;
  let page;
  let initialized = false;
  let closingBrowser = false;
  let closed = false;
  let setupError;
  let browserExit = 'exit status unavailable';
  let browserLog = '';
  let stopRequested = false;
  let recorderStopped = false;
  let chunkCount = 0;
  let writes = Promise.resolve();
  let finishing;

  function fail(reason) {
    if (!initialized) {
      setupError ??= reason;
      return;
    }
    if (closed) return;
    closed = true;
    const error = reason instanceof Error ? reason : new Error(String(reason));
    file.destroy();
    void browser?.close().catch(() => {});
    if (recorder.listenerCount('error')) recorder.emit('error', error);
    recorder.emit('close', 1, null);
  }

  file.on('error', fail);

  try {
    await once(file, 'open');
    await waitForViewer(url);
    browser = await puppeteer.launch({
      headless: true,
      executablePath: '/usr/bin/chromium',
      args: browserArgs,
      protocolTimeout: 30_000,
    });
    const process = browser.process();
    process?.once('exit', (code, signal) => {
      browserExit = `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`;
    });
    process?.stderr?.on('data', chunk => {
      browserLog = `${browserLog}${chunk}`.slice(-1500);
    });
    browser.on('disconnected', () => {
      if (!closingBrowser && !closed) {
        const details = browserLog.trim();
        fail(new Error(`Chromium disconnected during the recording (${browserExit}; stop requested=${stopRequested}; recorder stopped=${recorderStopped}; chunks=${chunkCount}).${details ? ` ${details}` : ''}`));
      }
    });
    page = await browser.newPage();
    page.on('pageerror', fail);
    page.on('error', fail);
    page.once('close', () => {
      if (!closingBrowser && !closed) fail(new Error('The Chromium viewer page closed during recording.'));
    });
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(fps => {
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = callback => window.setTimeout(() => requestFrame(callback), 1000 / fps);
    }, framesPerSecond);
    await page.exposeFunction('writeRecordingChunk', encoded => {
      const chunk = Buffer.from(encoded, 'base64');
      chunkCount++;
      writes = writes.then(() => new Promise((resolve, reject) => {
        file.write(chunk, error => error ? reject(error) : resolve());
      }));
      return writes;
    });
    await page.exposeFunction('reportRecordingError', message => fail(new Error(message)));
    await page.exposeFunction('finishRecordingChunks', () => {
      recorderStopped = true;
      finishing ??= (async () => {
        try {
          await writes;
          file.end();
          await finished(file);
          closingBrowser = true;
          await finalizeWebm(output, framesPerSecond);
          if (!closed) {
            closed = true;
            recorder.emit('close', 0, null);
          }
          await browser.close();
        } catch (error) {
          fail(error);
        }
      })();
      return finishing;
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas');
      return canvas && canvas.width > 0 && canvas.height > 0 && typeof canvas.captureStream === 'function';
    }, { timeout: 30_000 });
    await page.evaluate(({ width, height, fps }) => {
      const canvas = document.querySelector('canvas');
      if (canvas.width !== width || canvas.height !== height) {
        throw new Error(`Viewer canvas is ${canvas.width}x${canvas.height}, expected ${width}x${height}.`);
      }
      const mimeType = [
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9',
        'video/webm',
      ].find(type => MediaRecorder.isTypeSupported(type));
      if (!mimeType) throw new Error('Chromium does not support WebM recording.');

      const stream = canvas.captureStream(fps);
      const mediaRecorder = new MediaRecorder(stream, { mimeType });
      let pending = Promise.resolve();
      mediaRecorder.addEventListener('dataavailable', event => {
        if (event.data.size === 0) return;
        pending = pending.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          let binary = '';
          for (const byte of bytes) binary += String.fromCharCode(byte);
          await window.writeRecordingChunk(btoa(binary));
        }).catch(error => window.reportRecordingError(error.message));
      });
      mediaRecorder.addEventListener('error', event => {
        window.reportRecordingError(event.error?.message ?? 'Chromium MediaRecorder failed.');
      });
      mediaRecorder.addEventListener('stop', async () => {
        await pending;
        stream.getTracks().forEach(track => track.stop());
        await window.finishRecordingChunks();
      }, { once: true });
      window.__mineAiRecording = mediaRecorder;
      mediaRecorder.start(1000);
    }, { width, height, fps: framesPerSecond });

    initialized = true;
    if (setupError) throw setupError;
    recorder.stopCapture = () => {
      stopRequested = true;
      return page.evaluate(() => {
        if (window.__mineAiRecording?.state === 'recording') window.__mineAiRecording.stop();
      }).catch(error => {
        fail(error);
        throw error;
      });
    };
    return recorder;
  } catch (error) {
    initialized = false;
    closed = true;
    file.destroy();
    await browser?.close().catch(() => {});
    throw setupError ?? error;
  }
}
