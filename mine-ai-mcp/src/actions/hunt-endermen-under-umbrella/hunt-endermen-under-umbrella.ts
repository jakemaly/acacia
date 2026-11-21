import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, type NavigationRuntime } from "../../navigation/index.js";
import { BodyAbort } from "../../session/abort.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import type { CombatController, CombatStyle } from "../../survival/index.js";
import { readCombatItems } from "../../survival/weapons/equipment.js";
import { meleeDistance } from "../../survival/index.js";
import { waitForSignal } from "../../utils/index.js";
import { isDryPlacementSite, isFullCubeBlockItem } from "../../world/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { createBuildStructurePhysics, buildStructure } from "../build-structure/build-structure.js";
import type { BuildStructureResult, StructureCell } from "../build-structure/contract.js";
import {
  HUNT_ENDERMEN_UNDER_UMBRELLA,
  HUNT_ENDERMEN_UNDER_UMBRELLA_DESCRIPTION,
  ENDERMAN_TUCK_FACE_TOLERANCE,
  ENDERMAN_TUCK_LANE_TOLERANCE,
  huntEndermenUnderUmbrellaAnnotations,
  huntEndermenUnderUmbrellaCheckpointSchema,
  huntEndermenUnderUmbrellaInputSchema,
  huntEndermenUnderUmbrellaResultSchema,
  endermanUmbrellaCells,
  endermanPillarTuckPosition,
  isEndermanPillarTuckPosition,
  parseHuntEndermenUnderUmbrellaRequest,
  type EndermanPillarSide,
  type EndermanUmbrellaAxis,
  type HuntEndermenUnderUmbrellaRequest,
  type HuntEndermenUnderUmbrellaResult,
} from "./contract.js";

type Entity = Parameters<Bot["attack"]>[0];
type Side = EndermanPillarSide;
type Plan = {
  readonly pillar: Vec3;
  readonly stationCell: Vec3;
  readonly tucked: { readonly x: number; readonly y: number; readonly z: number };
  readonly axis: EndermanUmbrellaAxis;
  readonly cells: readonly StructureCell[];
};

const SIDES: readonly Side[] = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
];
const HUNT_RADIUS = 12;
const MAX_TARGETS = 16;

function positionOf(position: { readonly x: number; readonly y: number; readonly z: number }) {
  return { x: position.x, y: position.y, z: position.z };
}

function planPosition(bot: Bot, side: Side, blockName: string): Plan {
  const stationCell = bot.entity.position.floored();
  const pillar = stationCell.offset(side.x, 0, side.z);
  const axis: EndermanUmbrellaAxis = side.x !== 0 ? "x" : "z";
  const cells = endermanUmbrellaCells(pillar, blockName, axis);
  return {
    pillar,
    stationCell,
    tucked: endermanPillarTuckPosition(pillar, stationCell, side),
    axis,
    cells,
  };
}

function hasBlockSupport(bot: Bot, position: Vec3): boolean {
  return bot.blockAt(position)?.boundingBox === "block";
}

function isFullProtectionBlock(bot: Bot, blockName: string): boolean {
  return isFullCubeBlockItem(bot, blockName);
}

function placementSpaceIsClear(bot: Bot, plan: Plan, blockName: string): boolean {
  if (!hasBlockSupport(bot, plan.stationCell.offset(0, -1, 0)) || !hasBlockSupport(bot, plan.pillar.offset(0, -1, 0)))
    return false;

  const targetNames = new Map(plan.cells.map((cell) => [cell.x + "," + cell.y + "," + cell.z, cell.blockName]));
  for (let offset = -2; offset <= 2; offset += 1) {
    const x = plan.pillar.x + (plan.axis === "x" ? offset : 0);
    const z = plan.pillar.z + (plan.axis === "z" ? offset : 0);
    for (let dy = 0; dy <= 2; dy += 1) {
      const at = new Vec3(x, plan.pillar.y + dy, z);
      const block = bot.blockAt(at);
      if (block === null) return false;
      const target = targetNames.get(at.x + "," + at.y + "," + at.z);
      if (target === blockName && block.name === blockName) continue;
      if (!isDryPlacementSite(block)) return false;
    }
  }
  return true;
}

function nearestEnderman(bot: Bot): Entity | null {
  return Object.values(bot.entities)
    .filter((entity) => entity.isValid && entity.name === "enderman")
    .sort((left, right) =>
      left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position),
    )[0] ?? null;
}

function sideOrder(bot: Bot): Side[] {
  const nearest = nearestEnderman(bot);
  const toward = nearest
    ? nearest.position.minus(bot.entity.position)
    : new Vec3(Math.sin(bot.entity.yaw), 0, Math.cos(bot.entity.yaw));
  return [...SIDES].sort((left, right) =>
    right.x * toward.x + right.z * toward.z - (left.x * toward.x + left.z * toward.z),
  );
}

function choosePlan(bot: Bot, blockName: string): Plan | null {
  for (const side of sideOrder(bot)) {
    const plan = planPosition(bot, side, blockName);
    if (placementSpaceIsClear(bot, plan, blockName)) return plan;
  }
  return null;
}

function requiredBlocks(bot: Bot, plan: Plan, blockName: string): number {
  return plan.cells.filter((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name !== blockName).length;
}

function carried(bot: Bot, name: string): number {
  return bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

function structureComplete(bot: Bot, cells: readonly StructureCell[]): boolean {
  return cells.every((cell) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name === cell.blockName);
}

function inTuckedPosition(position: Vec3, plan: Plan): boolean {
  return isEndermanPillarTuckPosition(position, plan.pillar, plan.axis);
}

function inIntendedTuck(position: Vec3, plan: Plan): boolean {
  const faceTolerance = ENDERMAN_TUCK_FACE_TOLERANCE;
  const laneTolerance = ENDERMAN_TUCK_LANE_TOLERANCE;
  return (plan.axis === "x"
    ? Math.abs(position.x - plan.tucked.x) <= faceTolerance && Math.abs(position.z - plan.tucked.z) <= laneTolerance
    : Math.abs(position.x - plan.tucked.x) <= laneTolerance && Math.abs(position.z - plan.tucked.z) <= faceTolerance) &&
    Math.abs(position.y - plan.tucked.y) <= 0.15 &&
    inTuckedPosition(position, plan);
}

function outsideCanopy(position: Vec3, plan: Plan): boolean {
  const x = position.x - plan.pillar.x;
  const z = position.z - plan.pillar.z;
  return plan.axis === "x"
    ? z < -0.3 || z > 1.3
    : x < -0.3 || x > 1.3;
}

function safeExitCells(plan: Plan): Vec3[] {
  return plan.axis === "x"
    ? [plan.stationCell.offset(0, 0, -1), plan.stationCell.offset(0, 0, 1)]
    : [plan.stationCell.offset(-1, 0, 0), plan.stationCell.offset(1, 0, 0)];
}

function localEndermen(bot: Bot, center: Vec3, deadTargets: ReadonlySet<number> = new Set()): Entity[] {
  return Object.values(bot.entities)
    .filter((entity) =>
      entity.isValid && !deadTargets.has(entity.id) && entity.name === "enderman" &&
        entity.position.distanceTo(center) <= HUNT_RADIUS,
    )
    .sort((left, right) =>
      meleeDistance(bot, left) - meleeDistance(bot, right) ||
      left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position),
    );
}

function targetEvidence(bot: Bot, center: Vec3, deadTargets: ReadonlySet<number>) {
  return localEndermen(bot, center, deadTargets).slice(0, MAX_TARGETS).map((entity) => ({
    id: entity.id,
    position: positionOf(entity.position),
    distance: Number(entity.position.distanceTo(bot.entity.position).toFixed(2)),
  }));
}

function formatResult(result: HuntEndermenUnderUmbrellaResult): string {
  const lines = [
    result.structure?.complete
      ? "The 3-block pillar and 5x1 canopy are complete (" + result.structure.cells + " cells)."
      : result.structure
        ? "The shelter is incomplete: " + result.structure.correct + "/" + result.structure.cells + " cells correct."
        : "The shelter was not built.",
    "Pillar: " + (result.pillar ? result.pillar.x + "," + result.pillar.y + "," + result.pillar.z : "not selected") +
      "; final position: " + JSON.stringify(result.finalPosition) +
      "; relative to pillar: " + JSON.stringify(result.relativePosition) + ".",
    "Combat: " + result.combat.engagements + " engagements, " + result.combat.killsObserved +
      " observed kills, " + result.combat.attacks + " attacks" +
      (result.combat.weapons.length ? " with " + [...new Set(result.combat.weapons)].join(", ") : "") + ".",
    "Termination: " + result.termination + ".",
    "Left shelter after the area was safe: " + result.leftShelter + ".",
    ...(result.remaining.length
      ? ["Endermen still loaded within " + HUNT_RADIUS + " blocks: " +
        result.remaining.map((target) => "#" + target.id + " at " +
          target.position.x.toFixed(1) + "," + target.position.y.toFixed(1) + "," +
          target.position.z.toFixed(1) + " (" + target.distance + " blocks)").join("; ") + "."]
      : []),
  ];
  if (result.status !== "succeeded") lines.push("Observed stop: " + result.error);
  return lines.join("\n");
}

export function createHuntEndermenUnderUmbrellaAction(
  bot: Bot,
  navigation: NavigationRuntime,
  combat: CombatController,
) {
  return defineAction({
    checkpointSchema: huntEndermenUnderUmbrellaCheckpointSchema,
    name: HUNT_ENDERMEN_UNDER_UMBRELLA,
    description: HUNT_ENDERMEN_UNDER_UMBRELLA_DESCRIPTION,
    inputSchema: huntEndermenUnderUmbrellaInputSchema,
    resultSchema: huntEndermenUnderUmbrellaResultSchema,
    formatResult,
    execution: {
      kind: "resumable_task",
      prepare: () => prepareBotForMovement(bot, navigation),
    },
    annotations: huntEndermenUnderUmbrellaAnnotations,
    parse: parseHuntEndermenUnderUmbrellaRequest,
    begin: (request: HuntEndermenUnderUmbrellaRequest, lifetime, observe) => {
      const startedAt = Date.now();
      let phase: "validating" | "building" | "tucking_in" | "fighting" | "waiting" | "leaving" = "validating";
      let plan: Plan | null = null;
      let build: BuildStructureResult | null = null;
      let structureIsComplete = false;
      let leftShelter = false;
      let fightStartedAt: number | null = null;
      let deadlineAt = 0;
      let absenceSince: number | null = null;
      let engagements = 0;
      let killsObserved = 0;
      let attacks = 0;
      const styles = new Set<CombatStyle>();
      const weapons = new Set<string>();
      const retryAt = new Map<number, { position: Vec3; at: number }>();
      const deadTargets = new Set<number>();
      const onEntityDead = (entity: Entity) => {
        if (entity.name === "enderman") deadTargets.add(entity.id);
      };
      bot.on("entityDead", onEntityDead);
      lifetime.addEventListener("abort", () => bot.off("entityDead", onEntityDead), { once: true });

      let lastShelterCheck = Number.NEGATIVE_INFINITY;
      let cachedShelterActive = false;
      const shelteredAndTucked = () => {
        const now = Date.now();
        if (now - lastShelterCheck >= 250) {
          lastShelterCheck = now;
          cachedShelterActive = plan !== null &&
            structureComplete(bot, plan.cells) &&
            inTuckedPosition(bot.entity.position, plan);
        }
        return cachedShelterActive;
      };
      combat.policy.holdHostileReflex(lifetime, "enderman", shelteredAndTucked);

      const observeProgress: ObserveRequest = observe;
      observeProgress(() => ({
        baseline: { startPosition: positionOf(bot.entity.position), dimension: bot.game.dimension },
        checkpoint: {
          phase,
          pillar: plan ? positionOf(plan.pillar) : null,
          station: plan ? positionOf(plan.tucked) : null,
          structureComplete: plan !== null && structureComplete(bot, plan.cells),
          elapsedMs: Date.now() - startedAt,
          deadlineAt,
          attacks,
          killsObserved,
          nearbyEndermen: plan ? localEndermen(bot, plan.pillar, deadTargets).length : 0,
          absenceSince,
        },
        completion: {
          kind: "current",
          observed: phase === "leaving" && leftShelter && absenceSince !== null && Date.now() - absenceSince >= request.absenceWindowMs,
          owes: "A complete 3-block pillar and 5x1 canopy, the bot safely tucked beneath it, no loaded Endermen within the camp radius for the quiet window, and a verified move outside the canopy.",
        },
      }));

      const result = (
        status: "succeeded" | "partial" | "failed" | "cancelled",
        termination: HuntEndermenUnderUmbrellaResult["termination"],
        error?: string,
      ): HuntEndermenUnderUmbrellaResult => {
        const pillar = plan ? positionOf(plan.pillar) : null;
        const current = positionOf(bot.entity.position);
        const relative = plan
          ? { x: bot.entity.position.x - plan.pillar.x, z: bot.entity.position.z - plan.pillar.z }
          : { x: 0, z: 0 };
        const evidence = {
          structure: build?.structure ?? null,
          pillar,
          station: plan ? positionOf(plan.tucked) : null,
          finalPosition: current,
          relativePosition: {
            ...relative,
            withinPillarBounds: plan !== null && inTuckedPosition(bot.entity.position, plan),
          },
          leftShelter,
          combat: { engagements, killsObserved, attacks, styles: [...styles], weapons: [...weapons] },
          remaining: plan ? targetEvidence(bot, plan.pillar, deadTargets) : [],
          termination,
        };
        return status === "succeeded"
          ? { ...evidence, status }
          : { ...evidence, status, error: error ?? "[ENDERMAN_HUNT_" + termination.toUpperCase() + "] The Enderman shelter hunt stopped." };
      };

      const interruption = (signal: AbortSignal): HuntEndermenUnderUmbrellaResult => {
        const reason = signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? "The body was interrupted.");
        const cause = signal.reason instanceof BodyAbort ? signal.reason.detail : null;
        const cancelled = cause?.kind === "cancelled" || cause?.kind === "connection_lost" || cause?.kind === "death";
        const partial = structureIsComplete || attacks > 0 || killsObserved > 0;
        return result(cancelled ? "cancelled" : partial ? "partial" : "failed", "interrupted", reason);
      };

      const tuckIn = async (signal: AbortSignal): Promise<boolean> => {
        if (!plan) return false;
        const route = await navigation.navigate({
          movements: createMovements(bot, { allowDigging: false, scaffolding: false, allowSprinting: false }),
          goal: nearGoal(plan.stationCell, 0),
          signal,
        });
        if (route.status === "stopped") return false;
        if (!bot.entity.onGround) return false;
        const aligned = await navigation.steer({
          target: () => ({ x: plan!.tucked.x, y: bot.entity.position.y, z: plan!.tucked.z }),
          arrived: () => inIntendedTuck(bot.entity.position, plan!),
          maximumTicks: 20,
          signal,
        });
        return aligned.kind === "arrived" && inTuckedPosition(bot.entity.position, plan);
      };

      const leaveShelter = async (signal: AbortSignal): Promise<boolean> => {
        if (!plan) return false;
        for (const cell of safeExitCells(plan)) {
          const support = bot.blockAt(cell.offset(0, -1, 0));
          const feet = bot.blockAt(cell);
          const head = bot.blockAt(cell.offset(0, 1, 0));
          if (support?.boundingBox !== "block" || !feet || !head ||
            !isDryPlacementSite(feet) || !isDryPlacementSite(head)) continue;
          const route = await navigation.navigate({
            movements: createMovements(bot, { allowDigging: false, scaffolding: false, allowSprinting: false }),
            goal: nearGoal(cell, 0),
            signal,
          });
          if (route.status === "stopped") continue;
          if (bot.entity.onGround && outsideCanopy(bot.entity.position, plan)) return true;
        }
        return false;
      };

      return async (context: ActionContext): Promise<HuntEndermenUnderUmbrellaResult> => {
        const callerSignal = context.signal ?? lifetime;
        if (callerSignal.aborted) return interruption(callerSignal);
        try {
          phase = "validating";
          const block = bot.registry.blocksByName[request.blockName];
          if (!block || !isFullProtectionBlock(bot, request.blockName) || !bot.registry.itemsByName[request.blockName])
            return result("failed", "invalid_material", "[ENDERMAN_HUNT_INVALID_MATERIAL] " + request.blockName + " is not a placeable full-cube block.");
          if (!bot.entity.onGround)
            return result("failed", "unsafe_start", "[ENDERMAN_HUNT_UNSAFE_START] Start from supported ground in a loaded dimension.");

          plan ??= choosePlan(bot, request.blockName);
          if (!plan)
            return result("failed", "unsafe_start", "[ENDERMAN_HUNT_NO_BUILD_SPACE] No adjacent pillar direction has loaded ground support and a clear 5x1 canopy line with two open blocks below it.");
          if (localEndermen(bot, plan.pillar, deadTargets).length === 0)
            return result("failed", "unsafe_start", "[ENDERMAN_HUNT_NO_LOCAL_TARGET] No loaded Enderman is within the local hunting radius.");
          const needed = requiredBlocks(bot, plan, request.blockName);
          if (carried(bot, request.blockName) < needed)
            return result("failed", "materials_missing", "[ENDERMAN_HUNT_MATERIALS_MISSING] Need " + needed + " " + request.blockName +
              " block" + (needed === 1 ? "" : "s") + " to finish the pillar and canopy; carrying " + carried(bot, request.blockName) + ".");
          if (!combat.policy.combat.melee)
            return result("failed", "combat_blocked", "[ENDERMAN_HUNT_MELEE_PROHIBITED] Current combat policy does not permit melee attacks.");
          if (!readCombatItems(bot).some((item) => item.name.endsWith("_sword")))
            return result("failed", "combat_blocked", "[ENDERMAN_HUNT_SWORD_REQUIRED] Carry a sword; this action only attacks Endermen with melee.");

          phase = "tucking_in";
          if (!(await tuckIn(callerSignal)))
            return result("failed", "position_lost", "[ENDERMAN_HUNT_POSITION_LOST] The bot could not align beside the selected pillar before construction.");
          if (!structureComplete(bot, plan.cells)) {
            phase = "building";
            const requestForBuilder = { cells: plan.cells, removeWrongBlocks: false } as const;
            build = await buildStructure(
              bot,
              requestForBuilder,
              { signal: callerSignal },
              createBuildStructurePhysics(bot, navigation, requestForBuilder),
            );
            structureIsComplete = build.structure?.complete === true;
            if (!structureIsComplete) {
              const partial = (build.structure?.placed ?? 0) > 0;
              return result(
                partial ? "partial" : "failed",
                "structure_blocked",
                "[ENDERMAN_HUNT_STRUCTURE_INCOMPLETE] " + (build.structure?.correct ?? 0) + "/" +
                  (build.structure?.cells ?? 7) + " shelter cells are correct; " +
                  (("error" in build && build.error) || "the build process could not finish the canopy"),
              );
            }
          } else {
            structureIsComplete = true;
            build = {
              status: "succeeded",
              structure: {
                dimension: bot.game.dimension,
                cells: plan.cells.length,
                correct: plan.cells.length,
                placed: 0,
                dug: 0,
                wrong: 0,
                left: [],
                missing: [],
                passes: 0,
                complete: true,
              },
            };
          }

          phase = "tucking_in";
          if (!(await tuckIn(callerSignal)))
            return result("partial", "position_lost", "[ENDERMAN_HUNT_POSITION_LOST] The bot could not return to its flush position beside the pillar without digging or scaffolding.");
          fightStartedAt ??= Date.now();
          deadlineAt ||= fightStartedAt + request.timeLimitMs;

          for (;;) {
            if (callerSignal.aborted) return interruption(callerSignal);
            if (bot.health <= 0)
              return result("failed", "bot_died", "[ENDERMAN_HUNT_BOT_DIED] The bot died while fighting under the canopy.");
            if (bot.health < combat.policy.combat.critical_health)
              return result("partial", "combat_blocked", "[ENDERMAN_HUNT_LOW_HEALTH] The protected hunt stopped below the current critical-health threshold so ordinary recovery can take over.");
            if (!structureComplete(bot, plan.cells))
              return result("partial", "structure_blocked", "[ENDERMAN_HUNT_SHELTER_DAMAGED] The pillar or canopy is no longer complete; the action stopped fighting.");
            if (!inTuckedPosition(bot.entity.position, plan) && !(await tuckIn(callerSignal)))
              return result("partial", "position_lost", "[ENDERMAN_HUNT_POSITION_LOST] The bot was displaced from the protected pillar and could not return safely.");
            if (Date.now() >= deadlineAt)
              return result("partial", "time_limit", "[ENDERMAN_HUNT_TIME_LIMIT] The fighting and observation time limit elapsed.");

            const allNearby = localEndermen(bot, plan.pillar, deadTargets);
            if (allNearby.length === 0) {
              phase = "waiting";
              absenceSince ??= Date.now();
              const quietRemaining = request.absenceWindowMs - (Date.now() - absenceSince);
              if (quietRemaining <= 0) {
                phase = "leaving";
                if (!(await leaveShelter(callerSignal)))
                  return result("partial", "safe_exit_blocked", "[ENDERMAN_HUNT_SAFE_EXIT_BLOCKED] Endermen stayed clear, but no supported route outside the canopy was available.");
                if (localEndermen(bot, plan.pillar, deadTargets).length > 0) {
                  if (!(await tuckIn(callerSignal)))
                    return result("partial", "position_lost", "[ENDERMAN_HUNT_POSITION_LOST] A new Enderman appeared as the bot left; it could not return beneath the canopy.");
                  absenceSince = null;
                  phase = "waiting";
                  continue;
                }
                leftShelter = true;
                if (killsObserved === 0)
                  return result("partial", "target_not_killed", "[ENDERMAN_HUNT_NO_KILL_OBSERVED] The area is clear and the bot left the canopy, but no Enderman death was observed.");
                return result("succeeded", "threats_gone");
              }
              const waitMs = Math.min(quietRemaining, deadlineAt - Date.now());
              await waitForSignal(
                () => localEndermen(bot, plan!.pillar, deadTargets).length > 0 ? true : null,
                bot,
                ["entitySpawn", "entityUpdate", "entityMoved", "entityGone", "entityDead"],
                { context: { signal: callerSignal }, timeoutMs: waitMs },
              );
              continue;
            }
            absenceSince = null;
            const now = Date.now();
            const target = allNearby.find((entity) => {
              const retry = retryAt.get(entity.id);
                if (!retry) return true;
              if (retry.position.distanceTo(entity.position) >= 1 || now >= retry.at) return true;
              return false;
            });
            if (!target) {
              phase = "waiting";
              await waitForSignal(
                () => allNearby.some((entity) => {
                  const retry = retryAt.get(entity.id);
                  return !retry || retry.position.distanceTo(entity.position) >= 1 || Date.now() >= retry.at;
                }) ? true : null,
                bot,
                ["entitySpawn", "entityUpdate", "entityMoved", "entityGone", "entityDead"],
                { context: { signal: callerSignal }, timeoutMs: Math.min(1_000, deadlineAt - Date.now()) },
              );
              continue;
            }

            phase = "fighting";
            const refusal = combat.resourceRefusal(target, combat.policy.combat);
            if (refusal)
              return result("partial", "combat_blocked", "[ENDERMAN_HUNT_COMBAT_BLOCKED] " + refusal);
            engagements++;
            const combatDeadline = new AbortController();
            const healthLimit = new AbortController();
            const stopAtCriticalHealth = () => {
              if (bot.health < combat.policy.combat.critical_health)
                healthLimit.abort(new Error("Enderman hunt reached the critical-health threshold."));
            };
            bot.on("physicsTick", stopAtCriticalHealth);
            const timeout = setTimeout(
              () => combatDeadline.abort(new Error("Enderman hunt time limit elapsed.")),
              Math.max(1, deadlineAt - Date.now()),
            );
            let outcome;
            try {
              outcome = await combat.engage(
                target.id,
                AbortSignal.any([callerSignal, combatDeadline.signal, healthLimit.signal]),
                "hold",
              );
            } finally {
              bot.off("physicsTick", stopAtCriticalHealth);
              clearTimeout(timeout);
            }
            attacks += outcome.attacks;
            for (const style of outcome.stylesUsed) styles.add(style);
            for (const weapon of outcome.weaponsUsed) weapons.add(weapon);
            if (callerSignal.aborted) return interruption(callerSignal);
            if (Date.now() >= deadlineAt)
              return result("partial", "time_limit", "[ENDERMAN_HUNT_TIME_LIMIT] The fighting and observation time limit elapsed.");
            if (outcome.kind === "bot_died")
              return result("failed", "bot_died", "[ENDERMAN_HUNT_BOT_DIED] The bot died during the Enderman fight.");
            if (outcome.kind === "died") {
              killsObserved++;
              deadTargets.add(target.id);
              retryAt.delete(target.id);
            } else if (outcome.kind === "target_lost") {
              retryAt.set(target.id, { position: target.position.clone(), at: Date.now() + 3_000 });
            } else if (outcome.kind === "cancelled" && combatDeadline.signal.aborted) {
              return result("partial", "time_limit", "[ENDERMAN_HUNT_TIME_LIMIT] The active fight reached the time limit.");
            } else if (outcome.kind === "cancelled" && healthLimit.signal.aborted) {
              return result("partial", "combat_blocked", "[ENDERMAN_HUNT_LOW_HEALTH] The protected hunt stopped below the current critical-health threshold so ordinary recovery can take over.");
            } else if (outcome.kind === "cancelled") {
              return result("partial", "combat_blocked", "[ENDERMAN_HUNT_COMBAT_CANCELLED] The shared combat controller cancelled without a reflex takeover.");
            } else if (outcome.kind === "capability_blocked" || outcome.kind === "defence_required" || outcome.kind === "unreachable" || outcome.kind === "failed") {
              if (outcome.kind === "capability_blocked" || outcome.kind === "defence_required")
                return result("partial", "combat_blocked", "[ENDERMAN_HUNT_COMBAT_BLOCKED] " + outcome.observation);
              retryAt.set(target.id, { position: target.position.clone(), at: Date.now() + 3_000 });
            }
            if (!inIntendedTuck(bot.entity.position, plan)) {
              phase = "tucking_in";
              if (!(await tuckIn(callerSignal)))
                return result("partial", "position_lost", "[ENDERMAN_HUNT_POSITION_LOST] The bot could not regain its flush position after the fight.");
            }
          }
        } catch (cause) {
          if (callerSignal.aborted) return interruption(callerSignal);
          const reason = cause instanceof Error ? cause.message : String(cause);
          return result(structureIsComplete || attacks > 0 ? "partial" : "failed", "execution_failed", "[ENDERMAN_HUNT_EXECUTION_FAILED] " + reason);
        }
      };
    },
  });
}
