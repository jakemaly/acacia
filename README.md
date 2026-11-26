# Mine AI Minecraft

Pi plays a fresh Minecraft 1.21.4 Survival world on a randomly generated seed. The [Mine AI MCP server](mine-ai-mcp/) owns the bot Acacia, actions, and survival reflexes. It is based on [Mine AI MCP](https://github.com/aibengineering/mine-ai-mcp). The dashboard starts and stops local runs or parallel Modal worlds, shows tool activity, and embeds the bot’s first-person view. The Minecraft client can join a local world as spectator.

Pi uses GPT-6 Luna at high reasoning through ChatGPT sign-in. Select **Survival** or **Hardcore** before pressing **Start**. Both modes share the goal and milestone priorities informed by the [published Mine AI run](https://huggingface.co/datasets/aibengineering/beat-the-game-minecraft/resolve/main/prompt.txt) (CC BY 4.0, aibengineering); Hardcore adds one-life and nearby-recovery guidance. The original win used Claude Opus 5 at high effort in Claude Code. Tool-call rationales state the immediate objective and relevant observation. Each attempt begins from an empty world. Success requires the server to record the bot’s `minecraft:end/kill_dragon` advancement.

## Run locally

Use Linux, Node 24.15+, and Docker Engine 28+ with isolated bridge support. Accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) before launching.

```sh
npm ci
docker pull eclipse-temurin:21-jre@sha256:a80c51f2d09a3e7e00d521f1c817bbceb6b3be94109b4a784d46078099882dda
npm run build:bot
npm start
```

Run `npm run build:bot` after editing the MCP server. It builds from the current checkout, including non-ignored new and modified source files. The next run uses the new image. Run manifests record the image ID, source commit, working-tree state and source snapshot digest. The previous image is retained as `minecraft-mine-ai:previous`.

If the default local game image is missing, starting a new run automatically rebuilds it from the current checkout before Minecraft starts. A stopped world still requires its original recorded image; an older or different build is never substituted for it.

Open http://127.0.0.1:2718. The default Pi credential directory is `~/.local/share/minecraft-agent/pi`. To sign in or refresh an expired login, run `PI_CODING_AGENT_DIR="$HOME/.local/share/minecraft-agent/pi" npx --no-install pi` and use `/login` to sign in with ChatGPT. Exit Pi before starting a run. The first run downloads and verifies Mojang’s server JAR. To use an existing verified copy, set `MINECRAFT_SERVER_JAR` to its absolute path.

Run the user service from `~/projects/minecraft` so :2718 uses the Git checkout directly:

```sh
mkdir -p "$HOME/.config/systemd/user"
ln -sfn "$PWD/deploy/minecraft-agent.service" "$HOME/.config/systemd/user/minecraft-agent.service"
systemctl --user daemon-reload
systemctl --user enable --now minecraft-agent.service
```

From another machine over SSH, replace `SERVER_TAILSCALE_IP` with the dashboard host’s configured `MINECRAFT_HOST` and `SSH_HOST` with its SSH hostname. Then open the local address in a browser:

```sh
ssh -N -L 2718:SERVER_TAILSCALE_IP:2718 SSH_HOST
```

Open **Runs** in the dashboard to play or download a saved WebM.

The service reads `~/.config/minecraft-mine-ai.env`; set `MINECRAFT_HOST` and `MINECRAFT_CLIENT_TAILSCALE_IP` there to the server and operator addresses. The default ports are 2718 for the dashboard, 3000 for the viewer, and 25565 for Minecraft. Keep the corresponding tailnet grants. MCP crosses the sandbox on a private Unix socket. Docker runs the game and bot with an isolated bridge, read-only roots, dropped capabilities, resource limits, and per-run writable mounts.

Each attempt writes its manifest, Pi JSONL session, activity, server log and world, and Mine AI SQLite data under `~/.local/share/mine-ai`. A new run always gets a new directory. If the model ends early, Pi prompts it again in the same session. Three follow-ups without a newly completed action end the attempt as incomplete. Pi reconnects expired MCP sessions in place. Terminal provider errors and operator stops end the attempt.

Every run also records the bot’s first-person view to `recording/recording.webm` in that run directory. Recording begins when the bot spawns and ends when the run stops; Survival deaths and respawns remain in the same video. Open a saved run in **Runs** to play or download its recording. `recording/recording.json` reports completion or a nonfatal recording error. Recordings stay with the run and are not pruned automatically.

## Parallel worlds on Modal

The existing dashboard runs the controllers and Pi locally, using the same ChatGPT sign-in. Each Modal Sandbox runs one isolated Minecraft world and bot. The dashboard connects to the worker through an authenticated Modal tunnel; the workers do not need SSH, Tailscale, or the OpenAI credential. Keep the dashboard host running while the worlds are playing. When the dashboard loses contact, a worker saves its world and exits after its heartbeat expires.

Before starting, authenticate the Modal CLI on the dashboard host and set the Modal workspace out-of-pocket spend limit to **$0** in Modal's Usage & Billing settings. This lets applicable free credits pay for compute without authorizing charges beyond them. After verifying that setting, record that verification locally (use the configured `MINECRAFT_RUNS` directory if different):

```sh
mkdir -p "${MINECRAFT_RUNS:-$HOME/.local/share/mine-ai}"
printf '%s\n' '{"workspaceSpendLimitUsd":0}' > "${MINECRAFT_RUNS:-$HOME/.local/share/mine-ai}/modal-budget-verified.json"
chmod 600 "${MINECRAFT_RUNS:-$HOME/.local/share/mine-ai}/modal-budget-verified.json"
```

The Modal SDK does not expose a way to verify that workspace setting, so do not write the confirmation until the limit is actually set. The dashboard checks metered workspace usage before starting and every minute while running, including a reserve for reporting delay. It pauses and saves the batch near $28 of metered usage or when billing data is unavailable. This conservative guard does not calculate the remaining credit balance; the $0 out-of-pocket limit is the independent financial backstop. If the first four-world pilot costs over $1 per hour, it pauses for review. A pause is not instantaneous and billing can lag.

Choose **Modal**, set the world count (four by default), choose the game mode, and press **Start**. While a batch runs, change the count and select **Set worlds** to add or stop slots; the remaining worlds continue. The first start installs the pinned SDK and builds a reusable worker image; later attempts use cached builds when the source has not changed. Each new attempt snapshots the current tracked and non-ignored source, including local edits, and records its digest and Git revision. Existing worlds retain their original release when resumed. A Hardcore death starts a fresh world in that slot; a dragon victory stops the whole batch. Select a world card to use the unchanged live view, conversation and activity panels for that world.

Stop saves all worlds. A provider interruption or worker rollover saves and resumes the same worlds and Pi sessions when possible; after three consecutive failed attempts a slot pauses the batch. Worker lifetime is limited by Modal, so long runs are saved and moved to a new worker before that limit. Modal Volumes retain worlds, server and bot logs, recordings, and archived Pi sessions. Open **Runs** to watch recording segments or download a stopped world and its logs. Pi session and activity files also remain on the dashboard host. These files and recordings are not automatically deleted and Modal storage can incur charges. An abrupt loss can lose changes since the latest Minecraft save or transcript upload; recovery does not promise tick-exact replay.

## Hardcore

Set `MINECRAFT_HARDCORE=1` to default new dashboard and API starts to Hardcore. API callers can select the mode with `POST /api/start?mode=hardcore` or `POST /api/start?mode=survival`. Hardcore uses Java Hard difficulty, gives the model the [expedition and recovery instructions](deploy/hardcore.txt), and ends the attempt on a server death. A separate model call reviews recent game evidence and saves a short diagnosis, evidence, uncertainty, and a question for the maintainer. Open the finished attempt under **Runs** to read its death review, or read `reflection.json` in the run directory. The dashboard starts a fresh Hardcore world with a new random seed and the baseline settings, even if the review fails. The next run records its seed, settings, and the previous run ID in `run.json`. Reviews are available to the maintainer and stay outside the gameplay context.

The dashboard owns death retries. The overseer still handles infrastructure interruptions. Use the dashboard Stop control to end the loop. A verified Dragon kill ends the loop automatically.

## Checkpoint collection

To opt in, select **Collect checkpoints** in the dashboard before pressing **Start**. You can also start a collection session through the API. Fresh worlds launched automatically after Hardcore deaths inherit the session ID and baseline settings.

```sh
curl -fsS -X POST -H 'Origin: http://127.0.0.1:2718' 'http://127.0.0.1:2718/api/start?collect=1'
```

Collection requires GNU tar, zstd, nice, and ionice on the dashboard host. The collector observes vanilla autosaves during play and tries a background copy of the on-disk world. It skips danger and copies that change while being read. The two rolling slots hold the latest accepted save and an older save from a calm stretch. An observed drop to half health or a death retains the available pre-danger copies for that incident. A sustained recovery starts a new incident. Capture pauses at a shared 2 GiB disk cap and gameplay continues.

Find collection indexes at `$MINECRAFT_RUNS/checkpoints/SESSION/RUN/index.json`. Each index records accepted and skipped saves the interval between observed autosaves, and the age of retained checkpoints at the first observed danger. Each retained checkpoint contains the world and can include a bounded Pi transcript. The transcript ends at a completed decision boundary at or before the player save and can precede the world by the age recorded in its metadata.

## Mine Labs

Open **Runs** to launch one isolated fixture or replay one published checkpoint. Fixtures are versioned JSON files under `fixtures/`; each describes its seed, setup, controller activation, time limit, and independently checked success conditions. Blaze requires the separately configured Candidate image, which contains its experimental tool. Set `MINE_AI_CANDIDATE_IMAGE` in `~/.config/minecraft-mine-ai.env` to use an existing candidate image.

Checkpoint replays restore the selected world into a new run directory and resume the saved Pi conversation when present. A world-only checkpoint needs a task. Optional inventory or block checks can stop a replay as soon as the independent verifier confirms them; without checks, there is no task-success verdict. Death, the time limit, and Stop also end the attempt. Open the saved run in **Runs** to inspect its evidence or repeat it. New fixture authoring from the dashboard is a later step; add versioned fixture files in the repository for now.

```sh
node src/checkpoints.mjs restore "$MINECRAFT_RUNS/checkpoints/SESSION/RUN/CHECKPOINT" /path/to/new-replay-directory
```

To play the restored world locally, start the pinned 1.21.4 server JAR from the replay directory after accepting the Minecraft EULA there. The restore binds to loopback and preserves the saved game mode when the original offline player name rejoins. It loads serialized world and player state. Pending actions, transient simulation state, and exact tick replay are outside that format.

## Verify

Run `npm run check` and `npm test`. In `mine-ai-mcp`, run `bun install --frozen-lockfile` and `bun run test`. After building the image, run `MINECRAFT_SMOKE=1 node --test test/smoke.test.mjs` for the Docker and Pi integration tests, including a forced Hardcore death and fresh-world restart. Run `MINECRAFT_CHECKPOINT_SMOKE=1 node --test --test-name-pattern='natural Hardcore autosave' test/smoke.test.mjs` to verify collection and replay across a natural autosave.

## Overseer

The user-level `minecraft-overseer.timer` checks the dashboard and run directories every 15 seconds. A terminal attempt or a run directory abandoned by a stopped harness can wake the configured Codex chat. The overseer reports bugs for human review and can restart after a verified external recovery. A vanilla-server `Free the End` advancement for the bot takes priority and ends the overseer after it reports the result. The watcher saves its progress in `overseer.json` beside the runs.

Install `deploy/minecraft-overseer.{service,timer}` under `~/.config/systemd/user`. Set `MINECRAFT_OVERSEER_REPO` and `MINECRAFT_OVERSEER_THREAD` in `~/.config/minecraft-overseer.env` to the worktree and existing Codex chat ID. Use `node src/overseer.mjs arm` with the same runtime directory as the dashboard to begin watching subsequent attempts. Enable the timer with `systemctl --user enable --now minecraft-overseer.timer`. To suspend automatic follow-up, stop the timer. The watcher's decisions are visible in `journalctl --user -u minecraft-overseer.service`.

## Research and contributing

For changes to Minecraft MCP tools, see [Creating MCP tools for Acacia](docs/mcp-tools.md). The research notes capture the published winning-run setup, a comparison of its tool use, recent Hardcore run audits, and evidence about learning across attempts:

- [Mine AI winning-run prompt and settings](docs/research/mine-ai-winning-run-prompt-and-settings.md)
- [Why the Mine AI run stayed on task](docs/research/luna-mine-ai-deep-dive.md)
- [GPT-6 Luna Hardcore run audit](docs/research/luna-hardcore-speedrun-audit-2026-11-15.md)
- [Lumi and learning across Hardcore attempts](docs/research/lumi-hardcore-learning-loop.md)
- [Mineflayer inventory display research](docs/mineflayer-web-inventory-research.md)
