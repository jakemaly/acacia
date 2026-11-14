function variant(tool, name, description, { omit, require = [], operation, operations }) {
  const properties = { ...tool.inputSchema.properties };
  for (const key of omit) delete properties[key];
  if (operations) properties.operation = { ...properties.operation, enum: operations };
  return {
    ...tool, name, description, target: tool.name, operation,
    inputSchema: {
      ...tool.inputSchema, properties,
      required: [...(tool.inputSchema.required ?? []).filter(key => !omit.includes(key)), ...require],
    },
  };
}

export function gameTools(catalogue) {
  return catalogue.flatMap(tool => {
    if (tool.name === 'collect_block' && tool.inputSchema.properties?.x) return [
      variant(tool, 'collect_block',
        'Gather a batch of item drops from matching blocks. Give the block name and how many drops you need (up to 32). The bot selects reachable targets, routes to them, equips its tool, mines, and picks up the drops. Supply a unique submission_id and optionally wait_timeout_ms.',
        { omit: ['x', 'y', 'z'], require: ['count'] }),
      variant(tool, 'collect_exact_block',
        'Mine and collect one specific block at these exact coordinates. Use this when this individual block matters, such as recovering a workstation or clearing an obstruction. Supply a unique submission_id and optionally wait_timeout_ms.',
        { omit: ['count'], require: ['x', 'y', 'z'] }),
    ];
    if (tool.name === 'build_structure') return [
      variant(tool, 'build_structure',
        'Build or excavate a list of absolute block cells as one job. Walk between cells, place or dig, and report remaining blockers. An air cell is a dig target. Supply a unique submission_id and optionally wait_timeout_ms.',
        { omit: ['portal_frame'], require: ['blocks'] }),
      variant(tool, 'build_portal_frame',
        'Build a new unlit Nether portal frame, including clearing its six interior cells. Check an existing lit portal with view_blocks. Supply a unique submission_id and optionally wait_timeout_ms.',
        { omit: ['blocks'], require: ['portal_frame'] }),
    ];
    if (tool.name === 'use_container') return [
      variant(tool, 'use_container',
        'Inspect a chest or transfer a batch of items. Use items only for deposit or withdraw. Specify the container block position. Supply a unique submission_id and optionally wait_timeout_ms. The result verifies the transfer.',
        { omit: ['item_order'], operations: ['inspect', 'deposit', 'withdraw'] }),
      variant(tool, 'organize_container',
        'Compact a chest and sort it by item_order. List every distinct item exactly once. Supply a unique submission_id and optionally wait_timeout_ms.',
        { omit: ['operation', 'items'], require: ['item_order'], operation: 'organize' }),
    ];
    if (tool.name === 'view_status') return [{
      ...tool,
      description: 'Get compact live status: position, vitals, active action, equipment, inventory counts, and nearby threats. Request detail=full for slot details, loaded mobs and drops, or other full diagnostics.',
      inputSchema: { ...tool.inputSchema, properties: { ...tool.inputSchema.properties,
        detail: { type: 'string', enum: ['compact', 'full'] },
      } },
    }];
    if (tool.name === 'view_blocks') return [{
      ...tool,
      description: 'Read loaded blocks without moving. Use cells for exact coordinates, find for a short list of nearest matching blocks, or box when you need a terrain cross-section. Set find.limit to request more matches.',
    }];
    return [tool];
  });
}

export function gameArguments(tool, args) {
  if (tool.operation) return { ...args, operation: tool.operation };
  if (tool.name === 'view_blocks' && args.find && args.find.limit === undefined) {
    return { ...args, find: { ...args.find, limit: 4 } };
  }
  if (tool.name !== 'view_status') return args;
  const { detail, ...input } = args;
  return detail !== 'full' && input.response_format !== 'json' ? { ...input, response_format: 'json' } : input;
}

export function continueProductiveAction(result, tool, count) {
  if (!['collect_block', 'collect_mob_drop'].includes(tool) || !(count > 1)) return false;
  if (result?.state !== 'pending' || result.progress?.progress?.state !== 'running') return false;
  const { vitalsDuringWait: vitals, duringWait } = result;
  if (!vitals || !duringWait || vitals.healthAfter < vitals.healthBefore || duringWait.toolChanges.length ||
      duringWait.reflexActivity.some(activity => activity.kind === 'response')) return false;
  return duringWait.checkpointDelta.gained > 0;
}

export function statusContent(payload) {
  const snapshot = payload?.response?.data?.result;
  if (snapshot?.status !== 'succeeded' || !snapshot.situation) return;
  const { dimension, gameMode, position, vitals, inventory, mobility, nearby, activity, clock, observedAt, endFight } = snapshot.situation;
  const at = point => [point.x, point.y, point.z].map(value => Math.round(value * 100) / 100).join(', ');
  const counts = new Map();
  for (const { name, location, count } of inventory.stacks) {
    if (location === 'main' || location === 'hotbar') counts.set(name, (counts.get(name) ?? 0) + count);
  }
  const gear = inventory.stacks.filter(stack => stack.held || !['main', 'hotbar'].includes(stack.location))
    .map(stack => `${stack.held ? 'hand' : stack.location} ${stack.name}${stack.durability
      ? ` (${stack.durability.remaining}/${stack.durability.maximum})` : ''}`);
  const { active, awaitingResult, storageError } = payload.foreground ?? {};
  const action = active ?? awaitingResult;
  const threats = nearby.hostiles.map(threat => `${threat.name} ${threat.distance} blocks at ${at(threat.position)}`);
  const lines = [
    `${dimension} (${gameMode}) at ${at(position)} · ${observedAt}`,
    `Health ${vitals.health}/20 · Hunger ${vitals.food}/20 · Saturation ${vitals.saturation} · Air ${vitals.airSupplyTicks ?? 'unknown'} ticks`,
    `Ground ${position.onGround} · Water ${position.inWater} · Lava ${position.inLava ?? 'unknown'} · Burning ${vitals.burning ?? 'unknown'}`,
    clock.phase ? `${clock.phase}, changes in ${clock.ticksUntilChange} ticks` : null,
    `Action: ${activity.owner}${action ? ` · ${action.action} ${action.actionId}${awaitingResult ? ' · result ready' : ''}`
      : activity.activeAction ? ` · ${activity.activeAction.action}` : ''}`,
    storageError ? `Action storage error: ${storageError}` : null,
    `Hostiles within ${nearby.rangeBlocks} blocks: ${threats.join('; ') || 'none observed'}`,
    `Scaffold: ${mobility.scaffold.item ?? 'none'} × ${mobility.scaffold.blocks} · Free slots ${inventory.freeSlots}`,
    `Equipped: ${gear.join(', ') || 'none'}`,
    `Carried: ${[...counts].map(([name, count]) => `${name} × ${count}`).join(', ') || 'nothing'}`,
    dimension === 'the_end' ? `Loaded End fight: ${JSON.stringify(endFight)}` : null,
    payload.notifications?.unreadCount ? `Unread events: ${payload.notifications.unreadCount}. ${payload.notifications.recentPreview?.join(' · ') ?? ''}` : null,
  ];
  return [{ type: 'text', text: lines.filter(Boolean).join('\n') }];
}
