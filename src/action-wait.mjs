const noProgressMs = 15_000;

export async function followAction({ name, args, requestedWait, pollMs, call, onProgress }) {
  const started = performance.now();
  const waitUntil = started + requestedWait;
  const cancelAt = args.execution_timeout_ms === undefined ? Infinity : started + args.execution_timeout_ms;
  const format = args.response_format ?? 'markdown';
  const wait = (actionId, timeout_ms, response_format = 'json') => call('wait_for_action', {
    action_id: actionId, timeout_ms, response_format, rationale: 'Follow progress on the current objective.',
  });

  // Get an action ID before waiting so each subsequent read addresses the same execution.
  const { wait_timeout_ms: _wait, ...submission } = args;
  let result = await call(name, { ...submission, response_format: 'json' });
  let data = result.structuredContent?.response?.data;
  if (data?.state !== 'accepted') return result;
  const { actionId } = data;
  let bestDistance = Infinity;
  let withoutProgress = 0;
  let stopReason;
  let lastPoll = performance.now();
  const visited = new Set();
  while (data.state === 'accepted' || data.state === 'pending') {
    const remaining = Math.min(waitUntil, cancelAt) - performance.now();
    if (remaining < 1) {
      stopReason = 'The requested wait ended.';
      break;
    }
    result = await wait(actionId, Math.min(pollMs, Math.floor(remaining)));
    data = result.structuredContent?.response?.data;
    if (result.isError || data?.state !== 'pending') break;

    const now = performance.now();
    const interval = data.duringWait ?? {};
    const progress = data.progress?.progress;
    const checkpoint = data.progress?.request?.evidence?.checkpoint;
    const current = progress?.current;
    // The runtime may still be resolving an outdoor target's Y coordinate during the approach.
    const remainingDistance = checkpoint?.remainingDistance ?? (name === 'navigate' && current &&
      Number.isFinite(args.x) && Number.isFinite(args.z) &&
      current.dimension === checkpoint?.positionedDimension ? Math.hypot(current.x - args.x, current.z - args.z) : undefined);
    const state = progress?.state;
    const recovering = state === 'suspended' || state === 'resuming';
    const camp = checkpoint?.camp;
    const observationUntil = camp?.phase === 'waiting_away' ? camp.returnAfter : camp?.observationUntil ?? checkpoint?.observationUntil;
    const observing = checkpoint?.phase === 'observing' && observationUntil > Date.now();
    const { broken = 0, gained = 0, targetDeathsObserved = 0 } = interval.checkpointDelta ?? {};
    const scaffoldPlaced = interval.combatResources?.scaffoldPlaced ?? 0;
    // Mining and hunting only expose coarse approach evidence. Repeated visits do not renew the wait.
    const cell = current && [current.dimension, ...[current.x, current.y, current.z].map(n => Math.floor(n / 4))].join(':');
    const approaching = name !== 'navigate' && cell && !visited.has(cell) &&
      interval.distanceTravelledBlocks - interval.reflexDistanceBlocks >= 2;
    if (cell) visited.add(cell);
    const closing = Number.isFinite(remainingDistance) && bestDistance - remainingDistance >= 0.75;
    if (closing && !recovering) bestDistance = remainingDistance;
    const advanced = closing || broken > 0 || gained > 0 || targetDeathsObserved > 0 || scaffoldPlaced > 0 || approaching;
    if (advanced && !recovering) withoutProgress = 0;
    else if (!recovering && !observing) withoutProgress += Math.max(0, now - lastPoll - (interval.suspendedMs ?? 0));
    lastPoll = now;
    onProgress({ actionId, state, remainingDistance, position: current, gained: checkpoint?.gained,
      requested: checkpoint?.requested, health: data.vitalsDuringWait?.healthAfter });

    const vitals = data.vitalsDuringWait;
    const urgent = data.survival?.dangers?.find(danger => danger.selected && !danger.stale &&
      ['fire_reflex', 'breath_reflex', 'recover_footing'].includes(danger.reflex));
    if (data.survival?.summary === 'dead' || urgent) {
      stopReason = urgent ? `Immediate danger reported by ${urgent.reflex}.` : 'The runtime reported that Acacia died.';
      break;
    }
    if (vitals?.healthAfter < vitals?.healthBefore) {
      stopReason = `Health dropped from ${vitals.healthBefore} to ${vitals.healthAfter}.`;
      break;
    }
    if (withoutProgress >= noProgressMs) {
      stopReason = 'No verified progress for 15 seconds of active work.';
      break;
    }
  }

  if (data?.state === 'accepted' || data?.state === 'pending') {
    // Leave a stalled job addressable. When its execution deadline expires, cancel by ID
    // and give the runtime time to finish cleaning up and release the result gate.
    if (cancelAt <= performance.now()) {
      const cancellation = await call('cancel_foreground_action', {
        action_id: actionId, reason: 'The objective reached its execution deadline.',
        rationale: 'Settle the current objective before admitting another.',
        response_format: 'json',
      });
      if (cancellation.isError) return cancellation;
      result = await wait(actionId, pollMs);
      data = result.structuredContent?.response?.data;
      if (data?.state !== 'pending') return format === 'markdown' && data?.state === 'settled'
        ? wait(actionId, 0, format) : result;
      stopReason = 'Cancellation requested. Cleanup is still in progress.';
    }
    const text = `Action ID: ${actionId}\n\n${stopReason} The action is still active. Call wait_for_action to continue or cancel_foreground_action to request cancellation, then retrieve the final result before starting another action.`;
    const evidence = data?.progress?.request?.evidence?.checkpoint;
    const remaining = Number.isFinite(evidence?.remainingDistance) ? ` ${evidence.remainingDistance.toFixed(1)} blocks from the destination.` : '';
    const collected = Number.isFinite(evidence?.gained) ? ` Collected ${evidence.gained} of ${evidence.requested} requested.` : '';
    return { ...result, content: [{ type: 'text', text: text + remaining + collected }],
      structuredContent: { ...result.structuredContent, handoff: stopReason }, isError: false };
  }

  // The runtime owns the final receipt format and keeps settled output available for retrieval.
  if (format === 'markdown' && data?.state === 'settled') return wait(actionId, 0, format);
  return result;
}
