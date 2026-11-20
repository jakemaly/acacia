# Creating MCP tools for Acacia

Acacia's model chooses the objective and invokes Minecraft MCP tools. The tool implementation belongs in the private Mine AI MCP repository; the Acacia repository contains the dashboard, run harness, and a thin adapter. Do not add model-side scripts, workspace paths, or file-writing tools to make gameplay happen.

## 1. Start in the private MCP repository

The tool source is [`jakemaly/mine-ai-mcp`](https://github.com/jakemaly/mine-ai-mcp), on the `acacia-compat` branch. That branch is based on the pinned Mine AI source described in `deploy/build-private-mcp-image.sh`.

```sh
git clone git@github.com:jakemaly/mine-ai-mcp.git
cd mine-ai-mcp
git fetch origin
git switch -c branch/<tool-name> origin/acacia-compat
```

Keep tool work private. Do not push Acacia-specific changes to Mine AI's public upstream repository.

## 2. Add a domain-level action

Create `src/actions/<tool-name>/` following a nearby action such as `collect-block` or `eat-food`:

- `contract.ts` defines strict Zod input and result schemas, parsing, evidence, and clear error outcomes.
- `<tool-name>.ts` implements the action and its factory. Use `defineAction()` from `src/actions/action.ts` so the runtime output is generated from the action's typed result.
- `index.ts` exports the contract and implementation.
- Add focused tests beside the implementation for validation, success, partial progress, blockers, and cancellation as applicable. Represent a blocker with a typed failed result and a clear reason.

Design the action around a useful objective, not a sequence of clicks. Let the executor own ordinary navigation, collection, pickup, and immediate survival responses. The model should choose what it wants and any meaningful limits; it should not need to micromanage each step. Put bounds on travel, retries, resources, and time, and return a reason when a bound or hazard stops the work.

Return observed evidence in the result: what was requested, what changed, what remains, and why execution stopped. Use `partial` when useful progress happened but the objective is unfinished. Do not report success from an attempted action alone.

For short work, use a one-shot `task` or `information` action. For long-running objectives, use Mine AI's `resumable_task` lifecycle so callers can observe progress, wait for the settled typed result, or cancel the specific action. See the private repository's [`docs/mcp/async-actions.md`](https://github.com/jakemaly/mine-ai-mcp/blob/acacia-compat/docs/mcp/async-actions.md).

Register the action in `src/actions/index.ts` and inject only the dependencies it needs through its factory. The catalog is the MCP server's source of truth.

## 3. Check Acacia's adapter only when needed

Acacia reads the MCP catalog at run start. Most new actions pass through automatically. Update `src/game-tools.mjs` only when Acacia needs a model-friendly alias, a narrowed schema, or argument defaults for an existing MCP action. Keep execution in Mine AI; the adapter must not become a second implementation of the action.

The gameplay model receives Minecraft tools, not access to Acacia's host files. Host-owned run manifests, transcripts, logs, and world saves are operational records and are not a tool API.

## 4. Verify and promote

From the MCP repository, run:

```sh
bun run test
```

Add behavior tests for the action's real stopping conditions and evidence, not just schema snapshots. For foreground work, cover progress, cancellation, interruption by survival reflexes, resumption, and settled receipts.

After review, merge the action into the private `acacia-compat` branch. Update the pinned `fork_commit` in `deploy/build-private-mcp-image.sh`, build the candidate image, and confirm a fresh run's recorded fork commit and image digest. Check the recorded MCP catalog to verify the new schema is actually exposed. Keep the gameplay prompt and unrelated runtime settings fixed while evaluating a tool change.
