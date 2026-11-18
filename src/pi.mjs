import { rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { McpClient, McpConnectionClosedError, McpError, McpSessionExpiredError, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { Agent, fetch } from 'undici';
import { gameArguments, gameTools, statusContent } from './game-tools.mjs';
import { filterStatusPlayers } from './status-privacy.mjs';
import { followAction } from './action-wait.mjs';

export const modelId = 'gpt-6-luna';
export const thinkingLevel = 'high';
const maxContinuationsWithoutAction = 3;
const continuePlaying = 'The server has not verified a dragon kill. Continue playing from the current world state.';

function mcpDisconnected(error) {
  return error instanceof McpConnectionClosedError || error.cause?.code === 'UND_ERR_SOCKET' ||
    (error instanceof McpError && error.code === -32603 && error.message.startsWith('MCP response stream failed:'));
}

function decisionFromRationale(rationale) {
  if (typeof rationale !== 'string') return;
  const fields = rationale.trim().match(/^Objective:([^\r\n]+)\r?\nObservation:([^\r\n]+)\r?\nChange course if:([^\r\n]+)$/i);
  if (!fields) return;
  const [objective, observation, changeCourse] = fields.slice(1).map(line => line.trim());
  if (objective && observation && changeCourse) return { objective, observation, changeCourse };
}

export async function openai(agentDir) {
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: fileURLToPath(new URL('../deploy/models.json', import.meta.url)), refreshOnCreate: false,
  });
  const credential = (await runtime.listCredentials()).find(item => item.providerId === 'openai');
  if (credential?.type !== 'oauth') throw new Error('Sign in to Pi with ChatGPT OAuth before starting a run.');
  const model = runtime.getModel('openai', modelId);
  if (model?.api !== 'openai-responses') throw new Error(`Pi does not support ${modelId} through OpenAI Responses.`);
  const getAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = async (target, options) => {
    const resolution = await getAuth(target, options);
    if (resolution?.source !== 'OAuth') throw new Error('Pi requires ChatGPT OAuth for every request.');
    return resolution;
  };
  const stream = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (target, context, options) => {
    // Pi passes a pre-resolved token into compaction. Resolve it through OAuth again for the request.
    const { apiKey: _apiKey, ...request } = options ?? {};
    return stream(target, context, { ...request, timeoutMs: Math.max(request.timeoutMs ?? 0, 30 * 60_000) });
  };
  return { runtime, model };
}

export async function play({ directory, socket, agentDir, signal, record, promptText, collectContext = false, inference = openai }) {
  const { runtime, model } = await inference(agentDir);
  const dispatcher = new Agent({ connect: { socketPath: socket } });
  let client;
  async function connectMcp() {
    client = new McpClient({ name: 'Pi Minecraft', version: '1.0.0', requestTimeoutMs: 180_000 });
    await client.connect(new StreamableHttpTransport({
      url: 'http://127.0.0.1:25575/mcp',
      fetch: (url, options) => fetch(url, {
        ...options, dispatcher, signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
      }),
    }));
  }
  let session;
  let lastReply;
  let continuationsWithoutAction = 0;
  const completedActions = new Set();
  const stop = () => { void session.abort().catch(() => {}); };
  try {
    signal.throwIfAborted();
    await connectMcp();
    const catalogue = await client.listTools({ signal });
    if (catalogue.some(tool => tool.name.startsWith('debug_'))) {
      throw new Error('Mine AI exposed debug tools to the gameplay session.');
    }
    for (const name of ['view_status', 'wait_for_action', 'cancel_foreground_action']) {
      if (!catalogue.some(tool => tool.name === name)) throw new Error(`Mine AI is missing ${name}.`);
    }
    async function callMinecraft(name, args, toolSignal, replayable = false) {
      try {
        return await client.callTool(name, args, { signal: toolSignal });
      } catch (error) {
        const expired = error instanceof McpSessionExpiredError;
        const disconnected = mcpDisconnected(error);
        if (!expired && !disconnected) throw error;
        signal.throwIfAborted();
        toolSignal?.throwIfAborted();
        await client.close();
        await connectMcp();
        record('mcp_reconnected', {});
        // A 404 rejects the call before dispatch. After a dropped connection its outcome is unknown.
        if (disconnected && !replayable) {
          throw new Error('Minecraft MCP reconnected. Check view_status and retrieve any pending action before retrying.');
        }
        return client.callTool(name, args, { signal: toolSignal });
      }
    }
    const tools = gameTools(catalogue).map(tool => ({
      name: `mcp__minecraft__${tool.name}`,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(id, args, toolSignal) {
        const compactStatus = tool.name === 'view_status' && args.detail !== 'full' && args.response_format !== 'json';
        args = gameArguments(tool, args);
        const target = tool.target ?? tool.name;
        const rawResult = tool.foreground
          ? await followAction({ name: target, args: { ...args, submission_id: randomUUID() },
            executionLimit: tool.executionLimit,
            call: (name, params) => callMinecraft(name, params, toolSignal, true),
            isTransportFailure: error => mcpDisconnected(error) || error instanceof McpSessionExpiredError,
            onProgress: progress => record('action_progress', { id, tool: tool.name, ...progress }),
          })
          : await callMinecraft(target, args, toolSignal, tool.name === 'wait_for_action');
        const result = tool.name === 'view_status' ? filterStatusPlayers(rawResult) : rawResult;
        const response = result.structuredContent?.response;
        // Polling or retrieving an old result again does not make progress.
        const completed = response?.data?.output?.action ? response.data.actionId
          : response?.markdown?.match(/^Action ID: ([a-f0-9-]+)\n\n## `/)?.[1];
        if (!result.isError && completed && !completedActions.has(completed)) {
          completedActions.add(completed);
          continuationsWithoutAction = 0;
        }
        const { _meta, ...details } = result;
        const compact = compactStatus && !result.isError && statusContent(result.structuredContent);
        if (compact) return { content: compact, details, isError: false };
        const content = toLlmContent(result);
        if (result.content.length && result.structuredContent?.response?.format === 'json' &&
            (!result.structuredContent.handoff || args.response_format === 'json')) {
          content.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
        }
        return { content, details, isError: result.isError };
      },
    }));
    const settingsManager = SettingsManager.inMemory({
      // Leave room to summarize the transcript and for provider request overhead.
      compaction: { enabled: true, reserveTokens: Math.floor(model.contextWindow * 0.4) },
      cacheWarming: 'off',
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noContextFiles: true, noPromptTemplates: true, noThemes: true, appendSystemPrompt: [], systemPrompt: client.instructions,
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: directory, agentDir, model, modelRuntime: runtime, thinkingLevel, settingsManager, resourceLoader,
      sessionManager: SessionManager.create(directory, directory),
      customTools: tools, noTools: 'all', tools: tools.map(tool => tool.name),
    }));
    // A wait and its successor must reach Mine AI in the order Pi emitted them.
    session.agent.toolExecution = 'sequential';
    if (session.getActiveToolNames().sort().join() !== tools.map(tool => tool.name).sort().join()) {
      throw new Error('Pi did not activate the configured Minecraft tools.');
    }
    record('catalogue', { tools: catalogue, model: model.id, contextWindow: model.contextWindow });
    if (collectContext) {
      const path = join(directory, 'checkpoint-context.json');
      // Capture the effective prompt and schemas without adding messages to Pi.
      void writeFile(`${path}.tmp`, JSON.stringify({
        systemPrompt: session.systemPrompt, tools: tools.map(({ execute, ...schema }) => schema),
      }), { mode: 0o600 }).then(() => rename(`${path}.tmp`, path)).catch(error => {
        console.error(`Could not record checkpoint context: ${error.message}`);
      });
    }
    session.subscribe(event => {
      if (event.type === 'compaction_end') {
        record(event.type, { reason: event.reason, tokensBefore: event.result?.tokensBefore,
          tokensAfter: event.result?.estimatedTokensAfter, willRetry: event.willRetry, errorMessage: event.errorMessage });
      }
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
        const { response, handoff } = event.result?.details?.structuredContent ?? {};
        const markdown = response?.markdown ?? '';
        const actionId = handoff?.actionId ?? response?.data?.actionId ?? markdown.match(/^Action ID: ([a-f0-9-]+)$/m)?.[1];
        const outcome = (handoff && 'pending') ?? response?.data?.state ?? (markdown.startsWith('**Accepted:**') ? 'accepted'
          : markdown.startsWith('## Action in progress') ? 'pending'
          : actionId ? 'settled' : undefined);
        const decision = event.type === 'tool_execution_start' ? decisionFromRationale(event.args?.rationale) : undefined;
        record(event.type, { id: event.toolCallId, tool: event.toolName, isError: event.isError, actionId, outcome, decision });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastReply = event.message;
        const { model, usage, stopReason, rawStopReason, errorMessage } = event.message;
        record('assistant', { model, usage, stopReason, rawStopReason, errorMessage });
      }
    });
    signal.addEventListener('abort', stop, { once: true });
    signal.throwIfAborted();
    let prompt = promptText;
    for (;;) {
      signal.throwIfAborted();
      lastReply = undefined;
      await session.prompt(prompt);
      signal.throwIfAborted();
      const last = lastReply;
      if (last?.errorMessage) throw new Error(last.errorMessage);
      if (last?.stopReason !== 'stop') {
        return `Pi stopped (${last?.rawStopReason ?? last?.stopReason ?? 'no model reply'}) before the server recorded a dragon kill.`;
      }
      if (continuationsWithoutAction === maxContinuationsWithoutAction) {
        return `The model kept ending early. ${maxContinuationsWithoutAction} follow-ups produced no completed Minecraft action.`;
      }
      record('continuation', { attempt: ++continuationsWithoutAction });
      prompt = continuePlaying;
    }
  } finally {
    signal.removeEventListener('abort', stop);
    session?.dispose();
    await client?.close().catch(() => {});
    await dispatcher.destroy();
  }
}
