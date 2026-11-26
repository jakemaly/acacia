import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const runId = /^[a-f0-9]{12}$/;
const exec = promisify(execFile);
const image = 'minecraft-mine-ai:acacia-fork-compat';

export async function recoverInterruptedRecordings(root) {
  const entries = await readdir(root, { withFileTypes: true });
  let recovered = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !runId.test(entry.name)) continue;
    const directory = join(root, entry.name, 'recording');
    let directoryInfo;
    try {
      directoryInfo = await lstat(directory);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      console.error(`[recording] Could not inspect ${entry.name}: ${error.message}`);
      continue;
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) continue;

    try {
      const destination = join(directory, 'recording.webm');
      const partial = join(directory, 'recording.part.webm');
      const incompleteEncode = join(directory, 'recording.part.webm.final.webm');
      const temporary = join(directory, 'recording.recovery.webm');
      const statusPath = join(directory, 'recording.json');
      const status = await readRecordingStatus(statusPath);
      const completedInfo = await regularFile(destination);
      if (completedInfo && status.state === 'complete') {
        await Promise.all([
          rm(partial, { force: true }),
          rm(incompleteEncode, { force: true }),
          rm(temporary, { force: true }),
        ]);
        continue;
      }
      if (!completedInfo) {
        const partialInfo = await regularFile(partial);
        if (!partialInfo || partialInfo.size === 0) continue;
        await rm(temporary, { force: true });
        await runImageTool(directory, 'ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', '/recording/recording.part.webm',
          '-map', '0:v:0', '-c:v', 'copy', '/recording/recording.recovery.webm',
        ]);
        const probe = await runImageTool(directory, 'ffprobe', [
          '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1',
          '/recording/recording.recovery.webm',
        ]);
        if (!(Number(probe.stdout.trim()) > 0)) throw new Error('Recovered WebM has no readable duration.');
        await rename(temporary, destination);
      }

      const finishedAt = status.finishedAt ?? (completedInfo?.mtime ?? new Date()).toISOString();
      const updated = {
        ...status,
        state: 'complete',
        filename: 'recording.webm',
        finishedAt,
        updatedAt: new Date().toISOString(),
        recovered: true,
      };
      const statusTemporary = join(directory, 'recording.json.tmp');
      await rm(statusTemporary, { force: true });
      await writeFile(statusTemporary, `${JSON.stringify(updated, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(statusTemporary, statusPath);
      await Promise.all([
        rm(partial, { force: true }),
        rm(incompleteEncode, { force: true }),
        rm(temporary, { force: true }),
      ]);
      recovered++;
    } catch (error) {
      console.error(`[recording] Could not recover ${entry.name}: ${error.message}`);
      await rm(join(directory, 'recording.recovery.webm'), { force: true }).catch(() => {});
    }
  }
  if (recovered) console.info(`[recording] Recovered ${recovered} interrupted WebM recording${recovered === 1 ? '' : 's'}.`);
}

async function readRecordingStatus(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    return JSON.parse(await file.readFile('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  } finally {
    await file?.close();
  }
}

async function regularFile(path) {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink() && info.size > 0 ? info : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function runImageTool(directory, command, args) {
  const mount = `type=bind,source=${directory},target=/recording`;
  return exec('docker', [
    'run', '--rm', '--pull=never', '--network=none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
    '--cap-drop=ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
    '--user', `${process.getuid()}:${process.getgid()}`, '--mount', mount, '--entrypoint', command, image, ...args,
  ], { timeout: 180_000, maxBuffer: 1024 * 1024 });
}

export async function serveRecording(root, id, request, response) {
  if (!runId.test(id ?? '')) return sendError(response, 400, 'Invalid run ID.');

  let file;
  try {
    file = await open(join(root, id, 'recording', 'recording.webm'), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ELOOP') return sendError(response, 404, 'Recording unavailable.');
    throw error;
  }

  const info = await file.stat();
  if (!info.isFile() || info.size === 0) {
    await file.close();
    return sendError(response, 404, 'Recording unavailable.');
  }

  const range = request.method === 'HEAD' ? undefined : parseRange(request.headers.range, info.size);
  if (range === null) {
    await file.close();
    response.writeHead(416, { 'accept-ranges': 'bytes', 'content-range': `bytes */${info.size}` });
    return response.end();
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? info.size - 1;
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-length': end - start + 1,
    'content-type': 'video/webm',
    'x-content-type-options': 'nosniff',
  };
  if (range) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
  response.writeHead(range ? 206 : 200, headers);

  if (request.method === 'HEAD') {
    await file.close();
    return response.end();
  }

  const stream = file.createReadStream({ start, end, autoClose: true });
  response.once('close', () => stream.destroy());
  stream.on('error', error => response.destroy(error));
  stream.pipe(response);
}

export function parseRange(value, size) {
  if (!value) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;

  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function sendError(response, status, error) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' });
  response.end(JSON.stringify({ error }));
}
