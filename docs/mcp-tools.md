# Creating MCP tools for Acacia

Acacia's model chooses the objective and invokes Minecraft MCP tools. Tool implementation lives in `mine-ai-mcp/` beside the dashboard, run harness, and adapter. Do not add model-side scripts, workspace paths, or file-writing tools to make gameplay happen.

## 1. Start in the MCP directory

The MCP server is in this checkout.

```sh
cd mine-ai-mcp
bun install --frozen-lockfile
```

## 2. Add a domain-level action

Create `src/actions/<tool-name>/` following a nearby action such as `collect-block` or `eat-food`:

- `contract.ts` defines strict Zod input and result schemas, parsing, evidence, and clear error outcomes.
- `<tool-name>.ts` implements the action and its factory. Use `defineAction()` from `src/actions/action.ts` so the runtime output is generated from the action's typed result.
- `index.ts` exports the contract and implementation.
- Add focused tests beside the implementation for validation, success, partial progress, blockers, and cancellation as applicable. Represent a blocker with a typed failed result and a clear reason.

Design the action around a useful objective, not a sequence of clicks. Let the executor own ordinary navigation, collection, pickup, and immediate survival responses. The model should choose what it wants and any meaningful limits; it should not need to micromanage each step. Put bounds on travel, retries, resources, and time, and return a reason when a bound or hazard stops the work.

Return observed evidence in the result: what was requested, what changed, what remains, and why execution stopped. Use `partial` when useful progress happened but the objective is unfinished. Do not report success from an attempted action alone.

For short work, use a one-shot `task` or `information` action. For long-running objectives, use Mine AI's `resumable_task` lifecycle so callers can observe progress, wait for the settled typed result, or cancel the specific action. See [async actions](../mine-ai-mcp/docs/mcp/async-actions.md).

Register the action in `src/actions/catalog.ts` and inject only the dependencies it needs through its factory. The catalog is the MCP server's source of truth.

## 3. Check Acacia's adapter only when needed

Acacia reads the MCP catalog at run start. Most new actions pass through automatically. Update `src/game-tools.mjs` only when Acacia needs a model-friendly alias, a narrowed schema, or argument defaults for an existing MCP action. Keep execution in Mine AI; the adapter must not become a second implementation of the action.

The gameplay model receives Minecraft tools, not access to Acacia's host files. Host-owned run manifests, transcripts, logs, and world saves are operational records and are not a tool API.

## 4. Verify and build

From the MCP repository, run:

```sh
bun run test
```

Add behavior tests for the action's real stopping conditions and evidence, not just schema snapshots. For foreground work, cover progress, cancellation, interruption by survival reflexes, resumption, and settled receipts.

From the repository root, run `npm run build:bot` after changing the server. Confirm a fresh run's recorded source revision and image digest, and check the recorded MCP catalog to verify the new schema is exposed. Keep the gameplay prompt and unrelated runtime settings fixed while evaluating a tool change.
