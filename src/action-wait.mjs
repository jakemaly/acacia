const maxObjectiveMs = 15 * 60_000;
const cleanupObservationMs = 30_000;

function handoff(result, actionId, reason) {
  const text = `Action ID: ${actionId}\n\n${reason} Retrieve the result with wait_for_action before giving replacement work.`;
  return { ...result, content: [{ type: 'text', text }], isError: true,
    structuredContent: { ...result.structuredContent, handoff: { actionId, reason } } };
}

export async function followAction({ name, args, executionLimit, pollMs = 5000, call, onAccepted, onProgress,
  isTransportFailure = () => false }) {
  const { wait_timeout_ms: _wait, execution_timeout_ms: _deadline, response_format: _format, ...submission } = args;
  const nativeLimit = Number.isFinite(executionLimit) ? Math.min(executionLimit, maxObjectiveMs) : undefined;
  let result = await call(name, {
    ...submission, response_format: 'json', ...(nativeLimit && { execution_timeout_ms: nativeLimit }),
  });
  let data = result.structuredContent?.response?.data;
  if (data?.state !== 'accepted') return result;
  await onAccepted?.(data);

  const { actionId } = data;
  const wait = (timeout_ms, response_format = 'json') => call('wait_for_action', {
    action_id: actionId, timeout_ms, response_format, rationale: 'Follow the current objective.',
  });
  const deadline = performance.now() + (nativeLimit ?? maxObjectiveMs);
  let cleanupUntil = nativeLimit ? deadline + cleanupObservationMs : undefined;
  while (true) {
    if (cleanupUntil === undefined && performance.now() >= deadline) {
      // Older images leave the execution deadline to the caller. Cancel this exact ID once and keep observing cleanup.
      let cancellation;
      try {
        cancellation = await call('cancel_foreground_action', {
          action_id: actionId, reason: 'Objective execution time limit reached.',
          rationale: 'Release the current objective safely.', response_format: 'json',
        });
      } catch (error) {
        if (!isTransportFailure(error)) throw error;
        return handoff(result, actionId, 'Lost connection while requesting cancellation.');
      }
      if (cancellation.isError) return handoff(cancellation, actionId, 'The runtime did not confirm cancellation.');
      cleanupUntil = performance.now() + cleanupObservationMs;
    }
    const remaining = (cleanupUntil ?? deadline) - performance.now();
    if (remaining <= 0) return handoff(result, actionId, 'The runtime has not returned the final result after the execution deadline.');
    try {
      result = await wait(Math.min(pollMs, Math.ceil(remaining)));
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      return handoff(result, actionId, 'Lost connection while following the action.');
    }
    data = result.structuredContent?.response?.data;
    if (data?.code === 'PROGRESS_UNAVAILABLE') continue;
    if (data?.state !== 'pending') break;
    const { progress, request } = data.progress ?? {};
    const checkpoint = request?.evidence?.checkpoint;
    onProgress({ actionId, state: progress?.state, phase: checkpoint?.phase, position: progress?.current,
      remainingDistance: checkpoint?.remainingDistance, gained: checkpoint?.gained, furnaceOutput: checkpoint?.furnaceOutput,
      correct: checkpoint?.correct, requested: checkpoint?.requested, health: data.vitalsDuringWait?.healthAfter });
  }

  if (data?.state === 'settled') {
    try {
      return await wait(0, 'markdown');
    } catch (error) {
      if (!isTransportFailure(error)) throw error;
      // The result gate already opened on the typed read. Preserve that receipt.
    }
  }
  return result;
}
