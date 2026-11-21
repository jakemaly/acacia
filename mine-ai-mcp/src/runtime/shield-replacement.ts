import type { Bot } from "mineflayer";
import type { BodyOwner } from "../session/body-owner.js";
import { ensureOffHandShield, holdsShield, OFF_HAND_SLOT } from "../survival/weapons/equipment.js";

/** Replenish a broken off-hand after its current physical owner has finished. */
export function attachShieldReplacement(bot: Bot, runner: BodyOwner, shieldAllowed: () => boolean): Disposable {
  let previousShield = holdsShield(bot);
  let pending = false;
  let sawEmpty = false;
  let inFlight = false;
  let disposed = false;
  let retryTicks = 0;
  const slotChanged = (slot: number, oldItem: { name: string } | null, item: { name: string } | null) => {
    if (slot !== OFF_HAND_SLOT) return;
    if (oldItem?.name === "shield" && !item) previousShield = true;
    else if (item) previousShield = item.name === "shield";
    if (pending && !item) sawEmpty = true;
  };
  const broken = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity.id || packet.entityStatus !== 48 || (!holdsShield(bot) && !previousShield)) return;
    // The packet names a slot, not an item: retain it until removal so a slow
    // inventory update cannot hide a real break, even if a replacement raced it.
    pending = true;
    sawEmpty = !bot.inventory.slots[OFF_HAND_SLOT];
    retryTicks = 0;
  };
  const tick = () => {
    if (disposed || !pending || inFlight) return;
    if (!bot.inventory.slots[OFF_HAND_SLOT]) sawEmpty = true;
    if (sawEmpty && holdsShield(bot)) { pending = false; return; }
    if (!sawEmpty || bot.inventory.slots[OFF_HAND_SLOT] || !shieldAllowed() ||
      bot.usingHeldItem || bot.currentWindow || runner.status().busy) return;
    if (retryTicks > 0) { retryTicks--; return; }
    const shield = bot.inventory.items().find(item => item.name === "shield");
    if (!shield) return;
    inFlight = true;
    const claim = runner.claim("shield_replacement", "Replace a broken off-hand shield", async signal => {
      signal.throwIfAborted();
      if (shieldAllowed() && !bot.usingHeldItem && !bot.currentWindow && !bot.inventory.slots[OFF_HAND_SLOT])
        await ensureOffHandShield(bot, shield);
      return { value: undefined, continuation: { kind: "resume" } };
    });
    if (claim.kind !== "claimed") { inFlight = false; return; }
    void claim.outcome.catch(() => { retryTicks = 20; }).finally(() => { inFlight = false; });
  };
  const respawn = () => { previousShield = false; pending = false; sawEmpty = false; };
  bot.inventory.on("updateSlot", slotChanged);
  bot._client?.on("entity_status", broken);
  bot.on("physicsTick", tick);
  bot.on("respawn", respawn);
  return { [Symbol.dispose]() {
    disposed = true;
    bot.inventory.off("updateSlot", slotChanged);
    bot._client?.off("entity_status", broken);
    bot.off("physicsTick", tick);
    bot.off("respawn", respawn);
  } };
}
