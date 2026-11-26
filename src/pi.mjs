import { rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { McpClient, McpConnectionClosedError, McpError, McpSessionExpiredError, StreamableHttpTransport, toLlmContent } from '@earendil-works/pi-mcp';
import { Agent, fetch } from 'undici';
import { gameArguments, gameTools, statusContent } from './game-tools.mjs';
import { filterStatusPlayers } from './status-privacy.mjs';
import { followAction } from './action-wait.mjs';
import { evaluateLabChecks, readLabEvidence } from './labs.mjs';

export const modelId = 'gpt-6-luna';
export const thinkingLevel = 'high';
const maxContinuationsWithoutAction = 3;
const continuePlaying = 'The server has not verified a dragon kill. Continue playing from the current world state.';

/** A resumed world gets a new model context; saved transcripts stay available to the operator. */
export function freshPrivateSession(directory) {
  return SessionManager.create(directory, directory);
}

export function initialAgentPrompt(promptText, resumeSession, instruction) {
  return resumeSession
    ? `${promptText}\n\n${instruction || 'The world has resumed. Inspect the current status and pending actions before continuing.'}`
    : promptText;
}

function mcpDisconnected(error) {
  return error instanceof McpConnectionClosedError || error.cause?.code === 'UND_ERR_SOCKET' ||
    (error instanceof McpError && error.code === -32603 && error.message.startsWith('MCP response stream failed:'));
}

function labToolResultDetails(result) {
  const message = (result?.content ?? []).filter(item => item.type === 'text')
    .map(item => item.text).join('\n').slice(0, 4000);
  return {
    isError: Boolean(result?.isError),
    ...(result?.details?.structuredContent !== undefined && { result: result.details.structuredContent }),
    ...(result?.isError && message && { error: message }),
  };
}

function assistantText(message) {
  if (typeof message?.text === 'string') return message.text;
  if (!Array.isArray(message?.content)) return '';
  return message.content.filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text).join('\n');
}

function decisionFromRationale(rationale, reply) {
  const text = assistantText(reply).trim();
  const fields = text.match(/^Objective:\s*([^\r\n]+)\r?\nObservation:\s*([^\r\n]+)$/i);
  if (fields) {
    const [objective, observation] = fields.slice(1).map(line => line.trim());
    if (objective && observation) return { objective, observation };
  }
  const fallback = typeof rationale === 'string' ? rationale.trim() : '';
  return fallback ? { text: fallback } : undefined;
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

export async function play({ directory, socket, remoteMcp, agentDir, signal, record, promptText, collectContext = false,
  inference = openai, lab, collectLabEvidence, onLabOutcome, onLabControllerStart, resumeSession, resumeSettings, instruction }) {
  const { runtime, model } = ['tool', 'idle'].includes(lab?.controller?.type) ? {} : await inference(agentDir);
  if (Boolean(socket) === Boolean(remoteMcp)) throw new Error('Select exactly one Minecraft MCP connection.');
  if (remoteMcp) {
    const target = new URL(remoteMcp.url);
    if (target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname))) {
      throw new Error('Remote Minecraft MCP requires HTTPS.');
    }
    if (!remoteMcp.token) throw new Error('Remote Minecraft MCP requires a connection token.');
  }
  const dispatcher = socket ? new Agent({ connect: { socketPath: socket } }) : undefined;
  let client;
  async function connectMcp() {
    client = new McpClient({ name: 'Pi Minecraft', version: '1.0.0', requestTimeoutMs: 180_000 });
    await client.connect(new StreamableHttpTransport({
      url: remoteMcp?.url ?? 'http://127.0.0.1:25575/mcp',
      ...(remoteMcp && { headers: { Authorization: `Bearer ${remoteMcp.token}` } }),
      fetch: (url, options) => fetch(url, {
        ...options, ...(dispatcher && { dispatcher }), signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
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
        const activatesFixture = lab?.controller?.type === 'tool' && lab.controller.name === tool.name;
        const rawResult = tool.foreground
          ? await followAction({ name: target, args: { ...args, submission_id: randomUUID() },
            executionLimit: tool.executionLimit,
            call: (name, params) => callMinecraft(name, params, toolSignal, true),
            onAccepted: activatesFixture ? onLabControllerStart : undefined,
            isTransportFailure: error => mcpDisconnected(error) || error instanceof McpSessionExpiredError,
            onProgress: progress => record('action_progress', { id, tool: tool.name, ...progress }),
          }) : await (async () => {
            const pending = callMinecraft(target, args, toolSignal, tool.name === 'wait_for_action');
            if (activatesFixture) await onLabControllerStart?.();
            return pending;
          })();
        // Old settled actions can contain player lists too (for example sleep).
        const result = filterStatusPlayers(rawResult);
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
    if (lab && ['tool', 'idle'].includes(lab.controller?.type)) {
      record('catalogue', { tools: catalogue, model: model?.id, labController: lab.controller.type });
      const observe = () => readLabEvidence(client, lab.checks, signal);
      const baseline = await observe();
      if (lab.controller.type === 'tool') {
        const tool = tools.find(candidate => candidate.label === lab.controller.name);
        if (!tool) throw new Error(`The selected Mine AI image does not provide ${lab.controller.name}.`);
        const id = randomUUID();
        const startedAt = Date.now();
        const toolName = `mcp__minecraft__${tool.label}`;
        let toolEndRecorded = false;
        const recordToolEnd = details => {
          if (toolEndRecorded) return;
          toolEndRecorded = true;
          record('tool_execution_end', { id, tool: toolName, durationMs: Date.now() - startedAt, ...details });
        };
        const recordToolFinish = async outcome => {
          const settled = await Promise.race([execution, delay(1000, null, { ref: false })]);
          const details = settled?.type === 'error'
            ? { isError: true, error: settled.error.message }
            : settled ? labToolResultDetails(settled.result)
              : { isError: true, outcome: 'stopped' };
          recordToolEnd({ ...details, ...(outcome && { outcome }) });
        };
        record('tool_execution_start', { id, tool: toolName, args: lab.controller.arguments });
        const execution = tool.execute(id, lab.controller.arguments, signal).then(
          result => ({ type: 'completed', result }), error => ({ type: 'error', error }),
        );
        const monitorAbort = new AbortController();
        const monitorSignal = AbortSignal.any([signal, monitorAbort.signal]);
        const monitoring = lab.checks.length
          ? monitorLab(baseline, monitorSignal).then(outcome => ({ type: 'outcome', outcome }), error => ({ type: 'error', error }))
          : null;
        try {
          const completed = await Promise.race([execution, ...(monitoring ? [monitoring] : [])]);
          if (completed.type === 'error') throw completed.error;
          if (completed.type === 'outcome') {
            await recordToolFinish('stopped_after_verified_result');
            return `Lab tool ${tool.label} reached an independently verified result.`;
          }
          const controllerResult = completed.result;
          const controllerResultDetails = labToolResultDetails(controllerResult);
          recordToolEnd(controllerResultDetails);
          monitorAbort.abort();
          const { evidence, outcome } = await assessLab(baseline, signal, undefined, controllerResultDetails);
          await onLabOutcome?.({ ...outcome, evidence, controllerResult: controllerResultDetails });
          return `Lab tool ${tool.label} finished. Verified result: ${outcome.passed ? 'passed' : 'failed'}.`;
        } finally {
          monitorAbort.abort();
          if (!toolEndRecorded) await recordToolFinish();
        }
      }
      if (lab.controller.type === 'idle') {
        let previous = baseline;
        await onLabControllerStart?.();
        while (!signal.aborted) {
          await delay(3000, undefined, { signal, ref: false });
          const { evidence, outcome } = await assessLab(baseline, signal, previous);
          previous = evidence;
          if (!outcome.passed) continue;
          await onLabOutcome?.({ ...outcome, evidence });
          return 'Lab reflex fixture reached its independently verified outcome.';
        }
      }
      throw new Error(`Unsupported lab controller: ${lab.controller?.type ?? 'missing'}.`);
    }
    if (lab && lab.controller?.type !== 'agent') throw new Error(`Unsupported lab controller: ${lab.controller?.type ?? 'missing'}.`);
    const settingsManager = SettingsManager.inMemory({
      // Leave room to summarize the transcript and for provider request overhead.
      compaction: { enabled: true, reserveTokens: Math.floor(model.contextWindow * 0.4) },
      cacheWarming: 'off',
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: directory, agentDir, settingsManager, noExtensions: true, noSkills: true,
      noContextFiles: true, noPromptTemplates: true, noThemes: true, appendSystemPrompt: [],
      systemPrompt: client.instructions,
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({
      cwd: directory, agentDir, model, modelRuntime: runtime, thinkingLevel, settingsManager, resourceLoader,
      // Older transcripts can contain player names or chat. Resume the world
      // with a fresh agent context rather than replaying those private records.
      sessionManager: freshPrivateSession(directory),
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
        const decision = event.type === 'tool_execution_start'
          ? decisionFromRationale(event.args?.rationale, lastReply) : undefined;
        record(event.type, { id: event.toolCallId, tool: event.toolName, isError: event.isError, actionId, outcome, decision });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        lastReply = event.message;
        const { model, usage, stopReason, rawStopReason, errorMessage } = event.message;
        record('assistant', { model, usage, stopReason, rawStopReason, errorMessage });
      }
    });
    const monitoring = lab?.checks?.length ? monitorLab() : null;
    signal.addEventListener('abort', stop, { once: true });
    signal.throwIfAborted();
    let prompt = initialAgentPrompt(promptText, resumeSession, instruction);
    for (;;) {
      signal.throwIfAborted();
      lastReply = undefined;
      await Promise.race([session.prompt(prompt), monitoring ?? new Promise(() => {})]);
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

    async function monitorLab(baseline, watchSignal = signal) {
      baseline ??= await observeLab(watchSignal);
      while (!watchSignal.aborted) {
        await delay(3000, undefined, { signal: watchSignal, ref: false });
        const { evidence, outcome } = await assessLab(baseline, watchSignal);
        if (outcome.passed) {
          await onLabOutcome?.({ ...outcome, evidence });
          return;
        }
      }
    }

    async function observeLab(observationSignal = signal, controllerResult) {
      return { ...await readLabEvidence(client, lab.checks, observationSignal),
        ...(controllerResult && { controllerResult }),
        ...await collectLabEvidence?.(lab.checks) };
    }

    async function assessLab(baseline, observationSignal = signal, previous, controllerResult) {
      const evidence = await observeLab(observationSignal, controllerResult);
      const outcome = evaluateLabChecks(lab.checks, evidence, baseline.status);
      if (!previous || JSON.stringify(evidence) !== JSON.stringify(previous)) record('lab_observation', { evidence, outcome });
      return { evidence, outcome };
    }
  } finally {
    signal.removeEventListener('abort', stop);
    session?.dispose();
    await client?.close().catch(() => {});
    await dispatcher?.destroy();
  }
}
