# Why the Mine AI MCP run stayed on task

## Evidence scope

This section is based on the published Mine AI MCP run record and its pinned source, rather than a third-party summary. The dataset includes the model transcript, seed prompt, run metadata, SQLite action ledger, and server log. The public artifact preserves the task prompt, but not Claude Code's entire native system/developer prompt; therefore “the exact prompt” below means the published task prompt and exposed MCP tool catalog, not every hidden instruction in the host client. [Dataset and artifact inventory](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)

## Goal framing

The task prompt has one overriding objective: defeat the Ender Dragon and continue until the kill is observed. It then offers a recommended progression, but explicitly says to **“Treat them as suggestions, not a checklist or a fixed order”** and adapt to observed resources, opportunities, threats, and supplies. It recommends tools, gear, food, beds, pearls, blaze rods, and End preparation, but does not tell the model to stop at exact item counts before advancing. [Published `prompt.txt`](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/prompt.txt)

This is a consequential distinction in the prompt's shape: the dragon remains the acceptance condition while route details remain choices. A pile of sensible suggestions can still become a checklist in practice, but here the instruction explicitly pushes against that interpretation. The run's notes also record a concrete `Next:` step at each milestone, while preserving the top-level goal.

## Run configuration and confounds

The published run used `claude-opus-5[1m]` at high effort on seed `97996358`, Minecraft 1.21.4, and the server JAR whose SHA-1 is `4707d00eb834b446575d89a61a11b5d548d8c001`. The winning setup starts a fresh Normal Survival world. The source setup writes `gamemode=survival` and `difficulty=normal`; it is not Hardcore. It recovered after one creeper death, so its objective could continue in the same world. [Run metadata](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/run.json) · [Pinned server setup](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docker/prepare.mjs)

The same seed, version, and server JAR make the world configuration comparable, but the model, effort, and death rules differ from GPT-6 Luna Hardcore. Seed equality does not imply the same trajectory: the dataset explicitly cautions that the run is not deterministic and a rerun will not replay it. These differences prevent attributing the result to prompt wording or tooling alone.

## What the agent actually did

The trace shows a coherent sequence without a hard, item-count gate at every stage:

| Elapsed from world start | Observed milestone |
|---:|---|
| ~35 min | Full diamond armor, diamond sword and pickaxe, shield, portal materials, and food. |
| ~55 min | Portal lit and Nether entry. |
| ~1h 17m | Returned to the Overworld deliberately to hunt Endermen after the Nether did not provide pearls. |
| ~2h 56m | Twelve Eyes of Ender and four spare rods; the record notes one creeper death and recovery of all gear. |
| ~3h 19m | Stronghold found by eye triangulation after a roughly 1,700-block journey. |
| ~3h 31m | End entry. |
| ~3h 56m | `Free the End`; server log confirms the dragon kill. |

The decision trace makes the route choice visible. The Nether return was explicitly to gather the missing pearls; later the agent traveled to the triangulated stronghold. It did not repeatedly return to safety with no stated missing resource. It also recovered from a real death and continued. The database notes capture these state transitions and next goals, while the server log independently verifies completion. [SQLite, transcript, and server log](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)

## Tool surface and task ownership

The winning transcript contains 388 calls across 37 MCP tools; the action database records 387 requests and 239 foreground executions. `wait_for_action` accounts for 59 calls, so raw request count includes polls and observations, not just new gameplay objectives. The database records 217 succeeded, 25 partial, 49 failed, 19 refused, 13 cancelled, and 59 pending responses. Pending entries are not automatically stuck actions; the async contract returns live progress while the same foreground objective continues. [Dataset trace and schema](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft) · [Async action contract at the winning commit](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docs/mcp/async-actions.md)

The tool calls were outcome-sized and used primitive batching:

- `collect_block` accepted a quantity, searched loaded columns, approached and mined targets, selected the best carried tool, used carried scaffolding where allowed, and reported the inventory gain. The opening call asked for 16 logs; another requested 32 stone.
- `craft_item` recursively planned multiple recipes against one inventory and executed a single item list. Early batches made the table, wooden tools, and sticks together; later batches made several stone tools and a furnace, then an iron pickaxe, shield, bucket, and armor together.
- `navigate` owned a route to an absolute target and could dig obstructions or scaffold when enabled. The model chose the destination; the pathfinder handled the route.
- `wait_for_action` returned progress and the settled result for an admitted foreground objective. A timeout did not silently mean completion or cancel the action.

These tools did not beat the game without planning by the model: the model still selected goals, targets, quantities, and when to change phases. They removed many repetitive sub-decisions from individual tasks. The published tool list has 37 entries and includes no `ensure_items`; the winning agent prepared gear through the ordinary `collect_block`, `craft_item`, `smelt_item`, `equip`, and `navigate` calls rather than depending on that additional macro. [Published tool list in the transcript](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/transcript.jsonl) · [Tool contracts at the winning commit](https://github.com/aibengineering/mine-ai-mcp/tree/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/src/actions)

There are also phase-specific End tools, including `prepare_dragon_perch`, `attack_dragon_perch`, `shoot_dragon`, and `destroy_end_crystal`. These abstract real execution in the End, but they do not explain the earlier Overworld or Nether progress; that progression is visible in the ordinary tools and the model's plan.

## Strongest explanation supported by the reference

The successful run does not establish a single cause, but it gives a concrete model for the split:

1. Keep one persistent, observable acceptance goal: defeat the dragon. State route guidance as adaptable advice, and let the agent choose phase order from the actual world.
2. Make common objectives executable in batches, with tools returning progress, inventory changes, and explicit failure reasons. The prompt can stay focused on outcomes because recipes, collection, movement, and waiting belong to the tool layer.
3. Preserve the distinction between progress and safety interruption. The successful agent did retreat once for a specific missing resource, recovered from a death, and resumed its route; those transitions were logged as goal-directed decisions.

This is a well-supported design contrast, not proof that prompt structure caused the win. The Hardcore difficulty, different model and effort, and different live-run choices are major confounds. The next section should compare the local Luna prompt and exact divergence traces before naming a root cause.

## Local Acacia trace comparison

### The prompt actually running is not the prompt in the newer worktree

The active service runs from `/home/jake/.local/opt/minecraft-mine-ai`. Its `deploy/hardcore.txt` and `deploy/decision.txt`, concatenated exactly as `run.mjs` does, hash to `2ff75dda886555f14868671a69b2d5e4f6fdb89637b480a7dc1b649a08a73b66`. That same prompt hash is recorded in the [`4055` run manifest](/home/jake/.local/share/mine-ai/4055b78f8d9e/run.json) and its child [`6a114c92c95d` run manifest](/home/jake/.local/share/mine-ai/6a114c92c95d/run.json), as well as the ten earlier attempts in the previous audit. The newer short prompt in the `d6dc` development worktree is not the one those runs used: it has a different hash, and the service process is running from the installed path. The old prompt files are [the deployed Hardcore prompt](/home/jake/.local/opt/minecraft-mine-ai/deploy/hardcore.txt), [the deployed decision instructions](/home/jake/.local/opt/minecraft-mine-ai/deploy/decision.txt), and the loader is [run.mjs](/home/jake/.local/opt/minecraft-mine-ai/src/run.mjs). The newer draft is [in the d6dc worktree](/home/jake/.codex/worktrees/d6dc/minecraft/deploy/hardcore.txt).

That is the clearest concrete source of goal drift. The deployed prompt says “defeat the Ender Dragon,” but immediately adds a long expedition checklist: get full diamond armor and tools before the Nether; carry cooked food, bow, arrows, two shields, blocks, and gold; aim for 12 blaze rods, with 20 preferred when safe; get surplus Eyes; check a full End loadout; and end an expedition early when continued progress does not feel safe. It also asks the model to check equipment, durability, food, ammunition, building blocks, and inventory space before leaving, and to resume from a protected position. These are not neutral examples. They introduce explicit prerequisites and competing local objectives that can keep the model preparing, inspecting, retreating, or revisiting an area after the dragon goal has become secondary.

Compare that with the [published Mine AI task prompt](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/prompt.txt): one completion condition (verified dragon kill), route suggestions explicitly labeled suggestions rather than a checklist or fixed order, and adaptation to actual resources and circumstances. Mine AI does give concrete route advice, but its prompt preserves the hierarchy: finish the game first; choose a route from the world state. Acacia's deployed prompt has a nominal top-level goal but then makes preparation targets, specific quantities, one-trip expectations, and safety behaviors prominent enough to act like gates.

There is also a per-call narration requirement in the deployed [decision prompt](/home/jake/.local/opt/minecraft-mine-ai/deploy/decision.txt): on the first call and whenever the approach changes, supply `Objective`, `Observation`, and `Change course if` within a 200-character combined limit. Mine AI's published prompt does not impose that structured rationale on every decision. The short format is not by itself a major token sink, but requiring the agent to restate a local objective and contingency as plans shift can reinforce local plan management. In the trace, each assistant turn emits one tool call; neither setup is doing a hidden multi-tool batch at the model-turn level.

### Trace evidence: a specific local plan became self-defeating

The newest completed run, [`4055b78f8d9e` activity log](/home/jake/.local/share/mine-ai/4055b78f8d9e/activity.jsonl), [`death reflection`](/home/jake/.local/share/mine-ai/4055b78f8d9e/reflection.json), and [SQLite action ledger](/home/jake/.local/share/mine-ai/4055b78f8d9e/bot/server-host-minecraft-port-25565-seedHash-911415-023d60f72388/bots/9dcafea4-0481-3971-aa9c-3719fb534ea6-971f416df6ea/bot-data.sqlite), ended to a Blaze in the Nether at `(-73.567, 67, 80.562)` after about 1h23. The action ledger makes the failure more specific than “it got scared” or “forgot the goal”:

1. A blaze interrupted a seven-rod collection attempt about 7.9 blocks away. The agent had five rods and gained none from that action.
2. It set a survival policy to `defend_only`, with retreat/recovery enabled but melee and bow disabled, then inspected the shelter area.
3. It navigated back toward the spawner to resume rod collection. The destination was reached, but it was still the active threat area.
4. It started smelting two mutton there. A blaze interrupted the action at about 4.9 blocks, and health fell to about 14.8.
5. It again set defend-only with melee and bow disabled, and died shortly afterward.

The evidence supports a combined failure: the model chose to return to an active spawner and perform a non-urgent cooking task there; the deployed prompt's “resume the same objective from cover” and rod target supported returning to that task; and the chosen defensive policy prohibited the attacks that could have cleared a nearby mob. The reflection is useful as a human review, but its summary should not be treated as ground truth—the request sequence is the stronger evidence. This is a decision-policy/tool interaction, not simply a bad pathfinder or an instruction to build a Blaze-specific script.

### Pacing and tool reliability

In `4055`, the trace shows 270 tool executions in 83 minutes (about 195 per hour), including 54 `view_status` calls, 27 `view_blocks`, 26 `craft_item`, 25 `collect_mob_drop`, 23 `navigate`, and 17 `ensure_items`. All 17 `ensure_items` executions are marked as errors in the activity trace. This was a 38-tool catalog; the published Mine AI catalog has 37 tools and no `ensure_items`. Across the ten earlier Luna attempts, `ensure_items` failed all 148 calls, while the audit also found repeated validation failures in container, portal, raw-action, and navigation usage. See the [contemporaneous local audit](luna-hardcore-speedrun-audit-2026-11-15.md) for counts and limits.

Mine AI's winning transcript has 388 calls in 3h57m (about 98 per hour), of which 59 are `wait_for_action` polls; its database records 239 foreground executions. The rough calls-per-hour comparison is descriptive, not apples-to-apples. Still, the local agent is making roughly twice as many tool requests per hour and checking status more often, while its unsupported/brittle calls fail repeatedly. The pattern is not “Luna never batches”: Acacia does request multiple blocks, items, and mob drops in single calls. The more concrete gap is that Mine AI's ordinary tool calls own useful stretches of work, while Acacia's expensive wrapper calls can fail and then leave the model to inspect, retry, and recover one turn at a time. Mine AI's published `collect_block` and `craft_item` contracts support quantities and multi-recipe crafting; its async action contract provides progress and a settled result. [Published action contracts](https://github.com/aibengineering/mine-ai-mcp/tree/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/src/actions) · [Async actions](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docs/mcp/async-actions.md)

### There is no automatic learning across deaths

The local service runs a death reflection, saves it to `reflection.json`, and immediately starts a child run with the old run ID as `parent`. In [server.mjs](/home/jake/.local/opt/minecraft-mine-ai/src/server.mjs), the new run is created from the same static prompt files; the reflection is not supplied to the next run. Run `6a114c92c95d` has the same prompt hash as `4055b78f8d9e` and the earlier attempts. Its early trace also spends many calls on status and inventory inspection and starts another `ensure_items` attempt. Therefore the current automation is restart-after-reflection, not cross-run adaptation. The reflection is a human-visible diagnosis mechanism, consistent with the chosen non-self-modifying design, but it cannot be credited with improving the next run.

### Why Mine AI could finish and Acacia has not

The evidence points to several interacting causes rather than one vague “focus” problem:

| Seam | Mine AI winning run | Luna Hardcore runs | What the evidence supports |
|---|---|---|---|
| Goal hierarchy | One verified finish condition; route guidance explicitly flexible | Same nominal goal, then many prominent preparation, quantity, gear, and safety directives | Strongest prompt-level explanation for local drift and repeated preparation |
| Difficulty and model | Claude Opus 5, high effort, Normal Survival; one recoverable death | GPT-6 Luna, medium effort, Hardcore; death ends the world | Major confound; survival incentives and model differences cannot be removed from this comparison |
| Tool execution | Quantity-based collection, multi-recipe crafting, destination-based navigation, async progress/results | Some batching exists, but error-prone high-level calls and repeated inspection/retries | Reliability and task ownership plausibly consume time and increase local planning load |
| Continuity | Notes recorded next steps within the successful run | Death reflection is saved for humans; next run gets the same prompt | Current system has no cross-run behavioral update |
| Outcome | Dragon kill in about 3h57m | In the first ten attempts, none reached the End; the closest reached Nether supplies before disconnect | Demonstrates the gap, but not which single seam caused it |

The broad hypothesis that Acacia is insufficiently focused is directionally right, but the more precise diagnosis is: **the deployed prompt overloads the goal with prerequisite-like subgoals and safety checks; broken tool contracts make those subgoals expensive to execute; and the run loop resets without carrying forward a behavioral change.** That predicts observable symptoms—excess status checks, preparation loops, repeated failed calls, return trips, and restarting with an identical plan—and those symptoms are present. The Blaze death is a concrete example of the model trying to resume an intermediate objective while its combat policy made the immediate situation harder to resolve.

This remains an evidence-backed explanation, not a controlled causal finding. Mine AI used a different model and effort, Normal rather than Hardcore, and a different tool implementation. Seed, game version, and server JAR are aligned, which helps compare the opportunity, but does not make the trajectories deterministic or isolate the prompt effect. The published record exposes the Mine AI task prompt and tool contracts, not the host's entire hidden Claude Code system prompt. [Dataset and artifact inventory](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)

### Concrete conclusion for the next engineering pass

1. First ensure the intended short, goal-first prompt is actually loaded by the running service; the latest Luna runs used the old deployed checklist prompt, not the newer worktree draft.
2. Fix tool contracts based on observed failures, beginning with the repeatedly failing `ensure_items`, container operations, and portal entry. A tool that fails on the common path is a pacing defect, not a prompt wording problem.
3. Keep the game objective singular and let the model choose a route from current state; retain useful advice as flexible options rather than mandatory inventory gates. Keep a safety retreat local to the hazard and make recovery policy compatible with fighting when needed.
4. Measure each run by time-to-milestone, failed calls per milestone, status/inspection calls, and time without verified progress. Do not infer “thinking too much” from raw tool count alone.
5. Keep death reflections as human-review artifacts unless deliberately changing that product decision; do not claim the next run learned from them unless the runtime actually consumes an approved update.

No gameplay code or live run was changed as part of this research pass.
