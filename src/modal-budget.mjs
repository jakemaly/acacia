// Bound unreported usage using the worker's configured maximum CPU and memory.
export const workerMaxHourlyUsd = 3 * 0.141912 + 7 * 0.024012;

export function evaluateBudget({ sample, activeWorkers, pilotStats, now = Date.now() }) {
  const metered = Number(sample?.meteredUsd);
  const fetched = Date.parse(sample?.fetchedAt);
  const cycleStart = Date.parse(sample?.cycleStart);
  const cycleEnd = Date.parse(sample?.cycleEnd);
  if (!sample || !Number.isFinite(metered) || metered < 0 || !Number.isSafeInteger(activeWorkers) || activeWorkers < 0 ||
      !Number.isFinite(fetched) || now - fetched > 180_000 || fetched - now > 30_000 ||
      !Number.isFinite(cycleStart) || !Number.isFinite(cycleEnd) || now < cycleStart || now >= cycleEnd) {
    return { allowed: false, reason: 'Modal spending data is unavailable or stale.' };
  }
  const estimated = metered + activeWorkers * workerMaxHourlyUsd * (15 / 60 + Math.max(0, now - fetched) / 3_600_000);
  if (estimated >= 28) return { allowed: false, estimatedUsd: estimated, reason: 'The $28 Modal usage threshold has been reached.' };
  if (pilotStats !== undefined) {
    if (pilotStats.length !== activeWorkers || pilotStats.some(item => item.costUsd === null || item.costUsd === undefined ||
        !Number.isFinite(Number(item.costUsd)) || Number(item.costUsd) < 0 || item.durationSeconds < 540)) {
      return { allowed: false, estimatedUsd: estimated, reason: 'Modal pilot cost data is incomplete.' };
    }
    const hourlyUsd = pilotStats.reduce((sum, item) => sum + Number(item.costUsd) * 3600 / item.durationSeconds, 0);
    if (hourlyUsd > 1) return { allowed: false, estimatedUsd: estimated, hourlyUsd, reason: 'The four-world pilot exceeds $1 per hour.' };
    return { allowed: true, estimatedUsd: estimated, hourlyUsd };
  }
  return { allowed: true, estimatedUsd: estimated };
}
