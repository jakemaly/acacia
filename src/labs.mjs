import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { filterStatusPlayers } from './status-privacy.mjs';

const fixtureId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const checkpointPart = /^[a-f0-9-]{36}$/;
const runId = /^[a-f0-9]{12}$/;

export async function labFixtures(directory = new URL('../fixtures/', import.meta.url)) {
  const root = directory instanceof URL ? new URL(directory) : directory;
  const entries = (await readdir(root, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  return Promise.all(entries.map(async entry => {
    const fixture = JSON.parse(await readFile(typeof root === 'string' ? join(root, entry.name) : new URL(entry.name, root), 'utf8'));
    if (!fixtureId.test(fixture.id) || fixture.id !== entry.name.slice(0, -5)) throw new Error(`Invalid lab fixture: ${entry.name}`);
    validateLabChecks(fixture.checks);
    return fixture;
  }));
}

export async function labCheckpoints(root) {
  const directory = join(root, 'checkpoints');
  const sessions = await directories(directory);
  const checkpoints = [];
  for (const session of sessions) {
    if (!runId.test(session)) continue;
    for (const run of await directories(join(directory, session))) {
      if (!runId.test(run)) continue;
      const index = await readFile(join(directory, session, run, 'index.json'), 'utf8').then(JSON.parse, error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!index) continue;
      const names = new Set([...Object.values(index.slots ?? {}), ...(index.incidents ?? []).flatMap(incident => Object.values(incident.slots ?? {}))]);
      for (const name of names) {
        if (!checkpointPart.test(name ?? '')) continue;
        const path = join(directory, session, run, name);
        const metadata = await readFile(join(path, 'checkpoint.json'), 'utf8').then(JSON.parse, error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (metadata) checkpoints.push({ id: `${session}/${run}/${name}`, session, run, name, at: metadata.at,
          context: Boolean(metadata.context), contextAgeMs: metadata.context?.ageMs ?? null, path });
      }
    }
  }
  return checkpoints.sort((left, right) => right.at - left.at);
}

export function resolveLabCheckpoint(root, id, checkpoints) {
  const checkpoint = checkpoints.find(item => item.id === id);
  if (!checkpoint) return null;
  const path = resolve(root, 'checkpoints', ...id.split('/'));
  if (!path.startsWith(`${resolve(root, 'checkpoints')}${sep}`)) return null;
  return { ...checkpoint, path };
}

export function validateLabChecks(checks) {
  if (!Array.isArray(checks) || checks.length > 16) throw new Error('Provide at most sixteen success checks.');
  for (const check of checks) {
    if (!check || typeof check !== 'object') throw new Error('Each success check must be an object.');
    if (['healthAtLeast', 'foodAtLeast'].includes(check.kind) && Number.isFinite(check.value) && check.value >= 0) continue;
    if (check.kind === 'airAtLeast' && Number.isFinite(check.value) && check.value >= 0) continue;
    if (check.kind === 'notInWater') continue;
    if (check.kind === 'positionWithin' && check.center &&
        ['x', 'y', 'z'].every(axis => Number.isFinite(check.center[axis]) && Math.abs(check.center[axis]) <= 30_000_000) &&
        Number.isFinite(check.center.radius) && check.center.radius > 0 && check.center.radius <= 8) continue;
    if (check.kind === 'equippedItem' && /^[a-z0-9_]+$/.test(check.item ?? '') &&
        ['main', 'hotbar', 'head', 'torso', 'legs', 'feet', 'off-hand'].includes(check.location) &&
        (check.durabilityAtLeast === undefined || (Number.isFinite(check.durabilityAtLeast) && check.durabilityAtLeast >= 0))) continue;
    if (check.kind === 'mobCountAtMost' && /^[a-z0-9_]+$/.test(check.mob ?? '') &&
        Number.isInteger(check.count) && check.count >= 0) continue;
    if (check.kind === 'toolResult' && validResultPath(check.path) &&
        ((Object.hasOwn(check, 'equals') && !Object.hasOwn(check, 'atLeast') &&
          ['string', 'number', 'boolean'].includes(typeof check.equals) &&
          (typeof check.equals !== 'number' || Number.isFinite(check.equals))) ||
         (!Object.hasOwn(check, 'equals') && Number.isFinite(check.atLeast) && check.atLeast >= 0))) continue;
    const validCenter = check.center === undefined || (check.center &&
      /^minecraft:[a-z0-9_]+$/.test(check.center.dimension ?? '') &&
      ['x', 'y', 'z'].every(axis => Number.isFinite(check.center[axis]) && Math.abs(check.center[axis]) <= 30_000_000) &&
      (check.center.radius === undefined || (Number.isFinite(check.center.radius) && check.center.radius > 0 && check.center.radius <= 8)));
    if (['inventoryAtLeast', 'inventoryBelow', 'inventoryOrNearbyAtLeast'].includes(check.kind) &&
        /^[a-z0-9_]+$/.test(check.item ?? '') && Number.isInteger(check.count) && check.count >= 0 && validCenter) continue;
    if (check.kind === 'blockAt' && check.pos && ['x', 'y', 'z'].every(axis => Number.isSafeInteger(check.pos[axis])) &&
        /^[a-z0-9_]+$/.test(check.name ?? '')) continue;
    throw new Error('A success check has an unsupported type or invalid value.');
  }
  return checks;
}

export function evaluateLabChecks(checks, evidence, baseline = {}) {
  const results = checks.map(check => {
    let actual;
    let passed = false;
    if (check.kind === 'healthAtLeast') actual = evidence.status?.vitals?.health, passed = actual >= check.value;
    if (check.kind === 'foodAtLeast') actual = evidence.status?.vitals?.food, passed = actual >= check.value;
    if (check.kind === 'airAtLeast') {
      actual = evidence.status?.vitals?.airSupplyTicks;
      passed = Number.isFinite(actual) && actual >= check.value;
    }
    if (check.kind === 'notInWater') {
      actual = evidence.status?.position?.inWater;
      passed = actual === false;
    }
    if (check.kind === 'positionWithin') {
      const position = evidence.status?.position;
      actual = position && ['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))
        ? Math.hypot(position.x - check.center.x, position.y - check.center.y, position.z - check.center.z)
        : null;
      passed = actual !== null && actual <= check.center.radius;
    }
    if (check.kind === 'equippedItem') {
      const stack = evidence.status?.inventory?.stacks?.find(item => item.name === check.item && item.location === check.location);
      actual = stack ? { name: stack.name, location: stack.location, durability: stack.durability ?? null } : null;
      passed = stack !== undefined && (check.durabilityAtLeast === undefined ||
        (Number.isFinite(stack.durability?.remaining) && stack.durability.remaining >= check.durabilityAtLeast));
    }
    if (check.kind === 'mobCountAtMost') {
      const mobs = evidence.status?.nearby?.mobs;
      actual = Array.isArray(mobs) ? mobs.filter(mob => mob.name === check.mob).reduce((sum, mob) => sum + mob.count, 0) : null;
      passed = actual !== null && actual <= check.count;
    }
    if (check.kind === 'toolResult') {
      actual = resultAt(evidence.controllerResult, check.path);
      passed = Object.hasOwn(check, 'equals') ? actual === check.equals : Number.isFinite(actual) && actual >= check.atLeast;
    }
    if (check.kind === 'inventoryAtLeast') {
      actual = itemCount(evidence.status, check.item);
      passed = actual !== null && actual >= check.count;
    }
    if (check.kind === 'inventoryBelow') {
      actual = itemCount(evidence.status, check.item);
      const previous = itemCount(baseline, check.item);
      passed = actual !== null && previous !== null && actual < previous && actual < check.count;
    }
    if (check.kind === 'inventoryOrNearbyAtLeast') {
      const carried = itemCount(evidence.status, check.item) ?? 0;
      const radius = check.center?.radius ?? 4;
      const observedNearby = evidence.status?.nearby?.droppedItems
        ?.filter(item => item.name === check.item && nearbyItemIsInsideCheckArea(item, check, evidence.status, radius))
        .reduce((sum, item) => sum + item.count, 0) ?? 0;
      const nearby = Math.max(evidence.groundItems?.[check.item] ?? 0, observedNearby);
      actual = { carried, nearby, total: carried + nearby };
      passed = actual.total >= check.count;
    }
    if (check.kind === 'blockAt') {
      actual = evidence.blocks?.find(block => block.x === check.pos.x && block.y === check.pos.y && block.z === check.pos.z)?.name ?? null;
      passed = actual === check.name;
    }
    return { check, actual: actual ?? null, passed };
  });
  return { passed: results.length > 0 && results.every(result => result.passed), checks: results };
}

function validResultPath(path) {
  return typeof path === 'string' && path.split('.').every(part => /^[A-Za-z][A-Za-z0-9]*$/.test(part) &&
    !['__proto__', 'prototype', 'constructor'].includes(part));
}

function resultAt(controllerResult, path) {
  if (!controllerResult || !validResultPath(path)) return null;
  const structured = controllerResult.result ?? controllerResult;
  const data = structured?.response?.data;
  const action = data?.output?.result ?? data?.result ?? structured?.result ?? structured;
  let current = action;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part)) return null;
    current = current[part];
  }
  return current ?? null;
}

function nearbyItemIsInsideCheckArea(item, check, status, radius) {
  if (!check.center) return Number.isFinite(item.distance) && item.distance <= radius;
  const dimension = status?.dimension;
  const namespacedDimension = typeof dimension === 'string'
    ? dimension.includes(':') ? dimension : `minecraft:${dimension}`
    : null;
  const position = item.position;
  if (namespacedDimension !== check.center.dimension ||
      !position || !['x', 'y', 'z'].every(axis => Number.isFinite(position[axis]))) return false;
  return Math.hypot(position.x - check.center.x, position.y - check.center.y, position.z - check.center.z) <= radius;
}

export async function readLabEvidence(client, checks, signal) {
  const statusReply = filterStatusPlayers(await client.callTool('view_status', {
    rationale: 'Verify the lab outcome from live Minecraft state.', response_format: 'json',
  }, { signal }));
  const statusAction = actionResult(statusReply);
  const status = statusAction?.situation ?? null;
  const positions = checks.filter(check => check.kind === 'blockAt').map(check => check.pos);
  let blocks = [];
  if (positions.length) {
    const blockReply = await client.callTool('view_blocks', {
      cells: positions, rationale: 'Verify the lab outcome at the configured Minecraft coordinates.', response_format: 'json',
    }, { signal });
    blocks = actionResult(blockReply)?.blocks?.cells ?? [];
  }
  return { status, blocks };
}

function actionResult(reply) {
  if (!reply || reply.isError) return null;
  const data = reply.structuredContent?.response?.data;
  return data?.output?.result ?? data?.result ?? null;
}

function itemCount(status, item) {
  return status?.inventory?.stacks?.filter(stack => stack.name === item).reduce((sum, stack) => sum + stack.count, 0) ?? null;
}

async function directories(path) {
  return (await readdir(path, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter(entry => entry.isDirectory()).map(entry => entry.name);
}
