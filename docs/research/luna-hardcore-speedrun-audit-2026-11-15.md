# GPT-6 Luna Hardcore run audit

Audit snapshot: **2026-11-15 20:22 UTC**. This is a read-only review of the ten local GPT-6 Luna attempts and the published Mine AI MCP and Lumi references. No live-run controls were used.

## Audit criteria

1. **Progress and outcome:** elapsed wall time to useful milestones (Nether, blaze rods and pearls, stronghold, End, dragon), furthest confirmed state, death or disconnect.
2. **Speed and trial throughput:** total elapsed time per attempt, restart gaps, attempts per hour, and time spent stalled in one phase. Treat the Lumi VOD timestamps as a reference, not an exact in-game timer.
3. **Tool use:** calls per minute, useful multi-item batching, status/inspection frequency, decision text length, repeated calls, and recovery after tool errors.
4. **Failure causes:** separate model choices from tool-contract, navigation, combat, portal, and server/runtime failures.

## Dataset and outcome

There are **10** runs with `model: gpt-6-luna`; all use seed `97996358`, Minecraft 1.21.4, Hardcore, the same code revision, and the same prompt hash. The first nine use one container image; the latest run, `4055b78f8d9e`, uses a different image digest. Thus the prompt and model stayed fixed, while the latest run may have different tool/runtime implementation.

Across the snapshot, the attempts span **22h 52m**. Eight ended in death, one stopped with a Minecraft connection loss, and one is still active. That is about **0.44 starts/hour** (one new attempt every 2h 17m), or roughly 10.5 starts per day at this rate. The loop is restarting worlds regularly; its central problem is how little game progress it gets from that time.

| Run | Elapsed | Tool calls / errors | Furthest confirmed progress or outcome |
|---|---:|---:|---|
| `2c4fadca9fc7` | 9.7 min | 41 / 8 | Died to an Enderman underground at Y−11. |
| `59e79394428d` | 8h 7m | 1,186 / 273 | First Nether position at +5h 27m; later suffocated in a wall in the Overworld. |
| `47f1db5dc999` | 1h 10m | 195 / 57 | Creeper death at Y−50 during an obsidian trip. |
| `9293f508c133` | 2h | 337 / 81 | Died in lava at Y−57 while mining obsidian. |
| `3d8dd5bea237` | 1h 39m | 333 / 84 | Burned to death during portal lava work. |
| `a5209f405af4` | 12.6 min | 42 / 10 | Zombie death while poorly equipped. |
| `2327ec148e9c` | 1h 53m | 373 / 91 | Portal-entry attempts did not reach the Nether; skeleton death after a nighttime chicken hunt. |
| `f3877966dfcc` | 20.2 min | 84 / 26 | Skeleton death after pursuing food at about 8 health. |
| `96943d307bab` | 5h 47m | 749 / 183 | Reached the Nether at +3h 40m; gathered 10 blaze rods and 5 ender pearls, then the Minecraft connection was lost. This is the closest attempt to completion. |
| `4055b78f8d9e` | 1h 23m and active | 212 / 54 | Still in the Overworld. Latest action is collecting 16 mob drops, with 1 gained so far; health is 20. No Nether position. |

Only **2 of 10** runs show actual Nether positions. Neither shows an End entry or dragon fight. The nearest run had full diamond armor and useful Nether supplies, but its trace ends before stronghold/End progress. Another run spent over eight hours and reached the Nether only after more than five hours.

## Speed benchmark

The two Lumi recordings show the dragon death at **1:45:40** and **2:26:20** into their respective videos. The first VOD is 1:46:14 long; the second is 2:28:16. These are video timestamps, not independent in-game clocks or tool traces; both recordings include opening/reset footage. They support using **under three hours per successful attempt** as an aspirational wall-clock benchmark, not as a claim that every world should take exactly that long. [First VOD, dragon death at 1:45:40](https://www.youtube.com/watch?v=Xp9Yzxl0ZqU&t=6340s) · [Second VOD, dragon death at 2:26:20](https://www.youtube.com/watch?v=cDX6a6VaAKE&t=8780s)

The Mine AI MCP run on the same seed and Minecraft version defeated the dragon in **3h 56m 55s**, with the server recording `Free the End` at 04:39:50 UTC. It reached full diamond gear around +35m, lit/entered the Nether around +55m, found the stronghold at +3h 19m, entered the End at +3h 32m, and killed the dragon at +3h 56m. This is an important mechanics and pacing reference, but not a controlled comparison: Mine AI used Claude Opus 5 at high effort in Normal Survival; Luna used GPT-6 Luna at medium effort in Hardcore. [Published Mine AI MCP run and artifacts](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)

Against those references, the two Luna Nether arrivals at +3h 40m and +5h 27m are already late, and the closer run lost connection at +5h 47m without End progress. **Raw attempt count is not the main pacing failure:** the harness started about ten worlds in 22h 47m. It needs more useful progression per attempt and fewer long runs that stop before the End.

## Tool-call efficiency and autonomy

The Luna logs contain **3,552 calls and 867 error-marked results (24.4%)**, or about **155 calls/hour**. Mine AI recorded 388 transcript calls (387 persisted MCP requests) in 3h 57m, about **98 calls/hour**. Luna is making more calls per hour, not fewer. Mine AI's 59 `wait_for_action` requests are largely asynchronous polls; its database records 239 foreground executions, so raw call counts are not equivalent to gameplay tasks. [Dataset trace and schema](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)

Information gathering is a substantial share: Luna made 803 `view_status` and 343 `view_blocks` calls (1,146 combined, 32% of all calls). Mine AI used `view_status` 24 times and `view_blocks` 15 times in its complete run. Some checks are useful, but Luna's inspection rate is much higher.

Where structured decision metadata is present (460 calls), its objective/observation/course-change text averages about **24 words** excluding field labels, versus Mine AI's single `rationale` averaging 13.8 words. The fields differ, so this is directional; actual tool arguments are usually compact. The logs do not show the agent spending most of its time writing long prose. They do show one tool call per assistant turn, with no multi-tool call batches in a turn.

There is useful primitive-level batching already: most `collect_block`, `collect_mob_drop`, and `smelt_item` calls request multiple items. The Mine AI trace also shows outcome-sized requests, including collecting 16 logs at once and crafting a table, pickaxe, axe, and sticks in one call. Mine AI further used tools such as `prepare_dragon_perch` and `attack_dragon_perch`; these delegate a whole subtask instead of requiring the model to choose every small action.

## Failure patterns

- **Invalid high-level preparation:** `ensure_items` returned errors on all **148** calls. In 74 requests it combined `loadout` and `items`; in 68 it paired an equipment destination with a stack quantity. The model often repeated the same rejected shape: one Nether loadout request was retried 12 times in about 71 seconds. This is both a brittle tool contract and poor recovery after explicit validation feedback.
- **Broken or misused action contracts:** all 33 `raw_action` calls failed validation; 31 `use_container` calls failed validation (often an `inspect` request included item quantities). `enter_nether_portal` failed 25 of 31 times, including range/loadout failures. These errors consume time and block the exact progression steps the run needs.
- **Navigation and route stalls:** `navigate` failed 76 times out of 363; 51 were pathfinder stops. One failed route in `96943d307bab` ended 77.8 blocks short after a path search timeout. There are repeated risky expeditions deep underground for obsidian, followed by deaths from creepers, lava, or suffocation.
- **Decision/recovery failures:** reflections repeatedly identify exposed food hunts at night or low health, continuing underground with inadequate gear, and staying in unresolved fire/lava danger. These are not all tool bugs. In several cases the runtime surfaced a clear hazard or validator error, but the next model action did not safely recover or correct the request.

The comparison does **not** support the simple diagnosis “Luna never batches” or “Luna thinks too long.” It batches item counts in existing primitives. The bigger seam is that useful high-level calls fail, and the agent spends many later turns inspecting, retrying, or improvising around them. The best near-win also stopped on a connection failure, so server/runtime reliability belongs in the audit alongside model behavior.

## Speedrun-oriented scorecard for future audits

Track, per attempt: wall time to first portal/Nether, required Nether/pearl supplies, stronghold, End, and dragon kill; time spent without a milestone; tool calls and validation failures per milestone; and starts/completions per 24 hours. Use **<3h to a completed Hardcore run** as an aspiration informed by the Lumi footage, with the Mine AI trace as a slower but more measurable same-seed baseline. Treat milestones as measurements, not mandatory item-count gates; avoid calling repeated tool failures “model deliberation.”

## Sources and limitations

Local evidence is under `/home/jake/.local/share/mine-ai/<run-id>/` (`run.json`, `activity.jsonl`, `result.json`, and `reflection.json`). Wall-clock durations are from first to last activity records; the active run's totals continue changing. `isError` marks tool failures but does not always expose the underlying validation message in `activity.jsonl`, so some failure causes were checked against the detailed run transcript. The public Mine AI dataset provides a transcript, runtime SQLite database, prompt, and server log. The Lumi video pages provide video and creator descriptions, but no comparable action trace or telemetry.
