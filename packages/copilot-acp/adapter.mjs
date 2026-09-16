import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import {
  configOptions,
  contextChoices,
  mcpConfig,
  promptInput,
  reasoningChoices,
  record,
  textContent,
  toolOutput,
} from './projection.mjs';

const MODES = ['interactive', 'plan', 'autopilot'];
// Commands requiring terminal dialogs, host effects or persistent settings are deliberately excluded.
const NATIVE_COMMANDS = new Set(['context', 'compact', 'diff', 'env', 'help']);
const invalid = (message) => RequestError.invalidParams({ message }, message);

/** Opt-in ACP agent; all model execution and coding tools remain in the native SDK server. */
export class CopilotAdapter {
  /**
   * @param connection ACP client connection.
   * @param sdk Native SDK transport.
   * @param ownership Adapter session ownership store.
   * @param {{model?: string, cancelTimeout?: number}} options Startup overrides.
   */
  constructor(connection, sdk, ownership, { model, cancelTimeout = 5000 } = {}) {
    this.connection = connection;
    this.sdk = sdk;
    this.ownership = ownership;
    this.preferredModel = model;
    this.cancelTimeout = cancelTimeout;
    this.sessions = new Map();
    /** @type {import('./projection.mjs').NativeModel[]} */
    this.models = [];
    this.initialized = false;
    this.closed = false;
    sdk.on('notification', (message) => {
      if (message.method !== 'session.event') return;
      const session = this.sessions.get(message.params?.sessionId);
      if (session && (!session.loading || message.params.event?.type === 'permission.requested')) {
        this.event(session, message.params.event);
      }
    });
    sdk.on('failure', (error) => {
      for (const session of this.sessions.values()) {
        session.fault = error;
        this.finish(session, { error });
      }
    });
    sdk.requestHandler = (method, params) => this.nativeRequest(method, params);
  }

  async initialize() {
    if (!this.initialized) {
      const result = await this.sdk.rpc('models.list', {});
      if (!Array.isArray(result?.models)) throw new Error('Copilot SDK did not provide model metadata');
      this.models = result.models.filter(
        (model) => record(model) && typeof model.id === 'string' && model.policy?.state !== 'disabled'
      );
      if (!this.models.length) throw new Error('No enabled Copilot models; authenticate with the native CLI first');
      this.initialized = true;
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: { name: 'aionui-copilot-sdk-acp', version: '0.1.0' },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true, image: false, audio: false },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { close: {} },
      },
      authMethods: [],
    };
  }

  async authenticate() {
    throw new Error('Authenticate separately with the native copilot login command, then reconnect this adapter');
  }

  getSession(id) {
    const session = this.sessions.get(id);
    if (!session || session.loading || session.closing || this.closed)
      throw invalid('Unknown or unavailable adapter session');
    if (session.fault) throw new Error(`Session must be closed and loaded again: ${session.fault.message}`);
    return session;
  }

  async newSession(params) {
    return this.openSession(params, false);
  }

  async loadSession(params) {
    return this.openSession(params, true);
  }

  async openSession(params, existing) {
    if (!this.initialized || this.closed) throw invalid('Initialize the adapter before opening sessions');
    if (!isAbsolute(params.cwd)) throw invalid('Session cwd must be absolute');
    const servers = mcpConfig(params.mcpServers ?? []);
    const id = existing ? params.sessionId : randomUUID();
    if (this.sessions.has(id)) throw invalid('Session is already open');
    await this.ownership.acquire(id, params.cwd, existing);
    const session = {
      id,
      cwd: params.cwd,
      loading: true,
      active: null,
      configuring: false,
      fault: null,
      model: {},
      mode: 'interactive',
      permission: 'manual',
      commands: [],
      output: Promise.resolve(),
      tools: new Map(),
      deltas: new Set(),
      permissions: new Map(),
    };
    this.sessions.set(id, session);
    try {
      const result = await this.sdk.rpc(existing ? 'session.resume' : 'session.create', {
        sessionId: id,
        workingDirectory: params.cwd,
        additionalDirectories: params.additionalDirectories ?? [],
        mcpServers: servers,
        streaming: true,
        requestPermission: true,
        requestUserInput: true,
        envValueMode: 'direct',
        ...(existing ? {} : { contextTier: 'default' }),
      });
      if (result.sessionId !== id) throw new Error('Native SDK returned an unexpected session identity');
      // Never inherit an unattended allow-all policy or autopilot mode from a resumed session.
      await this.sdk.rpc('session.permissions.setMode', { sessionId: id, mode: 'manual' });
      await this.sdk.rpc('session.mode.set', { sessionId: id, mode: 'interactive' });
      await this.refresh(session);
      if (!session.model.modelId) {
        const chosen =
          this.preferredModel ??
          this.models.find((model) => model.isDefault)?.id ??
          this.models.find((model) => model.id === 'auto')?.id ??
          this.models[0].id;
        if (!this.models.some((model) => model.id === chosen)) throw invalid('Requested startup model is unavailable');
        await this.switchModel(session, chosen, 'default');
      }
      const current = this.models.find((model) => model.id === session.model.modelId);
      if (!current) throw new Error('Saved model is unavailable; start a new adapter session');
      if (!contextChoices(current).some((choice) => choice.value === (session.model.contextTier ?? 'default'))) {
        await this.switchModel(session, current.id, 'default');
      }
      try {
        const listed = await this.sdk.rpc('session.commands.list', { sessionId: id });
        session.commands = (listed.commands ?? []).filter((command) => NATIVE_COMMANDS.has(command.name));
      } catch (error) {
        if (error.code !== -32601) throw error;
      }
      if (existing) {
        const history = await this.sdk.rpc('session.getMessages', { sessionId: id });
        if (!Array.isArray(history?.events)) throw new Error('Native SDK did not return session history');
        for (const event of history.events) this.event(session, event, true);
      } else await this.ownership.save(id, params.cwd);
      session.loading = false;
      this.update(session, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          ...session.commands.map(({ name, description, input }) => ({
            name,
            description,
            ...(input?.hint ? { input: { hint: input.hint } } : {}),
          })),
          { name: 'model', description: 'Select a model for this session', input: { hint: 'model ID' } },
          {
            name: 'autopilot',
            description: 'Explicitly enable or disable native autopilot',
            input: { hint: 'on | off' },
          },
          {
            name: 'allow-all',
            description: 'Explicitly enable or disable native permission auto-approval',
            input: { hint: 'on | off' },
          },
        ],
      });
      await session.output;
      return {
        ...(existing ? {} : { sessionId: id }),
        configOptions: configOptions(session, this.models),
        modes: this.modes(session),
      };
    } catch (error) {
      // Creation can allocate native resources before returning an error.
      await this.sdk.rpc('session.destroy', { sessionId: id }).catch(() => {});
      this.sessions.delete(id);
      await this.ownership.release(id);
      throw error;
    }
  }

  modes(session) {
    return { currentModeId: session.mode, availableModes: MODES.map((id) => ({ id, name: id })) };
  }

  async refresh(session) {
    const [model, mode, permission] = await Promise.all([
      this.sdk.rpc('session.model.getCurrent', { sessionId: session.id }),
      this.sdk.rpc('session.mode.get', { sessionId: session.id }),
      this.sdk.rpc('session.permissions.getMode', { sessionId: session.id }),
    ]);
    if (
      !record(model) ||
      (model.modelId !== undefined && typeof model.modelId !== 'string') ||
      (model.contextTier !== undefined && !['default', 'long_context'].includes(model.contextTier)) ||
      (model.reasoningEffort !== undefined && typeof model.reasoningEffort !== 'string') ||
      !MODES.includes(mode) ||
      !['manual', 'assisted', 'allow-all'].includes(permission?.mode)
    ) {
      throw new Error('Unsupported native session state');
    }
    session.model = model;
    session.mode = mode;
    session.permission = permission.mode;
  }

  async switchModel(session, modelId, contextTier, reasoningEffort) {
    const model = this.models.find((entry) => entry.id === modelId);
    if (
      !model ||
      !contextChoices(model).some((choice) => choice.value === contextTier) ||
      (reasoningEffort && !reasoningChoices(model).includes(reasoningEffort))
    ) {
      throw invalid('Unsupported native model configuration');
    }
    const result = await this.sdk.rpc('session.model.switchTo', {
      sessionId: session.id,
      modelId,
      contextTier,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    await this.refresh(session);
    if (
      result.deferred ||
      (result.status && result.status !== 'applied') ||
      session.model.modelId !== modelId ||
      (session.model.contextTier ?? 'default') !== contextTier ||
      (reasoningEffort && session.model.reasoningEffort !== reasoningEffort)
    ) {
      throw new Error('Native SDK did not confirm the requested model/context change');
    }
  }

  async publishConfig(session) {
    const options = configOptions(session, this.models);
    this.update(session, { sessionUpdate: 'config_option_update', configOptions: options });
    this.update(session, { sessionUpdate: 'current_mode_update', currentModeId: session.mode });
    await session.output;
    return { configOptions: options };
  }

  async setSessionConfigOption({ sessionId, configId, value }) {
    const session = this.getSession(sessionId);
    if (session.active || session.configuring) throw invalid('Configuration can only change while the session is idle');
    const option = configOptions(session, this.models).find((entry) => entry.id === configId);
    if (!option || !option.options.some((choice) => choice.value === value))
      throw invalid('Unsupported configuration value');
    session.configuring = true;
    try {
      if (configId === 'mode') {
        await this.sdk.rpc('session.mode.set', { sessionId, mode: value });
        await this.refresh(session);
        if (session.mode !== value) throw new Error('Native mode change was not applied');
        const model = this.models.find((entry) => entry.id === session.model.modelId);
        if (!contextChoices(model).some((choice) => choice.value === (session.model.contextTier ?? 'default'))) {
          await this.switchModel(session, session.model.modelId, 'default');
        }
      } else if (configId === 'allow_all') {
        const mode = value === 'true' ? 'allow-all' : 'manual';
        await this.sdk.rpc('session.permissions.setMode', { sessionId, mode });
        await this.refresh(session);
        if (session.permission !== mode) throw new Error('Native permission change was not applied');
      } else {
        const modelId = configId === 'model' ? value : session.model.modelId;
        const model = this.models.find((entry) => entry.id === modelId);
        const tier =
          configId === 'context_window'
            ? value
            : contextChoices(model).some((choice) => choice.value === session.model.contextTier)
              ? session.model.contextTier
              : 'default';
        const efforts = reasoningChoices(model);
        const effort =
          configId === 'reasoning_effort'
            ? value === 'default'
              ? undefined
              : value
            : efforts.includes(session.model.reasoningEffort)
              ? session.model.reasoningEffort
              : efforts.includes(model.defaultReasoningEffort)
                ? model.defaultReasoningEffort
                : undefined;
        await this.switchModel(session, modelId, tier, effort);
      }
      return await this.publishConfig(session);
    } catch (error) {
      // Even a rejected/timed-out RPC may have mutated native state. Do not continue on assumptions.
      session.fault = error;
      throw error;
    } finally {
      session.configuring = false;
    }
  }

  async setSessionMode({ sessionId, modeId }) {
    await this.setSessionConfigOption({ sessionId, configId: 'mode', value: modeId });
    return {};
  }

  async unstable_setSessionModel({ sessionId, modelId }) {
    await this.setSessionConfigOption({ sessionId, configId: 'model', value: modelId });
    return {};
  }

  async prompt({ sessionId, prompt }) {
    const session = this.getSession(sessionId);
    if (session.active || session.configuring) throw invalid('Session is busy');
    let input = promptInput(prompt);
    const slash = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.prompt.trim());
    if (slash && input.attachments?.length) throw invalid('Slash commands cannot include attachments');
    if (slash && ['model', 'autopilot', 'allow-all'].includes(slash[1])) {
      const name = slash[1];
      const value = (slash[2] ?? '').trim();
      if (name !== 'model' && !['on', 'off'].includes(value)) throw invalid('Specify on or off explicitly');
      await this.setSessionConfigOption({
        sessionId,
        configId: name === 'autopilot' ? 'mode' : name === 'allow-all' ? 'allow_all' : 'model',
        value:
          name === 'autopilot'
            ? value === 'on'
              ? 'autopilot'
              : 'interactive'
            : name === 'allow-all'
              ? String(value === 'on')
              : value,
      });
      return { stopReason: 'end_turn' };
    }
    const controller = new AbortController();
    let settle;
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const active = { controller, settle, expectsIdle: false, settled: false, timer: null };
    session.active = active;
    session.deltas.clear();
    try {
      if (slash) {
        if (!session.commands.some((command) => command.name === slash[1]))
          throw invalid('Unsupported slash command; it was not sent to the model');
        const result = await this.sdk.rpc('session.commands.invoke', {
          sessionId,
          name: slash[1],
          input: slash[2] ?? '',
        });
        if (result.kind === 'agent-prompt') {
          input = { prompt: result.prompt };
          if (result.notice) this.text(session, result.notice);
        } else {
          if (result.kind === 'text') this.text(session, result.text);
          else if (result.kind === 'completed') {
            if (result.message) this.text(session, result.message);
          } else if (result.kind === 'add-timeline-entry') this.text(session, result.entry.text);
          else throw invalid(`Native command requires unsupported host interaction: ${result.kind}`);
          await this.refresh(session);
          await this.publishConfig(session);
          return { stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn' };
        }
      }
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      active.expectsIdle = true;
      await this.sdk.rpc('session.send', { sessionId, ...input });
      if (controller.signal.aborted && !active.settled) await this.abortNative(session);
      const result = await done;
      await session.output;
      if (result.error) throw result.error;
      if (!session.fault && !session.closing && !this.closed) {
        await this.refresh(session);
        await this.publishConfig(session);
      }
      return { stopReason: result.stopReason };
    } catch (error) {
      if (active.expectsIdle) {
        session.fault = error;
        if (!active.settled) await this.sdk.rpc('session.abort', { sessionId }).catch(() => {});
      }
      throw error;
    } finally {
      clearTimeout(active.timer);
      controller.abort();
      if (session.active === active) session.active = null;
    }
  }

  update(session, update) {
    session.output = session.output.then(() => this.connection.sessionUpdate({ sessionId: session.id, update }));
    session.output.catch((error) => {
      session.fault = error;
      this.finish(session, { error });
    });
  }

  text(session, text, thought = false) {
    if (typeof text === 'string' && text)
      this.update(session, {
        sessionUpdate: thought ? 'agent_thought_chunk' : 'agent_message_chunk',
        content: { type: 'text', text },
      });
  }

  event(session, event, replay = false) {
    if (!record(event) || !record(event.data)) return;
    const data = event.data;
    if (!replay && event.type === 'permission.requested' && !data.resolvedByHook) {
      if (!session.permissions.has(data.requestId)) {
        const pending = this.permission(session, data.permissionRequest)
          .then((result) =>
            this.sdk.rpc('session.permissions.handlePendingPermissionRequest', {
              sessionId: session.id,
              requestId: data.requestId,
              result,
            })
          )
          .catch((error) => {
            session.fault = error;
            this.finish(session, { error });
            void this.sdk.rpc('session.abort', { sessionId: session.id }).catch(() => {});
          })
          .finally(() => session.permissions.delete(data.requestId));
        session.permissions.set(data.requestId, pending);
      }
      return;
    }
    if (event.type === 'assistant.message_delta' || event.type === 'assistant.reasoning_delta') {
      if (replay) return;
      const thought = event.type === 'assistant.reasoning_delta';
      session.deltas.add(`${thought}:${data.messageId ?? data.reasoningId ?? ''}`);
      this.text(session, data.deltaContent, thought);
    } else if (event.type === 'assistant.message' || event.type === 'assistant.reasoning') {
      const thought = event.type === 'assistant.reasoning';
      if (replay || !session.deltas.has(`${thought}:${data.messageId ?? data.reasoningId ?? ''}`))
        this.text(session, data.content, thought);
    } else if (replay && event.type === 'user.message') {
      if (typeof data.content === 'string')
        this.update(session, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: data.content } });
    } else if (event.type === 'tool.execution_start') {
      session.tools.set(data.toolCallId, { title: data.toolName, input: data.arguments });
      this.update(session, {
        sessionUpdate: 'tool_call',
        toolCallId: data.toolCallId,
        title: data.toolName ?? 'Tool',
        kind: 'other',
        status: 'in_progress',
        rawInput: data.arguments,
      });
    } else if (event.type === 'tool.execution_complete') {
      const tool = session.tools.get(data.toolCallId);
      const content = toolOutput(data.result);
      if (
        tool?.title === 'task_complete' &&
        typeof tool.input?.summary === 'string' &&
        !content.some((block) => block.content?.text === tool.input.summary)
      )
        content.unshift(textContent(tool.input.summary));
      this.update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: data.toolCallId,
        title: tool?.title ?? data.toolName ?? 'Tool',
        status: data.success === false ? 'failed' : 'completed',
        rawOutput: data.result ?? data.error,
        content: content.length ? content : toolOutput(data.error),
      });
      session.tools.delete(data.toolCallId);
    } else if (event.type === 'tool.execution_partial_result') {
      this.update(session, {
        sessionUpdate: 'tool_call_update',
        toolCallId: data.toolCallId,
        status: 'in_progress',
        content: toolOutput(data.partialOutput ?? data.result),
      });
    } else if (
      event.type === 'session.usage_info' &&
      Number.isFinite(data.tokenLimit) &&
      Number.isFinite(data.currentTokens)
    ) {
      this.update(session, { sessionUpdate: 'usage_update', size: data.tokenLimit, used: data.currentTokens });
    } else if (!replay && !event.agentId && event.type === 'session.error') {
      session.fault = new Error(data.message ?? data.errorType ?? 'Native session failed');
      this.finish(session, { error: session.fault });
    } else if (!replay && !event.agentId && event.type === 'session.idle' && session.active?.expectsIdle) {
      this.finish(session, { stopReason: session.active.controller.signal.aborted ? 'cancelled' : 'end_turn' });
    }
  }

  finish(session, result) {
    const active = session.active;
    if (!active || active.settled) return;
    active.settled = true;
    active.controller.abort();
    clearTimeout(active.timer);
    active.settle(result);
  }

  async permission(session, request) {
    const active = session.active;
    const denied = { kind: 'reject' };
    if (!active || active.controller.signal.aborted || !record(request)) return denied;
    const outcome = await this.clientDecision(session, {
      toolCall: {
        toolCallId: request.toolCallId ?? randomUUID(),
        title: request.kind ?? 'Permission',
        status: 'pending',
        rawInput: request,
        content: [textContent(JSON.stringify(request))],
      },
      options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
      ],
    });
    return !active.controller.signal.aborted && outcome?.outcome === 'selected' && outcome.optionId === 'allow_once'
      ? { kind: 'approve-once', approvedInteractively: true }
      : denied;
  }

  async clientDecision(session, request) {
    const signal = session.active?.controller.signal;
    if (!signal || signal.aborted) return { outcome: 'cancelled' };
    let abort;
    const cancelled = new Promise((resolve) => {
      abort = () => resolve({ outcome: 'cancelled' });
      signal.addEventListener('abort', abort, { once: true });
    });
    try {
      return await Promise.race([
        this.connection
          .requestPermission({ sessionId: session.id, ...request })
          .then((result) => result.outcome)
          .catch(() => ({ outcome: 'cancelled' })),
        cancelled,
      ]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  async nativeRequest(method, params) {
    const session = this.sessions.get(params?.sessionId);
    if (!session) throw new Error('Unknown adapter session');
    if (method === 'permission.request') {
      const decision = await this.permission(session, params.permissionRequest);
      return { result: { kind: decision.kind === 'approve-once' ? 'approved' : 'denied-interactively-by-user' } };
    }
    if (method === 'userInput.request') {
      if (!Array.isArray(params.choices) || !params.choices.length) {
        this.text(session, params.question);
        throw new Error('ACP has no free-text input request; cancel and answer in a new prompt');
      }
      const outcome = await this.clientDecision(session, {
        toolCall: {
          toolCallId: randomUUID(),
          title: 'ask_user',
          status: 'pending',
          content: [textContent(params.question)],
        },
        options: params.choices.map((choice, index) => ({ optionId: String(index), name: choice, kind: 'allow_once' })),
      });
      const answer =
        outcome?.outcome === 'selected'
          ? params.choices.find((_choice, index) => String(index) === outcome.optionId)
          : undefined;
      if (answer === undefined) throw new Error('User input cancelled');
      return { answer, wasFreeform: false };
    }
    throw new Error(`Unsupported native client request: ${method}`);
  }

  async abortNative(session) {
    try {
      await this.sdk.rpc('session.abort', { sessionId: session.id });
    } catch (error) {
      session.fault = error;
      this.finish(session, { error });
    }
  }

  async cancel({ sessionId }) {
    const session = this.sessions.get(sessionId);
    const active = session?.active;
    if (!active || active.settled) return;
    active.controller.abort();
    if (!active.timer)
      active.timer = setTimeout(() => {
        session.fault = new Error('Native cancellation did not finish; reload the session');
        void this.sdk.rpc('session.destroy', { sessionId }).catch(() => {});
        this.finish(session, { stopReason: 'cancelled' });
      }, this.cancelTimeout);
    await this.abortNative(session);
  }

  async unstable_closeSession({ sessionId }) {
    const session = this.sessions.get(sessionId);
    if (!session) throw invalid('Unknown adapter session');
    if (session.configuring || session.loading) throw invalid('Wait for session configuration before closing');
    session.closing = true;
    this.finish(session, { stopReason: 'cancelled' });
    await this.sdk.rpc('session.destroy', { sessionId });
    this.sessions.delete(sessionId);
    await this.ownership.release(sessionId);
    return {};
  }

  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    for (const session of this.sessions.values()) this.finish(session, { stopReason: 'cancelled' });
    this.closing = (async () => {
      await this.sdk.close();
      await Promise.all([...this.sessions.keys()].map((id) => this.ownership.release(id)));
      this.sessions.clear();
    })();
    return this.closing;
  }
}
