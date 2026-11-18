const OMIT = Symbol('omit');
const playerListKeys = new Set(['players', 'onlineplayers', 'connectedplayers', 'nearbyplayers']);
const playerListLine = /^\s*(?:[-*]\s*)?(?:(?:online|nearby|other|connected|active|visible)\s+)?players\b[^:]*:/i;
const playerListHeading = /^\s*#{1,6}\s+(?:(?:nearby|other)\s+)?players\b/i;

const keyName = value => String(value).replace(/[^a-z0-9]/gi, '').toLowerCase();

function filterStatusText(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(filterStatusValue(JSON.parse(text)));
    } catch {}
  }

  const lines = [];
  let skippingPlayerSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (playerListHeading.test(line)) {
      skippingPlayerSection = true;
      continue;
    }
    if (skippingPlayerSection && /^\s*#{1,6}\s+/.test(line)) skippingPlayerSection = false;
    if (skippingPlayerSection || playerListLine.test(line)) continue;
    lines.push(line);
  }
  return lines.join('\n');
}

function filterStatusValue(value, key = '') {
  if (playerListKeys.has(keyName(key))) return OMIT;
  if (typeof value === 'string') return filterStatusText(value);
  if (Array.isArray(value)) {
    return value.map(item => filterStatusValue(item)).filter(item => item !== OMIT);
  }
  if (!value || typeof value !== 'object') return value;

  const filtered = {};
  for (const [childKey, child] of Object.entries(value)) {
    if (playerListKeys.has(keyName(childKey))) continue;
    const safeChild = filterStatusValue(child, childKey);
    if (safeChild !== OMIT) filtered[childKey] = safeChild;
  }
  return filtered;
}

export function filterStatusPlayers(result) {
  return filterStatusValue(result) ?? {};
}
