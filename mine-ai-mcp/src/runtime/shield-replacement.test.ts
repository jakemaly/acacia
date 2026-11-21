import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ActionRunner } from "../runner/action-runner.js";
import { deferred, nextTurn } from "../test-support/async.js";
import { botFixture } from "../test-support/bot.js";
import { attachShieldReplacement } from "./shield-replacement.js";

test("a broken offhand shield is replaced after the current owner releases the body", async () => {
  const spare = { name: "shield", count: 1 };
  const bot = botFixture({ items: [spare], slots: { 45: { name: "shield" } } });
  Object.assign(bot, { _client: new EventEmitter(), equip: async (item: typeof spare) => {
    bot.inventory.slots[45] = item as never;
  } });
  const runner = new ActionRunner();
  const release = deferred();
  const owner = runner.claim("hostile_reflex", "defend", async () => {
    await release.promise;
    return { value: null, continuation: { kind: "resume" } };
  });
  assert.equal(owner.kind, "claimed");
  using _replacement = attachShieldReplacement(bot, runner, () => true);
  bot.inventory.slots[45] = null;
  bot.inventory.emit("updateSlot", 45, { name: "shield" }, null);
  bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: 48 });
  for (let i = 0; i < 60; i++) bot.emit("physicsTick");
  await nextTurn();
  assert.equal(bot.inventory.slots[45], null, "replacement must not preempt the active owner");
  release.resolve();
  if (owner.kind === "claimed") await owner.outcome;
  for (let i = 0; i < 10 && !bot.inventory.slots[45]; i++) { bot.emit("physicsTick"); await nextTurn(); }
  assert.equal(bot.inventory.slots[45], spare);
});

test("a break notice before slot removal waits for a spare and the shield policy", async () => {
  const spare = { name: "shield", count: 1 };
  const bot = botFixture({ items: [], slots: { 45: { name: "shield" } } });
  Object.assign(bot, { _client: new EventEmitter(), equip: async (item: typeof spare) => {
    bot.inventory.slots[45] = item as never;
  } });
  let allowed = false;
  using _replacement = attachShieldReplacement(bot, new ActionRunner(), () => allowed);
  bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: 48 });
  for (let i = 0; i < 60; i++) bot.emit("physicsTick");
  assert.equal(bot.inventory.slots[45]?.name, "shield");
  bot.inventory.slots[45] = null;
  bot.inventory.emit("updateSlot", 45, { name: "shield" }, null);
  bot.emit("physicsTick");
  bot.inventory.items().push(spare as never);
  bot.emit("physicsTick");
  await nextTurn();
  assert.equal(bot.inventory.slots[45], null, "policy forbids automatic shields");
  allowed = true;
  bot.emit("physicsTick");
  await nextTurn();
  assert.equal(bot.inventory.slots[45], spare);
});

test("ordinary removal and another entity's break do not replace the offhand", async () => {
  const bot = botFixture({ items: [{ name: "shield", count: 1 }], slots: { 45: { name: "shield" } } });
  let equips = 0;
  Object.assign(bot, { _client: new EventEmitter(), equip: async () => { equips++; } });
  using _replacement = attachShieldReplacement(bot, new ActionRunner(), () => true);
  bot.inventory.slots[45] = null;
  bot.inventory.emit("updateSlot", 45, { name: "shield" }, null);
  bot._client.emit("entity_status", { entityId: bot.entity.id + 1, entityStatus: 48 });
  bot.emit("physicsTick");
  await nextTurn();
  assert.equal(equips, 0);
});

test("a genuine break after an ordinary shield swap still replaces the shield", async () => {
  const spare = { name: "shield", count: 1 };
  const bot = botFixture({ items: [spare], slots: { 45: { name: "shield" } } });
  let equips = 0;
  Object.assign(bot, { _client: new EventEmitter(), equip: async (item: typeof spare) => {
    equips++;
    bot.inventory.slots[45] = item as never;
  } });
  const runner = new ActionRunner();
  const release = deferred();
  const owner = runner.claim("hostile_reflex", "defend", async () => {
    await release.promise;
    return { value: null, continuation: { kind: "resume" } };
  });
  using _replacement = attachShieldReplacement(bot, runner, () => true);
  bot.inventory.slots[45] = null;
  bot.inventory.emit("updateSlot", 45, { name: "shield" }, null);
  bot.inventory.slots[45] = spare as never;
  bot.inventory.emit("updateSlot", 45, null, spare);
  bot._client.emit("entity_status", { entityId: bot.entity.id, entityStatus: 48 });
  bot.inventory.slots[45] = null;
  bot.inventory.emit("updateSlot", 45, spare, null);
  release.resolve();
  if (owner.kind === "claimed") await owner.outcome;
  bot.emit("physicsTick");
  await nextTurn();
  assert.equal(equips, 1);
});
