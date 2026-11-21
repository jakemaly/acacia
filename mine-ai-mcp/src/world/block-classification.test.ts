import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import {
  isFullCubeBlockItem,
  isAir,
  isDryPlacementSite,
  isLiquid,
  isReplaceableForPlacement,
  supportsFlatPlacement,
  type ClassifiedBlock,
} from "./block-classification.js";

const registry = minecraftData("1.21.4");

const block = (name: string, boundingBox: ClassifiedBlock["boundingBox"] = "empty"): ClassifiedBlock => ({
  name,
  boundingBox,
});

test("classifies placement cells and support", () => {
  assert.equal(isAir(block("cave_air")), true);
  assert.equal(isLiquid(block("water")), true);
  assert.equal(isReplaceableForPlacement(block("tall_grass")), true);
  assert.equal(isReplaceableForPlacement(block("orange_tulip")), true);
  assert.equal(isReplaceableForPlacement(block("torch")), false);
  assert.equal(supportsFlatPlacement(block("stone", "block")), true);
  assert.equal(supportsFlatPlacement(null), false);
});

test("protection materials must be registered full-cube placeable blocks", () => {
  const bot = { registry } as unknown as Pick<Bot, "registry">;
  assert.equal(isFullCubeBlockItem(bot, "cobblestone"), true);
  assert.equal(isFullCubeBlockItem(bot, "oak_slab"), false);
  assert.equal(isFullCubeBlockItem(bot, "torch"), false);
  assert.equal(isFullCubeBlockItem(bot, "water"), false);
});

/**
 * Vanilla replaces a fluid cell with the block being placed, source included.
 * That is how a lava face is closed before a target break and how a pour cell
 * is made in solid rock. A *site chosen for* the bot is a different question.
 */
test("a fluid cell takes a placement, but is never chosen as a site", () => {
  for (const liquid of ["water", "lava"]) {
    assert.equal(isReplaceableForPlacement(block(liquid)), true);
    assert.equal(isDryPlacementSite(block(liquid)), false);
  }
  assert.equal(isDryPlacementSite(block("cave_air")), true);
  assert.equal(isDryPlacementSite(block("torch")), false);
});
