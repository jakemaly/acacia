import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Vec3 } from "vec3";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { structureAuditSchema, type StructureCell } from "../build-structure/contract.js";
import { registryNameSchema } from "../registry-name.js";
import {
  endermanUmbrellaPositions,
  type EndermanUmbrellaAxis,
} from "../../survival/positioning/combat/enderman-umbrella.js";
export {
  ENDERMAN_TUCK_FACE_TOLERANCE,
  ENDERMAN_TUCK_LANE_TOLERANCE,
  endermanPillarTuckPosition,
  isEndermanPillarTuckPosition,
} from "../../survival/positioning/combat/enderman-umbrella.js";
export type { EndermanPillarSide, EndermanUmbrellaAxis } from "../../survival/positioning/combat/enderman-umbrella.js";

export const HUNT_ENDERMEN_UNDER_UMBRELLA = "hunt_endermen_under_umbrella" as const;
export const HUNT_ENDERMEN_UNDER_UMBRELLA_DESCRIPTION =
  "Invoke this action when deliberately hunting nearby Endermen and a clear, supported building area is available. Build a 3-block pillar with a 5x1 block canopy at its top, aligned toward the nearest Enderman, tuck beneath the canopy, and fight loaded Endermen with the shared melee combat controller. " +
  "The bot does not chase them. Requires a clear, supported canopy line and enough of one carried full block to finish the structure (7 blocks when nothing is already built). The structure stays in the world; after no Endermen remain near it for a finite quiet window, the bot leaves the canopy for a verified safe position. Other hostile reflexes and survival protections remain active; automatic Enderman responses are held only while the structure is intact and the bot is tucked beneath its canopy.";

export const huntEndermenUnderUmbrellaInputSchema = z.strictObject({
  block_name: registryNameSchema.default("cobblestone").describe(
    "Carried full-cube block used for the pillar and canopy. Defaults to cobblestone; the same block must be used for all 7 cells.",
  ),
  absence_window_ms: z.number().int().min(1_000).max(60_000).default(5_000).describe(
    "How long the local area must remain free of Endermen before the hunt is considered settled. Defaults to 5 seconds.",
  ),
  time_limit_ms: z.number().int().min(15_000).max(600_000).default(180_000).describe(
    "Maximum time spent fighting and waiting after the shelter is built. Defaults to 3 minutes; building time is separately bounded by navigation.",
  ),
});

export interface HuntEndermenUnderUmbrellaRequest {
  readonly blockName: string;
  readonly absenceWindowMs: number;
  readonly timeLimitMs: number;
}

export function parseHuntEndermenUnderUmbrellaRequest(input: unknown): HuntEndermenUnderUmbrellaRequest {
  const value = huntEndermenUnderUmbrellaInputSchema.parse(input ?? {});
  return {
    blockName: value.block_name,
    absenceWindowMs: value.absence_window_ms,
    timeLimitMs: value.time_limit_ms,
  };
}

export function endermanUmbrellaCells(
  pillar: { readonly x: number; readonly y: number; readonly z: number },
  blockName: string,
  axis: EndermanUmbrellaAxis,
): StructureCell[] {
  return endermanUmbrellaPositions(new Vec3(pillar.x, pillar.y, pillar.z), axis)
    .map(({ x, y, z }) => ({ x, y, z, blockName }));
}

export const HUNT_ENDERMEN_TERMINATIONS = [
  "threats_gone",
  "time_limit",
  "structure_blocked",
  "materials_missing",
  "invalid_material",
  "unsafe_start",
  "position_lost",
  "safe_exit_blocked",
  "target_not_killed",
  "combat_blocked",
  "bot_died",
  "interrupted",
  "execution_failed",
] as const;

const positionSchema = z.strictObject({ x: z.number(), y: z.number(), z: z.number() });

export const huntEndermenUnderUmbrellaCheckpointSchema = z.strictObject({
  phase: z.enum(["validating", "building", "tucking_in", "fighting", "waiting", "leaving"]),
  pillar: positionSchema.nullable(),
  station: positionSchema.nullable(),
  structureComplete: z.boolean(),
  elapsedMs: z.number().int().nonnegative(),
  deadlineAt: z.number(),
  attacks: z.number().int().nonnegative(),
  killsObserved: z.number().int().nonnegative(),
  nearbyEndermen: z.number().int().nonnegative(),
  absenceSince: z.number().nullable(),
});

const targetSchema = z.strictObject({
  id: z.number().int(),
  position: positionSchema,
  distance: z.number().nonnegative(),
});

export const huntEndermenUnderUmbrellaResultSchema = actionResultSchema({
  structure: structureAuditSchema.nullable(),
  pillar: positionSchema.nullable(),
  station: positionSchema.nullable(),
  finalPosition: positionSchema,
  relativePosition: z.strictObject({ x: z.number(), z: z.number(), withinPillarBounds: z.boolean() }),
  leftShelter: z.boolean(),
  combat: z.strictObject({
    engagements: z.number().int().nonnegative(),
    killsObserved: z.number().int().nonnegative(),
    attacks: z.number().int().nonnegative(),
    styles: z.array(z.enum(["bow", "shielded_melee", "melee"])),
    weapons: z.array(z.string()),
  }),
  remaining: z.array(targetSchema).max(16),
  termination: z.enum(HUNT_ENDERMEN_TERMINATIONS),
});

export type HuntEndermenUnderUmbrellaResult = z.output<typeof huntEndermenUnderUmbrellaResultSchema>;
export type HuntEndermenUnderUmbrellaOutput = ActionOutput<typeof HUNT_ENDERMEN_UNDER_UMBRELLA, HuntEndermenUnderUmbrellaResult>;

export const huntEndermenUnderUmbrellaAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} satisfies ToolAnnotations;
