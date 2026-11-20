# Mine AI winning-run prompt and settings

Research note based on the published run artifacts and the source pinned by that run. The dataset is released under CC BY 4.0.

## What can be copied verbatim

The exact published task prompt is [`prompt.txt`](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/prompt.txt), SHA-256 `cfa70c72f6c392d5dd063be488ce50322a03372fa37abb9fa61e1f84cd4e1949`. The full text is also embedded in [`run.json`](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/run.json). The pinned entrypoint passes it to Claude Code as `claude --print "$PROMPT"`; it is a task-level user prompt, not a published system message.

Its hierarchy is: defeat the dragon and verify the kill; use the listed gameplay advice as suggestions rather than a checklist or fixed order. The advice includes iron protection before a deeper diamond trip, diamond armor as useful Nether preparation, pearls and blaze rods for Eyes of Ender, and End preparation. It recommends substantial food and an End bow/arrow loadout, but tells the agent to adapt to observed conditions. The prompt itself does not specify a mandatory rod count.

The complete native Claude Code system/developer prompt is **not public**. The dataset's [`MANIFEST.md`](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/MANIFEST.md) says the native session file was withheld; the published transcript contains a system/init record and tool-call trajectory, not that native prompt. Therefore we can reuse the published task prompt verbatim, but cannot claim to reproduce Claude's entire instruction stack.

## Recorded run configuration

| Setting | Published value |
|---|---|
| Run mode | Fresh world, persistent session |
| Seed | `97996358` |
| Game | Minecraft Java 1.21.4; server JAR SHA-1 `4707d00eb834b446575d89a61a11b5d548d8c001` |
| Game mode / difficulty | Survival / Normal |
| Model / effort | `claude-opus-5[1m]` / `high` |
| Context window | 1,000,000 tokens, from the recorded result's model usage |
| Client | Claude Code 2.1.268; `permissionMode: dontAsk`; `apiKeySource: none` (subscription run) |
| Tool configuration | Strict MCP config; only `mcp__minecraft__*` allowed; other setting sources disabled |

The run manifest and pinned [`compose.beatthegame.yaml`](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/compose.beatthegame.yaml) record the model, effort, and seed. Pinned [`docker/prepare.mjs`](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docker/prepare.mjs) writes `gamemode=survival` and `difficulty=normal`. The pinned [`docker/entrypoint.sh`](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docker/entrypoint.sh) shows the model/tool flags. Temperature and other sampling parameters are not recorded, so they cannot be matched from public evidence.

## Status context and tool calls (pre-benchmark Acacia run)

The transcript's initial system record lists tool names and the connected MCP server; it does not inject a live inventory/status snapshot each turn. The agent's first gameplay call is `view_status`, followed by `note_read`. It explicitly called `view_status` **24 times in 388 tool calls (6.2%)**, not every turn. The calls cluster around uncertainty, hazards, and phase changes. Most action responses provide their own receipts: for example, collection reports requested and gained counts, start/current position, travel, completion state, and vitals. Across all 388 recorded tool results, 361 (93%) include a `Vitals` line and 237 (61%) include `Final progress`.

The run used 37 distinct exposed tool names. In the current Acacia run catalogue (`8133c1089689`), 34 names overlap, but the surfaces are not identical:

| Catalog difference | Tools |
|---|---|
| Mine AI had; current Acacia did not expose | `raw_action`, `set_survival_policy`, `shoot_dragon` |
| Current Acacia had; Mine AI did not expose | `ensure_items` |

Tool-name parity alone would not guarantee execution parity. Mine AI's pinned async-action contract admits an objective-sized foreground action, returns pending progress or a settled typed receipt, and prevents a successor until the result is retrieved. Its calls also use short per-action `rationale` text. The public [`async-actions.md`](https://github.com/aibengineering/mine-ai-mcp/blob/de4fef3260424d973bf81d0eaa15ff1a2f73ecff/docs/mcp/async-actions.md) describes those semantics. The actual Acacia tool contracts and rationale schema should be compared before declaring the systems equivalent.

## Implication for an Acacia comparison

The most faithful public benchmark configuration is a fresh **Normal Survival** world on seed `97996358`, Minecraft 1.21.4 with the recorded server JAR, and the verbatim task prompt. Matching the task prompt is feasible; matching Claude Code's hidden native prompt or unpublished sampling defaults is not. Luna/high matches the recorded reasoning effort, but the model itself remains different.

The published run took 3h56m and made 388 tool calls; the exact model and run outcome are recorded in [`MANIFEST.md`](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/MANIFEST.md). The dataset is non-deterministic: matching seed and settings recreates the world/configuration, not the action sequence.

## Acacia benchmark launched 2026-11-16

Run `7883ddc42825` is active in Normal Survival with seed `97996358`, Minecraft 1.21.4, the same server JAR SHA-1, the same Mine AI source revision (`de4fef3260424d973bf81d0eaa15ff1a2f73ecff`), and model `gpt-6-luna` at high reasoning effort. Its manifest records prompt SHA-256 `cfa70c72f6c392d5dd063be488ce50322a03372fa37abb9fa61e1f84cd4e1949`, matching the public `prompt.txt`. Its initial runtime catalogue exposes 37 tools, with exact name parity against the published transcript's 37-tool catalogue. The built image differs only by the dashboard/viewer patch needed by this service.

This is a controlled harness comparison, not a reproduction of the winning run: the model is Luna rather than Claude Opus, and the native Claude Code system/developer prompt and sampling defaults are unavailable. The manifest records the settings Acacia actually used; the transcript should be compared for milestone times, call count, status reads, failures, and time without progress as it accumulates.

## Primary sources

- [Dataset artifacts and license](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft)
- [Verbatim task prompt](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/prompt.txt)
- [Run manifest/configuration](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/run.json)
- [Transcript and system/init tool list](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/transcript.jsonl)
- [Winning commit, tag `beat-the-game`](https://github.com/aibengineering/mine-ai-mcp/tree/de4fef3260424d973bf81d0eaa15ff1a2f73ecff)
