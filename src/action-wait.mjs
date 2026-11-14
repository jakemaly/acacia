const noProgressMs = 15_000;

export async function followAction({ name, args, requestedWait, pollMs, call, onProgress, isTransportFailure = () => false }) {
  const started = performance.now();
  const waitUntil = started + requestedWait;
  // Mine AI starts and enforces the execution deadline at admission. Leave one
  // poll to retrieve its result when that deadline, rather than the wait, is first.
  const executionTimeout = args.execution_timeout_ms;
  const expectDeadline = executionTimeout !== undefined && executionTimeout <= requestedWait;
  const followUntil = expectDeadline ? started + executionTimeout + pollMs : waitUntil;
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
  let measuredDestination;
  let withoutProgress = 0;
  let stopReason;
  let actionStatus = 'still active';
  let lastPoll = performance.now();
  const visited = new Set();
  while (data.state === 'accepted' || data.state === 'pending') {
    const remaining = followUntil - performance.now();
    if (remaining <= 0) {
      stopReason = expectDeadline ? 'The runtime has yet to return the deadline result.' : 'The requested wait ended.';
      break;
    }
    try {
      result = await wait(actionId, Math.min(pollMs, Math.ceil(remaining)));
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      stopReason = 'The connection dropped while following this action.';
      actionStatus = 'awaiting confirmation';
      break;
    }
    data = result.structuredContent?.response?.data;
    if (data?.code === 'PROGRESS_UNAVAILABLE') {
      stopReason = 'Live progress is unavailable.';
      break;
    }
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
    const destination = checkpoint?.destination;
    const destinationKey = destination ? `${destination.x}/${destination.y}/${destination.z}` : 'horizontal';
    if (Number.isFinite(remainingDistance) && destinationKey !== measuredDestination) {
      bestDistance = Infinity;
      measuredDestination = destinationKey;
    }
    const closing = Number.isFinite(remainingDistance) && bestDistance - remainingDistance >= 0.75;
    if (closing && !recovering) bestDistance = remainingDistance;
    const advanced = closing || broken > 0 || gained > 0 || targetDeathsObserved > 0 || scaffoldPlaced > 0 || approaching;
    if (advanced && !recovering) withoutProgress = 0;
    else if (!recovering && !observing && state !== 'stopping') withoutProgress += Math.max(0, now - lastPoll - (interval.suspendedMs ?? 0));
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

  if (stopReason) {
    const text = `Action ID: ${actionId}\n\n${stopReason} The action is ${actionStatus}. Call wait_for_action to retrieve its result or continue observing, or cancel_foreground_action to request cancellation. Retrieve the final result before starting another action.`;
    const evidence = data?.progress?.request?.evidence?.checkpoint;
    const remaining = Number.isFinite(evidence?.remainingDistance) ? ` ${evidence.remainingDistance.toFixed(1)} blocks from the destination.` : '';
    const collected = Number.isFinite(evidence?.gained) && Number.isFinite(evidence?.requested) ? ` Collected ${evidence.gained} of ${evidence.requested} requested.` : '';
    return { ...result, content: [{ type: 'text', text: text + remaining + collected }],
      structuredContent: { ...result.structuredContent, handoff: { actionId, reason: stopReason } }, isError: false };
  }

  // The runtime owns the final receipt format and keeps settled output available for retrieval.
  if (format === 'markdown' && data?.state === 'settled') {
    try {
      return await wait(actionId, 0, format);
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      // The result gate already opened on the typed read. Preserve that receipt.
    }
  }
  return result;
}
