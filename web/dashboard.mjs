const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const isNumber = value => Number.isFinite(value);
const when = value => new Date(value).toLocaleTimeString();
const title = value => value ? value[0].toUpperCase() + value.slice(1) : '';
const modelLabel = value => {
  const match = String(value ?? '').match(/^gpt-(\d+(?:\.\d+)?)-([a-z]+)$/i);
  return match ? `GPT-${match[1]} ${title(match[2])}` : String(value ?? '');
};
const toolLabel = value => (value ?? 'tool').replace(/^mcp__minecraft__/, '').replaceAll('_', ' ');
const timeline = $('timeline');
let run = {};
let selected = null;
let before = null;
let messages = new Map();
let signature = '';
let controlPending = false;
let revision = 0;

const reviewCategory = {
  decision: 'Gameplay decision',
  implementation_bug: 'Suspected implementation bug',
  capability_gap: 'Missing capability',
  environment: 'Game circumstances',
  uncertain: 'Uncertain',
};

async function api(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}

function showError(message = '') {
  $('error').textContent = message;
  $('error').style.display = message ? 'block' : 'none';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.webtuiTheme = theme;
  $('theme-label').textContent = title(theme);
  $('theme-toggle').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}

function setAgent(mode, label) {
  const card = $('agent-card');
  const image = $('steve');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const imageMode = reducedMotion && mode === 'walking' ? 'idle' : mode;
  const source = {
    thinking: 'https://skinrender.dev/render/steve/body?size=384&pose=think',
    walking: 'https://skinrender.dev/render/steve/body?pose=walk&format=apng',
    acting: 'https://skinrender.dev/render/steve/body?size=384',
    idle: 'https://skinrender.dev/render/steve/body?size=384',
  }[imageMode] || 'https://skinrender.dev/render/steve/body?size=384';
  card.dataset.mode = reducedMotion && mode === 'walking' ? 'acting' : mode;
  $('activity-line').hidden = mode === 'idle';
  if (image.dataset.source !== source) { image.src = source; image.dataset.source = source; }
  image.alt = `Steve ${imageMode === 'thinking' ? 'thinking' : imageMode === 'walking' ? 'walking' : 'standing'}`;
  $('activity').textContent = label;
}

function latestToolCall() {
  const calls = [...messages.values()].flatMap(message => message.calls ?? []);
  const latest = run.activity?.findLast(event => event.type === 'tool_execution_start');
  return (latest && calls.find(call => call.id === latest.id)) ?? calls.at(-1);
}

function actionAsset(call) {
  if (!call) return;
  const name = call.name.replace(/^mcp__minecraft__/, '');
  const args = call.args ?? {};
  const requested = Array.isArray(args.items) ? args.items.find(item => item?.item_name)?.item_name
    : typeof args.items === 'string' ? args.items : undefined;
  const pick = (...values) => values.find(value => typeof value === 'string' && value.trim());
  let asset;
  if (name === 'collect_block' || name === 'collect_exact_block') {
    asset = { name: pick(args.block_name, args.block, args.block_type), kind: 'blocks' };
  }
  else if (name === 'collect_mob_drop') asset = { name: args.drop_name, kind: 'items' };
  else if (name === 'craft_item' || name === 'use_container') asset = { name: requested, kind: 'items' };
  else if (name === 'smelt_item' || name === 'smelt_at_furnace') asset = { name: args.item_name, kind: 'items' };
  else if (name === 'equip') asset = { name: pick(args.item_name, args.item), kind: 'items' };
  else if (name === 'pick_up_items') asset = { name: args.item, kind: 'items' };
  else if (name === 'ensure_items') asset = { name: pick(args.item_name, requested), kind: 'items' };
  else if (name === 'use_bucket') {
    asset = { name: args.action === 'fill' ? `${args.liquid}_bucket` : 'bucket', kind: 'items' };
  }
  else if (name === 'place_block') asset = { name: pick(args.block_name, args.block), kind: 'blocks' };
  const id = String(asset?.name ?? '').replace(/^minecraft:/, '').replace(/[^a-zA-Z0-9_]/g, '');
  return id ? { id, kind: asset.kind } : undefined;
}

function renderActionIcon(call) {
  const image = $('activity-icon');
  const asset = actionAsset(call);
  if (!asset) {
    image.hidden = true;
    image.dataset.asset = '';
    image.removeAttribute('src');
    image.onerror = null;
    return;
  }
  const assetKey = `${asset.kind}/${asset.id}`;
  if (image.dataset.asset === assetKey) return;
  image.dataset.asset = assetKey;
  image.dataset.fallback = '0';
  image.alt = `${asset.id.replaceAll('_', ' ')} ${asset.kind === 'blocks' ? 'block' : 'item'}`;
  image.hidden = false;
  const root = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4';
  const primary = `${root}/${asset.kind}/${asset.id}.png`;
  const fallback = `${root}/${asset.kind === 'blocks' ? 'items' : 'blocks'}/${asset.id}.png`;
  image.onerror = () => {
    if (image.dataset.fallback === '0') {
      image.dataset.fallback = '1';
      image.src = fallback;
    } else image.hidden = true;
  };
  image.src = primary;
}

function renderDecision(rationale) {
  const panel = $('current-rationale');
  const objective = typeof rationale?.objective === 'string' ? rationale.objective.trim() : '';
  const observation = typeof rationale?.observation === 'string' ? rationale.observation.trim() : '';
  const raw = typeof rationale === 'string' ? rationale.trim()
    : typeof rationale?.text === 'string' ? rationale.text.trim() : '';
  const fields = raw.match(/^Objective:\s*([^\r\n]+)\r?\nObservation:\s*([^\r\n]+)/i);
  const value = objective && observation
    ? `Objective: ${objective}\nObservation: ${observation}`
    : fields?.[1]?.trim() && fields[2]?.trim()
      ? `Objective: ${fields[1].trim()}\nObservation: ${fields[2].trim()}`
      : raw.replace(/\s+Change(?: course)?(?: if)?:[\s\S]*$/i, '').trim();
  panel.hidden = !value;
  if (panel.textContent !== value) panel.textContent = value;
}

function renderMeter(container, value, sprite, empty) {
  const points = isNumber(value) ? Math.max(0, Math.min(20, Number(value))) : null;
  const signature = points === null ? 'unknown' : String(points);
  if (container.dataset.points === signature) return points;
  container.dataset.points = signature;
  container.innerHTML = Array.from({ length: 10 }, (_, index) => {
    const amount = points === null ? 0 : points / 2 - index;
    const image = points === null ? empty : amount >= 1 ? sprite('full') : amount > 0 ? sprite('half') : empty;
    return `<img class="${container.id === 'hearts' ? 'heart' : 'food'}" alt="" src="${image}">`;
  }).join('');
  return points;
}

function renderHealth() {
  const player = run.player ?? {};
  const health = renderMeter($('hearts'), player.health, (part) => `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/gui/sprites/hud/heart/${part}.png`, 'https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/gui/sprites/hud/heart/container.png');
  const food = renderMeter($('foods'), player.food, (part) => `https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/gui/sprites/hud/food_${part}.png`, 'https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/gui/sprites/hud/food_empty.png');
  $('health-value').textContent = health === null ? '— / 20' : `${health} / 20`;
  $('food-value').textContent = food === null ? '— / 20' : `${food} / 20`;
  $('hearts').setAttribute('aria-label', health === null ? 'Health not yet observed' : `${health} health points`);
  $('foods').setAttribute('aria-label', food === null ? 'Hunger not yet observed' : `${food} hunger points`);
  renderInventory(player.inventory);
}

function renderInventory(items) {
  const list = $('inventory-items');
  const signature = items ? JSON.stringify(items) : 'unknown';
  if (list.dataset.signature === signature) return;
  list.dataset.signature = signature;
  if (!items) {
    list.classList.remove('inventory-slot-layout');
    $('inventory-observed').textContent = 'Waiting for bot data';
    list.innerHTML = '<span class="inventory-empty">Direct inventory data is not available</span>';
    return;
  }
  $('inventory-observed').textContent = `${items.reduce((total, item) => total + item.count, 0)} items`;
  const stacks = items.filter((item) => item.name && item.count > 0);
  if (stacks.length && stacks.every((item) => Number.isInteger(item.slot))) {
    list.classList.add('inventory-slot-layout');
    const bySlot = new Map(stacks.map((item) => [item.slot, item]));
    const itemSlot = (slot, location) => {
      const item = bySlot.get(slot);
      if (!item) return `<span class="inventory-slot inventory-slot-empty" role="listitem" aria-label="Empty ${esc(location)}"></span>`;

      const name = String(item.name).replace(/^minecraft:/, '').replace(/[^a-zA-Z0-9_]/g, '');
      if (!name) return `<span class="inventory-slot inventory-slot-empty" role="listitem" aria-label="Empty ${esc(location)}"></span>`;
      const label = name.replaceAll('_', ' ');
      const durability = item.durability && Number.isFinite(item.durability.remaining) &&
        Number.isFinite(item.durability.maximum) && item.durability.maximum > 0
        ? {
            remaining: Math.max(0, Math.min(item.durability.maximum, item.durability.remaining)),
            maximum: item.durability.maximum,
          }
        : null;
      const durabilityPercent = durability ? Math.round((durability.remaining / durability.maximum) * 100) : 0;
      const titleText = `${label} ×${item.count} · ${location}${item.held ? ' · selected' : ''}${durability ? ` · ${Math.round(durability.remaining)}/${durability.maximum} durability` : ''}`;
      const durabilityBar = durability
        ? `<span class="inventory-durability" aria-hidden="true"><span style="width:${durabilityPercent}%;background:hsl(${Math.round(durabilityPercent * 1.2)} 100% 50%)"></span></span>`
        : '';
      const count = item.count > 1 ? `<span class="inventory-count">${esc(item.count)}</span>` : '';
      return `<span class="inventory-slot${item.held ? ' inventory-slot-held' : ''}" role="listitem" tabindex="0" aria-label="${esc(titleText)}" title="${esc(titleText)}"><img class="inventory-icon" alt="" loading="lazy" src="https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/items/${name}.png">${count}${durabilityBar}</span>`;
    };
    const equipment = [
      [5, 'helmet'], [6, 'chest armor'], [7, 'leg armor'], [8, 'boots'], [45, 'off hand'],
    ];
    list.innerHTML = `<div class="inventory-equipment" role="list" aria-label="Equipment">${equipment.map(([slot, location]) => itemSlot(slot, location)).join('')}</div><div class="inventory-carried"><div class="inventory-grid" role="list" aria-label="Main inventory">${Array.from({ length: 27 }, (_, index) => itemSlot(index + 9, `inventory slot ${index + 1}`)).join('')}</div><div class="inventory-grid inventory-hotbar" role="list" aria-label="Hotbar">${Array.from({ length: 9 }, (_, index) => itemSlot(index + 36, `hotbar slot ${index + 1}`)).join('')}</div></div>`;
  } else {
    list.classList.remove('inventory-slot-layout');
    list.innerHTML = stacks.map((item) => {
      const name = String(item.name).replace(/^minecraft:/, '').replace(/[^a-zA-Z0-9_]/g, '');
      const label = name.replaceAll('_', ' ');
      return `<span class="inventory-item" role="listitem" aria-label="${esc(label)} × ${esc(item.count)}" title="${esc(label)} × ${esc(item.count)}"><img class="inventory-icon" alt="" loading="lazy" src="https://raw.githubusercontent.com/PrismarineJS/minecraft-assets/master/data/1.21.4/items/${name}.png"><span class="inventory-item-name">${esc(label)}</span><span class="inventory-count">×${esc(item.count)}</span></span>`;
    }).join('') || '<span class="inventory-empty">Empty</span>';
  }
  for (const image of list.querySelectorAll('img')) image.onerror = () => {
    image.onerror = () => { image.hidden = true; };
    image.src = image.src.replace('/items/', '/blocks/');
  };
}

function renderStatus() {
  const active = ['starting', 'running', 'saving', 'reflecting'].includes(run.state);
  const mode = $('run-mode');
  if (run.state && !mode.dataset.initialized) {
    mode.value = run.defaultMode;
    mode.dataset.initialized = 'true';
  }
  const hardcore = active ? run.hardcore : mode.value === 'hardcore';
  $('difficulty').textContent = hardcore ? 'Hard (Hardcore)' : 'Normal';
  $('world-seed').textContent = run.seed ?? 'Random on start';
  mode.hidden = active;
  mode.disabled = !run.state || active || controlPending;
  $('start').disabled = mode.disabled || (hardcore && run.hardcore && run.state === 'won');
  $('checkpoint-control').hidden = active;
  $('collect-checkpoints').disabled = $('start').disabled;
  const checkpoints = run.checkpoints;
  const checkpointStatus = $('checkpoint-status');
  checkpointStatus.hidden = !active || !checkpoints;
  checkpointStatus.textContent = checkpoints?.state === 'full' ? 'Checkpoint collection paused at the storage limit.'
    : checkpoints?.state === 'error' ? `Checkpoint capture failed. ${checkpoints.error}`
    : checkpoints ? `Checkpoints collected: ${checkpoints.captured}` : '';
  $('stop').hidden = !active;
  $('stop').disabled = run.state === 'saving' || controlPending;
  $('run-state').textContent = run.state === 'won' ? 'Dragon defeated' : run.id ? title(run.state) : 'No run';
  $('run-state').classList.toggle('ready', run.state === 'running' || run.state === 'won');
  $('run-detail').textContent = run.detail ?? '';
  $('run-detail').hidden = !run.detail;
  if (run.model) $('model-picker').textContent = modelLabel(run.model);
  $('current-task').textContent = run.spectator ?? '';
  $('current-task-panel').hidden = !run.spectator;
  $('reasoning-value').textContent = title(run.thinkingLevel);
  const viewer = $('viewer');
  if (run.viewer) {
    if (viewer.querySelector('iframe')?.getAttribute('src') !== run.viewer) {
      const frame = document.createElement('iframe');
      frame.title = 'Live Prismarine Viewer';
      frame.src = run.viewer;
      frame.allowFullscreen = true;
      viewer.replaceChildren(frame);
    }
  } else {
    const text = run.state === 'starting' ? 'Starting the Minecraft world…'
      : run.state === 'reflecting' ? 'Reviewing the Hardcore death…'
      : run.id ? 'Run finished. Its transcript is available in Conversation and Runs.'
      : 'Start a run to open the live first-person world view.';
    if (viewer.textContent !== text) viewer.innerHTML = `<div class="viewer-empty">${text}</div>`;
  }
  const activity = run.activity ?? [];
  const pending = activity.findLast(event => event.type === 'tool_execution_start' &&
    !activity.some(other => other.type === 'tool_execution_end' && other.id === event.id));
  const progress = pending && activity.findLast(event => event.type === 'action_progress' && event.id === pending.id);
  const label = pending ? title(toolLabel(pending.tool)) : activity.at(-1)?.type === 'continuation' ? 'Continuing the run' : 'Thinking';
  const movement = isNumber(progress?.remainingDistance) ? `${Math.round(progress.remainingDistance)} blocks left` : '';
  const objectives = pending?.tool.endsWith('__ensure_items');
  const collection = isNumber(progress?.gained) && isNumber(progress?.requested)
    ? `${progress.gained}/${progress.requested} ${objectives ? 'ready' : 'collected'}` : '';
  const cooking = isNumber(progress?.furnaceOutput) && isNumber(progress?.requested) ? `${progress.furnaceOutput}/${progress.requested} cooked` : '';
  const construction = isNumber(progress?.correct) && isNumber(progress?.requested) ? `${progress.correct}/${progress.requested} blocks ready` : '';
  const detail = progress?.state === 'suspended' ? 'Recovering'
    : objectives && progress?.phase ? [title(toolLabel(progress.phase)), collection].filter(Boolean).join(' · ')
    : movement || collection || cooking || construction;
  setAgent(run.state === 'running' ? pending ? pending.tool.endsWith('__navigate') ? 'walking' : 'acting' : 'thinking' : 'idle',
    detail ? `${label} · ${detail}` : label);
  const latestCall = latestToolCall();
  const currentCall = run.state === 'running' ? latestCall : undefined;
  const currentEvent = currentCall && run.activity?.findLast(event =>
    event.type === 'tool_execution_start' && event.id === currentCall.id);
  renderDecision(currentEvent?.decision ?? run.decision ?? currentCall?.args?.rationale);
  renderActionIcon(currentCall);
  renderHealth();
}

function traceMarkup(entries, live = []) {
  const replies = new Map(entries.filter(message => message.role === 'toolResult').map(message => [message.toolCallId, message]));
  const finished = new Set(live.filter(event => event.type === 'tool_execution_end').map(event => event.id));
  const pending = live.filter(event => event.type === 'tool_execution_start' && !finished.has(event.id));
  const markup = [];
  const toolCard = (id, name, args, timestamp) => {
    const result = replies.get(id);
    const state = result ? result.isError ? 'Failed' : 'Finished'
      : pending.some(event => event.id === id) ? 'Running' : 'Awaiting result';
    return `<article class="trace-event trace-tool" data-key="${esc(id)}"><details>
      <summary>${esc(toolLabel(name))} · ${state}</summary>
      <pre class="trace-output ${result?.isError ? 'error-text' : ''}">${esc(args ? JSON.stringify(args, null, 2) + '\n\n' : '')}${esc(result?.text)}</pre></details>
      <div class="trace-meta"><span>${esc(when(timestamp))}</span><span>${result?.durationMs != null ? `${Math.round(result.durationMs)} ms` : ''}</span></div>
      </article>`;
  };
  const callIds = new Set(entries.flatMap(message => message.calls.map(call => call.id)));
  for (const message of entries) {
    if (message.role === 'toolResult') {
      if (!callIds.has(message.toolCallId)) markup.push(toolCard(message.toolCallId, message.toolName, null, message.timestamp));
      continue;
    }
    if (message.text || message.error) {
      markup.push(`<article class="trace-event message" data-key="${message.offset}">
        <div class="trace-meta"><span class="trace-kind">${message.role === 'user' ? 'Goal' : 'Assistant'}</span><span>${esc(when(message.timestamp))}</span></div>
        <p class="trace-text">${esc(message.text || message.error)}</p></article>`);
    }
    for (const call of message.calls) markup.push(toolCard(call.id, call.name, call.args, message.timestamp));
  }
  for (const event of pending) {
    if (!callIds.has(event.id) && !replies.has(event.id)) markup.push(toolCard(event.id, event.tool, null, event.time));
  }
  return markup.join('');
}

function atBottom() {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 48;
}

function renderConversation(older = false) {
  const markup = traceMarkup([...messages.values()].sort((a, b) => a.offset - b.offset), run.activity);
  if (markup === signature && !older) return;
  signature = markup;
  const height = timeline.scrollHeight;
  const position = timeline.scrollTop;
  const follow = atBottom();
  const list = $('trace-events');
  const open = new Set([...list.querySelectorAll('details[open]')].map(details => details.parentElement.dataset.key));
  list.innerHTML = markup;
  for (const details of list.querySelectorAll('details')) details.open = open.has(details.parentElement.dataset.key);
  $('trace-empty').hidden = Boolean(markup);
  $('more').hidden = !before;
  if (older) timeline.scrollTop = position + timeline.scrollHeight - height;
  else if (follow) timeline.scrollTop = timeline.scrollHeight;
  $('trace-bottom').hidden = atBottom();
}

async function loadConversation(id, cursor) {
  return api(`/api/conversation?id=${encodeURIComponent(id)}${cursor ? `&before=${cursor}` : ''}`);
}

async function refresh() {
  const requestRevision = revision;
  try {
    const status = await api('/api/run');
    if (revision !== requestRevision) return;
    if (status.id !== run.id) {
      messages = new Map();
      before = null;
    }
    run = status;
    renderStatus();
    if (!run.id || run.state === 'starting') return;
    const page = await loadConversation(run.id);
    if (revision !== requestRevision) return;
    const first = page.messages[0]?.offset;
    if (!messages.size || (first !== undefined && !page.messages.some(message => messages.has(message.offset)))) {
      before = page.before;
      messages.clear();
    }
    for (const message of page.messages) messages.set(message.offset, message);
    renderStatus();
    renderConversation();
  } catch (error) {
    showError(error.message);
  } finally {
    setTimeout(refresh, 1500);
  }
}

async function control(action) {
  revision++;
  controlPending = true;
  renderStatus();
  try {
    const query = new URLSearchParams();
    if (action === 'start') {
      query.set('mode', $('run-mode').value);
      if ($('collect-checkpoints').checked) query.set('collect', '1');
    }
    const status = await api(`/api/${action}${query.size ? `?${query}` : ''}`, { method: 'POST' });
    if (action === 'start') $('collect-checkpoints').checked = false;
    if (status.id !== run.id) {
      messages.clear();
      before = null;
    }
    run = status;
    renderConversation();
    showError();
  } catch (error) {
    showError(error.message);
  } finally {
    controlPending = false;
    renderStatus();
  }
}

function showTab(name) {
  for (const tab of ['conversation', 'runs']) {
    $(`${tab}-tab`).setAttribute('aria-selected', String(tab === name));
    $(tab === 'conversation' ? 'trace-panel' : 'runs-panel').hidden = tab !== name;
  }
  if (name === 'runs' && !selected) void showRuns();
}

async function showRuns() {
  selected = null;
  $('runs-list-view').hidden = false;
  $('run-detail-view').hidden = true;
  try {
    const [runs, lab] = await Promise.all([api('/api/runs'), api('/api/lab')]);
    $('runs-status').textContent = runs.length ? '' : 'No saved runs';
    populateLabCatalog(lab);
    $('runs-list').replaceChildren(...runs.map(saved => {
      const button = document.createElement('button');
      button.className = 'run-library-item';
      const name = saved.lab?.fixtureName ?? (saved.lab?.type === 'checkpoint' ? 'Checkpoint replay' : 'Beat the Ender Dragon');
      button.innerHTML = `<span class="run-library-title"><span>${esc(name)}</span><span>${esc(title(saved.state))}</span></span>
        <span class="run-library-meta">${esc(new Date(saved.date).toLocaleString())} · Seed ${esc(saved.seed)}${saved.reflection?.summary || saved.reflection?.cause ? ' · Death review' : ''}</span>`;
      button.onclick = () => showRun(saved);
      return button;
    }));
  } catch (error) {
    $('runs-status').textContent = error.message;
  }
}

function populateLabCatalog(catalog) {
  const fixture = $('lab-fixture');
  fixture.replaceChildren(...catalog.fixtures.map(item => new Option(item.name, item.id)));
  const checkpoint = $('lab-checkpoint');
  checkpoint.replaceChildren(...catalog.checkpoints.map(item => new Option(
    `${new Date(item.at).toLocaleString()} · ${item.context ? 'conversation saved' : 'world only'}`,
    item.id,
  )));
  $('lab-build').replaceChildren(new Option('Current', 'current'), ...(catalog.candidateAvailable
    ? [new Option('Candidate', 'candidate')] : []));
  const unavailable = ['starting', 'running', 'saving', 'reflecting'].includes(run.state);
  for (const id of ['lab-fixture', 'lab-checkpoint', 'lab-build', 'lab-instruction', 'lab-time-limit', 'lab-item',
    'lab-item-count', 'lab-block-name', 'lab-block-x', 'lab-block-y', 'lab-block-z']) $(id).disabled = unavailable;
  $('run-fixture').disabled = unavailable || !catalog.fixtures.length;
  $('run-checkpoint').disabled = unavailable || !catalog.checkpoints.length;
  if (!catalog.checkpoints.length) checkpoint.add(new Option('No saved checkpoints', ''));
}

async function startLab(input) {
  $('lab-launch-status').textContent = 'Preparing isolated Minecraft run…';
  $('run-fixture').disabled = true;
  $('run-checkpoint').disabled = true;
  try {
    await api('/api/lab/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    $('lab-launch-status').textContent = '';
    selected = null;
    showTab('conversation');
    await refresh();
  } catch (error) {
    $('lab-launch-status').textContent = error.message;
    $('run-fixture').disabled = false;
    $('run-checkpoint').disabled = false;
  }
}

function checkpointChecks() {
  const checks = [];
  const item = $('lab-item').value.trim();
  const itemCount = $('lab-item-count').value;
  if (item || itemCount) {
    if (!item || !itemCount) throw new Error('Enter both an item name and its minimum count.');
    checks.push({ kind: 'inventoryAtLeast', item, count: Number(itemCount) });
  }
  const blockName = $('lab-block-name').value.trim();
  const coordinates = ['x', 'y', 'z'].map(axis => $(`lab-block-${axis}`).value);
  if (blockName || coordinates.some(Boolean)) {
    if (!blockName || coordinates.some(value => value === '')) throw new Error('Enter a block name and all three coordinates.');
    checks.push({ kind: 'blockAt', name: blockName, pos: { x: Number(coordinates[0]), y: Number(coordinates[1]), z: Number(coordinates[2]) } });
  }
  return checks;
}

function repeatLab(saved) {
  if (saved.lab.type === 'fixture') return startLab({ fixtureId: saved.lab.fixtureId,
    build: saved.lab.build, timeLimitMs: saved.lab.timeLimitMs });
  return startLab({ checkpointId: saved.lab.checkpointId, build: saved.lab.build,
    timeLimitMs: saved.lab.timeLimitMs, instruction: saved.lab.instruction, checks: saved.lab.checks });
}

async function showRun(saved) {
  selected = saved.id;
  $('runs-list-view').hidden = true;
  $('run-detail-view').hidden = false;
  $('run-detail-title').textContent = saved.id;
  const panel = $('run-detail-content');
  const review = saved.reflection;
  const reviewMarkup = review?.summary || review?.cause || review?.error ? `<section class="run-library-event" aria-label="Death review">
    <h3>Death review</h3>
    ${reviewCategory[review.category] ? `<p class="run-library-meta">${esc(reviewCategory[review.category])}</p>` : ''}
    <p class="trace-text">${esc(review.summary ?? review.cause ?? review.error)}</p>
    ${Array.isArray(review.evidence) && review.evidence.length ? `<ul>${review.evidence.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
    ${review.uncertainty ? `<p class="trace-text"><strong>Uncertainty</strong> ${esc(review.uncertainty)}</p>` : ''}
    ${review.reviewQuestion ? `<p class="trace-text"><strong>Question for review</strong> ${esc(review.reviewQuestion)}</p>` : ''}
    </section>` : '';
  const labFacts = saved.lab ? `<section class="run-library-event" aria-label="Test result">
      <h3>${esc(saved.lab.fixtureName ?? 'Checkpoint replay')}</h3>
      <p class="run-library-meta">${saved.lab.type === 'fixture'
        ? `Fixture ${esc(saved.lab.fixtureId)} · version ${esc(saved.lab.fixtureVersion)}`
        : `Checkpoint ${esc(saved.lab.checkpointId)}`}</p>
      <p class="run-library-meta">${esc(saved.lab.build ?? 'current')} build · fork ${esc(saved.runtime?.forkCommit ?? 'unknown')} · image ${esc(saved.runtime?.imageDigest ?? 'unknown')}</p>
      ${saved.lab.type === 'checkpoint' ? `<p class="run-library-meta">${saved.lab.context
        ? `Conversation saved ${Math.max(0, Math.round((saved.lab.contextAgeMs ?? 0) / 60_000))} minutes before the world save`
        : 'World saved without a conversation'}</p>` : ''}
      <p class="trace-text">Stopped: ${esc(saved.labStopReason ?? 'unknown')}</p>
      ${saved.labOutcome ? `<pre class="trace-output lab-result-evidence">${esc(JSON.stringify(saved.labOutcome, null, 2))}</pre>` : ''}
      <button id="repeat-lab" type="button">Repeat</button>
    </section>` : '';
  panel.innerHTML = `<h2 class="run-detail-heading">${esc(saved.lab?.fixtureName ?? (saved.lab ? 'Checkpoint replay' : 'Beat the Ender Dragon'))}</h2>
    <dl class="run-detail-facts"><dt>Status</dt><dd>${esc(title(saved.state))}</dd>
      <dt>Seed</dt><dd>${esc(saved.seed)}</dd><dt>Model</dt><dd>${esc(saved.model)}</dd>
      <dt>Reasoning</dt><dd>${esc(title(saved.thinkingLevel))}</dd></dl>
    <section class="run-recording" aria-label="First-person recording">
      <div class="run-library-meta">First-person recording</div>
      <p id="saved-recording-status" class="run-library-meta">Checking recording…</p>
      <video id="saved-recording" controls playsinline preload="metadata" hidden></video>
      <a id="download-recording" hidden>Download WebM</a>
    </section>
    <p class="run-library-meta">${esc(saved.detail)}</p>${labFacts}${reviewMarkup}<button id="saved-more" class="load-more" hidden>Load older activity</button>
    <div id="saved-messages" class="run-detail-timeline"></div>`;
  if (saved.lab) $('repeat-lab').onclick = () => repeatLab(saved);
  const recordingUrl = `/api/recording?id=${encodeURIComponent(saved.id)}`;
  try {
    const response = await fetch(recordingUrl, { method: 'HEAD' });
    if (selected !== saved.id) return;
    if (response.ok) {
      $('saved-recording').src = recordingUrl;
      $('saved-recording').hidden = false;
      $('download-recording').href = recordingUrl;
      $('download-recording').download = `${saved.id}.webm`;
      $('download-recording').hidden = false;
      $('saved-recording-status').hidden = true;
    } else {
      $('saved-recording-status').textContent = 'No playable recording is available for this run.';
    }
  } catch {
    if (selected === saved.id) $('saved-recording-status').textContent = 'Could not load this recording.';
  }
  const entries = [];
  async function load(cursor) {
    try {
      const page = await loadConversation(saved.id, cursor);
      if (selected !== saved.id) return;
      entries.unshift(...page.messages);
      $('saved-messages').innerHTML = traceMarkup(entries);
      $('saved-more').hidden = !page.before;
      $('saved-more').onclick = () => load(page.before);
    } catch (error) {
      if (selected === saved.id) showError(error.message);
    }
  }
  await load();
}

$('theme-toggle').onclick = () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  setTheme(theme);
  try { localStorage.setItem('minecraft-agent-theme', theme); } catch {}
};
$('start').onclick = () => control('start');
$('stop').onclick = () => control('stop');
$('run-mode').onchange = renderStatus;
$('conversation-tab').onclick = () => showTab('conversation');
$('runs-tab').onclick = () => showTab('runs');
$('refresh-runs').onclick = showRuns;
$('back-to-runs').onclick = showRuns;
$('run-fixture').onclick = () => startLab({ fixtureId: $('lab-fixture').value, build: $('lab-build').value });
$('run-checkpoint').onclick = () => {
  try {
    const timeLimitMs = Number($('lab-time-limit').value) * 60_000;
    startLab({ checkpointId: $('lab-checkpoint').value, build: $('lab-build').value, timeLimitMs,
      instruction: $('lab-instruction').value, checks: checkpointChecks() });
  } catch (error) {
    $('lab-launch-status').textContent = error.message;
  }
};
$('trace-bottom').onclick = () => { timeline.scrollTop = timeline.scrollHeight; };
timeline.addEventListener('scroll', () => { $('trace-bottom').hidden = atBottom(); });
$('more').onclick = async () => {
  const id = run.id;
  $('more').disabled = true;
  try {
    const page = await loadConversation(id, before);
    if (id !== run.id) return;
    before = page.before;
    for (const message of page.messages) messages.set(message.offset, message);
    renderConversation(true);
  } catch (error) {
    showError(error.message);
  } finally {
    $('more').disabled = false;
  }
};
setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
refresh();
