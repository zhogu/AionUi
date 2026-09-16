import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { CopilotAdapter } from './adapter.mjs';
import { SessionOwnership } from './ownership.mjs';
import { contextChoices, mcpConfig, promptInput } from './projection.mjs';

const models = [
  { id: 'auto', name: 'Auto' },
  {
    id: 'tiered',
    supportedReasoningEfforts: ['none', 'high'],
    defaultReasoningEffort: 'none',
    billing: { tokenPrices: { maxPromptTokens: 272000, longContext: { maxPromptTokens: 922000 } } },
  },
  { id: 'small', supportedReasoningEfforts: ['low'], defaultReasoningEffort: 'low' },
];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture() {
  type Rpc = (method: string, params: Record<string, string>) => Promise<unknown>;
  const sdk = new EventEmitter() as EventEmitter & {
    rpc: Mock<Rpc>;
    close: Mock<() => Promise<void>>;
    requestHandler: (method: string, params: unknown) => Promise<unknown>;
  };
  const state = {
    model: { modelId: 'tiered', contextTier: 'default', reasoningEffort: 'none' },
    mode: 'interactive',
    permission: 'manual',
  };
  sdk.rpc = vi.fn(async (method: string, params: Record<string, string>) => {
    if (method === 'models.list') return { models };
    if (method === 'session.create' || method === 'session.resume') return { sessionId: params.sessionId };
    if (method === 'session.model.getCurrent') return { ...state.model };
    if (method === 'session.mode.get') return state.mode;
    if (method === 'session.permissions.getMode') return { mode: state.permission };
    if (method === 'session.permissions.setMode') {
      state.permission = params.mode;
      return { success: true };
    }
    if (method === 'session.mode.set') {
      state.mode = params.mode;
      return { status: 'applied' };
    }
    if (method === 'session.commands.list') return { commands: [{ name: 'context', description: 'Context' }] };
    if (method === 'session.commands.invoke') return { kind: 'text', text: 'Native context' };
    if (method === 'session.getMessages') return { events: [] };
    if (method === 'session.model.switchTo') {
      Object.assign(state.model, {
        modelId: params.modelId,
        contextTier: params.contextTier,
        reasoningEffort: params.reasoningEffort ?? state.model.reasoningEffort,
      });
      return { status: 'applied', deferred: false };
    }
    return {};
  });
  sdk.close = vi.fn(async () => {});
  const connection = {
    sessionUpdate: vi.fn<(notification: SessionNotification) => Promise<void>>(async () => {}),
    requestPermission: vi.fn<(request: RequestPermissionRequest) => Promise<RequestPermissionResponse>>(async () => ({
      outcome: { outcome: 'cancelled' },
    })),
  };
  const owner = { acquire: vi.fn(async () => {}), save: vi.fn(async () => {}), release: vi.fn(async () => {}) };
  const agent = new CopilotAdapter(connection, sdk, owner, { cancelTimeout: 20 });
  cleanups.push(() => agent.close());
  await agent.initialize();
  const result = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  const sessionId = result.sessionId;
  const emit = (type: string, data: Record<string, unknown> = {}) =>
    sdk.emit('notification', { method: 'session.event', params: { sessionId, event: { type, data } } });
  return {
    agent,
    sdk,
    state,
    connection,
    owner,
    sessionId,
    emit,
    set: (configId: string, value: string) => agent.setSessionConfigOption({ sessionId, configId, value }),
    prompt: (text = 'OK') => agent.prompt({ sessionId, prompt: [{ type: 'text', text }] }),
  };
}

describe('confirmed context configuration', () => {
  it('rejects malformed tiers before calling the native SDK', async () => {
    const f = await fixture();
    f.sdk.rpc.mockClear();
    await expect(f.set('context_window', 'bogus')).rejects.toThrow('Unsupported configuration');
    expect(f.sdk.rpc).not.toHaveBeenCalled();
  });

  it('publishes a confirmed long tier and clears stale choices on a single-tier model', async () => {
    const f = await fixture();
    const long = await f.set('context_window', 'long_context');
    expect(long.configOptions.find((option) => option.id === 'context_window')?.currentValue).toBe('long_context');
    const small = await f.set('model', 'small');
    expect(small.configOptions.find((option) => option.id === 'context_window')).toMatchObject({
      category: 'context_window',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }],
    });
    expect(f.connection.sessionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ update: { sessionUpdate: 'config_option_update', configOptions: small.configOptions } })
    );
  });

  it('does not accept echoed input when the authoritative state disagrees', async () => {
    const f = await fixture();
    const original = f.sdk.rpc.getMockImplementation()!;
    f.sdk.rpc.mockImplementation(async (method: string, params: Record<string, string>) =>
      method === 'session.model.switchTo' ? { status: 'applied', modelState: { ...params } } : original(method, params)
    );
    f.connection.sessionUpdate.mockClear();
    await expect(f.set('context_window', 'long_context')).rejects.toThrow('did not confirm');
    expect(f.connection.sessionUpdate).not.toHaveBeenCalled();
    await expect(f.prompt()).rejects.toThrow('closed and loaded');
  });

  it('fails closed after a failed readback instead of exposing an unconfirmed selection', async () => {
    const f = await fixture();
    const original = f.sdk.rpc.getMockImplementation()!;
    f.sdk.rpc.mockImplementation(async (method: string, params: Record<string, string>) => {
      if (method === 'session.model.getCurrent') throw new Error('readback failed');
      return original(method, params);
    });
    await expect(f.set('context_window', 'long_context')).rejects.toThrow('readback failed');
    await expect(f.prompt()).rejects.toThrow('closed and loaded');
  });

  it('rejects concurrent config updates and prompts while an update is in flight', async () => {
    const f = await fixture();
    const original = f.sdk.rpc.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    f.sdk.rpc.mockImplementation(async (method: string, params: Record<string, string>) => {
      if (method === 'session.model.switchTo') await gate;
      return original(method, params);
    });
    const changing = f.set('context_window', 'long_context');
    await expect(f.set('mode', 'plan')).rejects.toThrow('idle');
    await expect(f.prompt()).rejects.toThrow('busy');
    release();
    await changing;
  });

  it('rejects deferred switches and keeps the session unusable until reloaded', async () => {
    const f = await fixture();
    f.sdk.rpc.mockResolvedValueOnce({ deferred: true });
    await expect(f.set('context_window', 'long_context')).rejects.toThrow('did not confirm');
  });

  it('derives availability from metadata rather than model IDs or a maximum-only limit', () => {
    expect(
      contextChoices({ id: 'unknown', capabilities: { limits: { max_context_window_tokens: 1050000 } } })
    ).toHaveLength(1);
    expect(contextChoices({ ...models[1], id: 'auto' })).toHaveLength(1);
    expect(contextChoices({ ...models[1], id: 'future-model' })).toHaveLength(2);
  });
});

describe('prompt lifecycle and native tools', () => {
  it('preserves native completion text without duplicating the task_complete summary', async () => {
    const f = await fixture();
    const turn = f.prompt();
    f.emit('tool.execution_start', { toolCallId: 'done', toolName: 'task_complete', arguments: { summary: 'Done' } });
    f.emit('tool.execution_complete', { toolCallId: 'done', success: true, result: { content: 'Done' } });
    f.emit('session.idle');
    await turn;
    const tools = f.connection.sessionUpdate.mock.calls
      .map(([notification]) => notification.update)
      .filter((update) => update.sessionUpdate === 'tool_call_update');
    expect(tools[0].content).toHaveLength(1);
  });

  it('maps multiple-choice ask_user and refuses unsupported freeform questions', async () => {
    const f = await fixture();
    f.connection.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: '1' } });
    const turn = f.prompt();
    expect(
      await f.agent.nativeRequest('userInput.request', {
        sessionId: f.sessionId,
        question: 'Choose',
        choices: ['A', 'B'],
      })
    ).toEqual({ answer: 'B', wasFreeform: false });
    await expect(
      f.agent.nativeRequest('userInput.request', { sessionId: f.sessionId, question: 'Free text' })
    ).rejects.toThrow('free-text');
    await expect(f.agent.nativeRequest('unknown.request', { sessionId: f.sessionId })).rejects.toThrow(
      'Unsupported native'
    );
    f.emit('session.idle');
    await turn;
  });

  it('cancels legacy client callbacks rather than approving after the turn is cancelled', async () => {
    const f = await fixture();
    const turn = f.prompt();
    expect(
      await f.agent.nativeRequest('permission.request', {
        sessionId: f.sessionId,
        permissionRequest: { kind: 'write' },
      })
    ).toEqual({ result: { kind: 'denied-interactively-by-user' } });
    await expect(f.agent.nativeRequest('userInput.request', { sessionId: 'unknown' })).rejects.toThrow(
      'Unknown adapter'
    );
    f.emit('session.idle');
    await turn;
  });

  it('handles the config slash commands without submitting a model turn', async () => {
    const f = await fixture();
    await f.prompt('/autopilot on');
    await f.prompt('/allow-all on');
    expect(f.state).toMatchObject({ mode: 'autopilot', permission: 'allow-all' });
    await expect(f.prompt('/autopilot maybe')).rejects.toThrow('on or off');
    expect(f.sdk.rpc.mock.calls.some(([method]) => method === 'session.send')).toBe(false);
  });

  it('ignores a subagent idle event when waiting for the root turn', async () => {
    const f = await fixture();
    let finished = false;
    const turn = f.prompt().then(() => {
      finished = true;
    });
    f.sdk.emit('notification', {
      method: 'session.event',
      params: { sessionId: f.sessionId, event: { type: 'session.idle', agentId: 'nested', data: {} } },
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    f.emit('session.idle');
    await turn;
  });

  it('closes an active session without racing an authoritative refresh against destroy', async () => {
    const f = await fixture();
    const turn = f.prompt();
    await f.agent.unstable_closeSession({ sessionId: f.sessionId });
    expect(await turn).toEqual({ stopReason: 'cancelled' });
    await expect(f.prompt()).rejects.toThrow('unavailable');
  });

  it('fails active turns and releases resources after a native transport failure', async () => {
    const f = await fixture();
    const turn = f.prompt();
    f.sdk.emit('failure', new Error('native exited'));
    await expect(turn).rejects.toThrow('native exited');
    await f.agent.close();
    expect(f.owner.release).toHaveBeenCalledWith(f.sessionId);
  });

  it('waits for idle, forwards deltas once, and preserves task_complete summaries', async () => {
    const f = await fixture();
    let complete = false;
    const turn = f.prompt().then((result) => {
      complete = true;
      return result;
    });
    await vi.waitFor(() => expect(f.sdk.rpc).toHaveBeenCalledWith('session.send', expect.anything()));
    f.emit('assistant.message_delta', { messageId: 'm', deltaContent: 'OK' });
    f.emit('assistant.message', { messageId: 'm', content: 'OK' });
    f.emit('tool.execution_start', { toolCallId: 't', toolName: 'task_complete', arguments: { summary: '# Done' } });
    f.emit('tool.execution_complete', { toolCallId: 't', success: true, result: { content: 'Finished' } });
    await Promise.resolve();
    expect(complete).toBe(false);
    f.emit('session.idle');
    await turn;
    const updates = f.connection.sessionUpdate.mock.calls.map(([notification]) => notification.update);
    expect(updates.filter((update) => update.sessionUpdate === 'agent_message_chunk')).toHaveLength(1);
    expect(updates.find((update) => update.sessionUpdate === 'tool_call_update')).toMatchObject({
      title: 'task_complete',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: '# Done' } },
        { type: 'content', content: { type: 'text', text: 'Finished' } },
      ],
    });
  });

  it('rejects configuration and overlapping prompts while the native turn is active', async () => {
    const f = await fixture();
    const turn = f.prompt();
    await expect(f.set('context_window', 'long_context')).rejects.toThrow('idle');
    await expect(f.prompt()).rejects.toThrow('busy');
    f.emit('session.idle');
    await turn;
  });

  it('routes slash commands through the SDK and never submits unknown slash text', async () => {
    const f = await fixture();
    await f.prompt('/context');
    await expect(f.prompt('/unknown-command')).rejects.toThrow('not sent to the model');
    expect(f.sdk.rpc.mock.calls.some(([method]) => method === 'session.send')).toBe(false);
  });

  it('returns prompt failure when the native session fails', async () => {
    const f = await fixture();
    const turn = f.prompt();
    f.emit('session.error', { message: 'model unavailable' });
    await expect(turn).rejects.toThrow('model unavailable');
  });

  it('denies pending permissions on cancellation even if the client responds late', async () => {
    const f = await fixture();
    let approve!: (value: RequestPermissionResponse) => void;
    f.connection.requestPermission.mockImplementation(
      () =>
        new Promise((resolvePermission) => {
          approve = resolvePermission;
        })
    );
    const turn = f.prompt();
    f.emit('permission.requested', { requestId: 'p', permissionRequest: { kind: 'shell', toolCallId: 't' } });
    await f.agent.cancel({ sessionId: f.sessionId });
    approve({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    f.emit('session.idle');
    expect(await turn).toMatchObject({ stopReason: 'cancelled' });
    await vi.waitFor(() =>
      expect(f.sdk.rpc).toHaveBeenCalledWith(
        'session.permissions.handlePendingPermissionRequest',
        expect.objectContaining({ result: { kind: 'reject' } })
      )
    );
  });

  it('does not silently approve permissions when the ACP client fails', async () => {
    const f = await fixture();
    f.connection.requestPermission.mockRejectedValue(new Error('client gone'));
    const turn = f.prompt();
    f.emit('permission.requested', { requestId: 'p', permissionRequest: { kind: 'write' } });
    await vi.waitFor(() =>
      expect(f.sdk.rpc).toHaveBeenCalledWith(
        'session.permissions.handlePendingPermissionRequest',
        expect.objectContaining({ result: { kind: 'reject' } })
      )
    );
    f.emit('session.idle');
    await turn;
  });

  it('terminates cancellation without idle and prevents reuse of a still-running session', async () => {
    const f = await fixture();
    const turn = f.prompt();
    await f.agent.cancel({ sessionId: f.sessionId });
    expect(await turn).toMatchObject({ stopReason: 'cancelled' });
    expect(f.sdk.rpc).toHaveBeenCalledWith('session.destroy', { sessionId: f.sessionId });
    await expect(f.prompt()).rejects.toThrow('closed and loaded');
  });

  it('forwards explicit approvals, but enabling autopilot is not enabling allow-all', async () => {
    const f = await fixture();
    await f.set('mode', 'autopilot');
    expect(f.state.permission).toBe('manual');
    f.connection.requestPermission.mockResolvedValue({ outcome: { outcome: 'selected', optionId: 'allow_once' } });
    const turn = f.prompt();
    f.emit('permission.requested', { requestId: 'p', permissionRequest: { kind: 'shell' } });
    await vi.waitFor(() =>
      expect(f.sdk.rpc).toHaveBeenCalledWith(
        'session.permissions.handlePendingPermissionRequest',
        expect.objectContaining({ result: { kind: 'approve-once', approvedInteractively: true } })
      )
    );
    f.emit('session.idle');
    await turn;
  });

  it('fails unsupported attachments rather than dropping them', () => {
    expect(() => promptInput([{ type: 'image', data: 'a' }])).toThrow('Unsupported prompt content');
    expect(
      promptInput([
        { type: 'resource', resource: { uri: 'notes:test', text: 'notes' } },
        { type: 'resource_link', uri: 'file:///workspace/a%20b.txt', name: 'a b' },
      ])
    ).toMatchObject({ attachments: [{ type: 'file', path: '/workspace/a b.txt' }] });
    expect(() => mcpConfig([{ name: 'a', type: 'udp' }])).toThrow('Unsupported MCP');
  });

  it('forwards native MCP transport details without replacing native tools', () => {
    expect(
      mcpConfig([
        { name: 'local', command: 'example-mcp', args: [], env: [{ name: 'X', value: '1' }] },
        { name: 'remote', type: 'http', url: 'https://example.invalid', headers: [] },
      ])
    ).toMatchObject({ local: { command: 'example-mcp', tools: ['*'], env: { X: '1' } }, remote: { type: 'http' } });
  });
});

describe('adapter-owned session loading', () => {
  it('selects a metadata-backed default for a session with no initialized native model', async () => {
    const f = await fixture();
    f.state.model.modelId = '';
    const session = await f.agent.newSession({ cwd: process.cwd(), mcpServers: [] });
    expect(session.configOptions.find((option) => option.id === 'model')?.currentValue).toBe('auto');
  });

  it('releases ownership after startup fails instead of leaving an unusable lease', async () => {
    const f = await fixture();
    f.state.model.modelId = '';
    f.agent.preferredModel = 'missing';
    await expect(f.agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow('startup model');
    expect(f.owner.release).toHaveBeenCalled();
  });

  it('refuses corrupted persisted context state without sending it back to the SDK', async () => {
    const f = await fixture();
    f.state.model.contextTier = 'corrupt';
    const before = f.sdk.rpc.mock.calls.length;
    await expect(f.agent.newSession({ cwd: process.cwd(), mcpServers: [] })).rejects.toThrow(
      'Unsupported native session state'
    );
    expect(f.sdk.rpc.mock.calls.slice(before).some(([method]) => method === 'session.model.switchTo')).toBe(false);
  });

  it('refuses unknown sessions and prevents simultaneous adapter leases', async () => {
    const directory = resolve(`.copilot-acp-test-${randomUUID()}`);
    await mkdir(directory);
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const first = new SessionOwnership(directory);
    const second = new SessionOwnership(directory);
    const id = randomUUID();
    await expect(second.acquire(id, process.cwd(), true)).rejects.toThrow();
    await first.acquire(id, process.cwd());
    await first.save(id, process.cwd());
    await expect(second.acquire(id, process.cwd(), true)).rejects.toThrow('already leased');
    await first.release(id);
    await second.acquire(id, process.cwd(), true);
    await second.release(id);
  });

  it('replays history only after ownership authorization and restores manual interactive mode', async () => {
    const f = await fixture();
    await f.agent.unstable_closeSession({ sessionId: f.sessionId });
    f.state.mode = 'autopilot';
    f.state.permission = 'allow-all';
    const result = await f.agent.loadSession({ sessionId: f.sessionId, cwd: process.cwd(), mcpServers: [] });
    expect(f.owner.acquire).toHaveBeenLastCalledWith(f.sessionId, process.cwd(), true);
    expect(result.modes.currentModeId).toBe('interactive');
    expect(f.state.permission).toBe('manual');
  });
});
