# Acacia execution plan

A delegated job starts with a verifiable objective and ends with a receipt. Acacia picks the objective and any consequential constraints. Mine AI owns the actions needed to meet it. Pi follows the job by action ID and returns control when Acacia can make a useful decision.

## 1. Carry one job across tool waits

Replace the collection-only polling branch in `src/pi.mjs` and its inventory-gain predicate in `src/game-tools.mjs` with a shared waiter for navigation and collection. Start with those two existing actions. Their typed checkpoints already carry the quantities and navigation distance we need to test. Record a poll as telemetry and show the job's progress in the dashboard's existing activity area.

1. Pi submits the action with a stable submission ID and uses the returned action ID on every later wait. Reconcile that ID with the runtime after reconnect. If the submission response was lost, reuse the same submission ID and identical arguments.
2. Inspect typed progress on a short internal polling interval. Proposed fixture values are five-second polls and a 15-second period without forward progress before reporting a stall. Tune them from measured travel and work phases. Measure elapsed time with a monotonic clock. Pause the stall timer during declared recovery or bounded observations, and keep the overall job deadline running. A wait timeout is the time spent observing. Mine AI enforces the job deadline and settles the action. Pi retrieves the final result.
3. For travel, progress means getting closer to an acceptable landing or making a verified change that opens the route. A side-step can be useful and momentary regressions are expected. Plan revisions and repeated visits to the same positions alone do not renew progress. For gathering, track blocks broken, pickups, or an approach to a currently reachable target. Use the hunt's existing finite observation window for spawn waits. The controller owns short combat cooldowns.
4. Hand control back on verified completion, a terminal error, newly unsafe conditions, or an exhausted progress or resource budget. A report on an active job includes its action ID and choices to continue waiting or cancel. A settled partial result includes what it accomplished and what blocked it. To terminate a job, request cancellation and retrieve the settled result before another foreground action starts.

The first tests use the existing Unix-socket fixture in `test/pi-context.test.mjs`. A route makes progress over several waits and finishes with one model tool call. A route going in circles yields a stall. Tests also cover a reported safety interruption and a disconnect after admission. In the live-game fixture, observe one navigation request, its final position, and the next action starting after the result gate clears. [Mine AI's action lifecycle](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docs/mcp/async-actions.md)

## 2. Give gathering and routing a useful scope

Make physical changes in the pinned Mine AI source and package them through `deploy/Dockerfile`. Reuse its target selection, movement policy and action runner.

| Existing tool | Interface to add | Implementation and required test |
| --- | --- | --- |
| `collect_block` | Optional work area, target drop and maximum blocks to break. A work area can be a center and radius in the current dimension. | Filter candidates before handing them to the miner. Count the desired item in inventory. Ore outside the area stays untouched. A gravel fixture stops at the quota, the dig limit, or an exhausted patch, whichever comes first. Save the remaining deficit and avoid digging again after a pickup interrupted the action. |
| `navigate` | Use the existing coordinate and range for an ordinary arrival. Add a scaffold allowance and allow any suitable standable landing within range. | Select reachable landings through existing goal combinators. Apply the same placement budget to planning and to live placement across replans. Reuse safe digging and scaffolding. In a forked route fixture, reach one of two landings despite the blocked shorter path. In a gap fixture, cross within the allowance or stop with the farthest verified position and the limiting reason. |
| `collect_mob_drop` | Optional work area and local fallback position, with the existing count and observation window. | Restrict target selection to the area. Score candidates by reachable fighting positions and recoverable drops. Reuse an effective position. In a mixed-terrain fixture, abandon an unreachable quarry, choose a reachable one, and verify the inventory gain. |

Use the same receipt fields everywhere, such as `goal`, `status`, `achieved`, `remaining`, `blocker`, and the current dimension and position. Keep the action ID and full evidence available. A receipt could say “14 of 24 raw iron collected. Reachable ore in the selected area exhausted.” Acacia can choose a new area from that information.

## 3. Make local recovery part of finishing the job

Use Mine AI's existing resumable action execution in `src/session/action-runner.ts`. The survival controller takes physical control when required. It first considers a reachable position that breaks dangerous line of sight and has safe footing. When that fails, fall back to the broader escape. Before returning control to the action, validate that the hazard has cleared or the bot has recovered enough to continue. Recompute targets, inventory, and the remaining allowance from current observations. The same job keeps its identity and budget.

Test a recovery fixture with nearby verified cover and a farther escape route. Verify the short recovery and continued progress under the original action ID. Then block the local escape and verify a broader retreat or explicit stop as appropriate. Run these checks against multiple threat and terrain layouts. Measure time to loot and safe exit together in expedition tests.

## 4. Compose existing work using an Alto Clef pattern

Add a small inventory planner to the existing action runner once scoped jobs work. Accept desired inventory or equipment as data. Recipes and current inventory compute the first missing prerequisite. Existing collect, smelt, craft and equip implementations do the work under the same foreground owner. Compose internally so child steps share the interrupt, cancellation and progress rules. The planner rechecks actual state after each child finishes and advances only when the required change is observed.

Use two different fixtures to show reuse. An equipment fixture starts with a partial set and verifies the exact deficit and final slots. A food fixture chains acquisition and cooking to an inventory target. The same acquisition and job lifecycle should serve both. [Alto Clef task runner](https://github.com/gaucho-matrero/altoclef/blob/af22e3bc2f03dde45da703f5f7535baae18ea486/src/main/java/adris/altoclef/tasksystem/TaskRunner.java#L21-L40)

## Comparison and rollout

Use deterministic real-server setups for the focused checks. Compare the deployed and candidate harness from identical starting states and keep model, effort, and game difficulty fixed. The first success criterion is one model request through a healthy long-route fixture, with the usual handoff when the fixture is blocked. Record model turns per job, foreground idle time, wall time to verified completion, damage, blocks spent, and the distance of any retreat. When an improvement holds across the ore, route and combat fixtures, run full Hardcore attempts on the original seed and additional seeds. Observe milestone times and safe extraction. Compare reasoning levels separately after those checks.

The first deployable slice is the shared waiter with existing `navigate`. It can be tested separately from new targeting and combat policy. The wider plan includes work in both the local harness and the pinned Mine AI image.
