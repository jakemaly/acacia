import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'undici';

const artifactName = /^(?:activity\.jsonl|result\.json|reflection\.json|reflection-evidence\.json|\d{4}-\d\d-\d\dT[\d-Z]+_[a-f0-9-]+\.jsonl)$/i;

export async function workerRequest(worker, path, { method = 'GET', body, signal, timeoutMs = 15_000 } = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Expected a relative worker path.');
  const base = new URL(worker.url);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Error('Modal worker requires HTTPS.');
  }
  if (!worker.token) throw new Error('Modal worker connection token is missing.');
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('Expected a relative worker path.');
  const response = await fetch(target, {
    method, redirect: 'error',
    headers: { authorization: `Bearer ${worker.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
    ...(body !== undefined && { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Modal worker request failed (HTTP ${response.status}).`);
  return response.json();
}

export async function uploadWorkerFile(worker, path, name) {
  if (!artifactName.test(name)) throw new Error('Invalid artifact name.');
  const base = new URL(worker.url);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) {
    throw new Error('Modal worker requires HTTPS.');
  }
  if (!worker.token) throw new Error('Modal worker connection token is missing.');
  const file = await open(path, 'r');
  try {
    let length = (await file.stat()).size;
    if (length > 512 * 1024 * 1024) throw new Error('Artifact exceeds size limit.');
    if (name.endsWith('.jsonl')) {
      // A session may be appended while it is copied; preserve complete records only.
      let cursor = length, boundary = 0;
      while (cursor > 0) {
        const size = Math.min(cursor, 64 * 1024);
        const bytes = Buffer.alloc(size);
        const { bytesRead } = await file.read(bytes, 0, size, cursor - size);
        const newline = bytes.subarray(0, bytesRead).lastIndexOf(10);
        if (newline >= 0) { boundary = cursor - size + newline + 1; break; }
        cursor -= size;
      }
      length = boundary;
    }
    const response = await httpRequest(new URL(`/archive/${name}`, base), {
      method: 'PUT', headers: { authorization: `Bearer ${worker.token}`, 'content-length': String(length) },
      body: length ? file.createReadStream({ start: 0, end: length - 1, autoClose: false }) : '',
      headersTimeout: 120_000, bodyTimeout: 120_000,
    });
    await response.body.dump();
    if (response.statusCode !== 200) throw new Error(`Artifact upload failed (HTTP ${response.statusCode}).`);
  } finally { await file.close(); }
}

export function modalControl(request, { python = 'python3', script = fileURLToPath(new URL('../deploy/modal_control.py', import.meta.url)),
  signal, timeoutMs = 1_900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'], signal, timeout: timeoutMs });
    let output = '', errors = '', failure;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1_000_000) { failure = new Error('Modal control returned too much data.'); child.kill(); }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => { failure = error; });
    child.on('close', code => {
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(`Modal control failed: ${errors.trim() || `exit ${code}`}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Modal control returned invalid JSON.')); }
    });
    child.stdin.on('error', error => { failure ??= error; });
    child.stdin.end(JSON.stringify(request));
  });
}
