import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';
import { CopilotAdapter } from './adapter.mjs';
import { SessionOwnership } from './ownership.mjs';
import { contextChoices } from './projection.mjs';
import { SdkTransport } from './transport.mjs';
import {
  buildAgentRuntimeContextWindowOption,
  buildAgentRuntimeThoughtLevelOption,
} from '../desktop/src/renderer/utils/model/agentRuntimeCatalog';

const enabled = process.env.COPILOT_ACP_NATIVE_TEST === '1';
const cwd = process.env.COPILOT_ACP_NATIVE_CWD;
const executable = process.env.AIONUI_COPILOT_CLI || 'copilot';

describe.skipIf(!enabled)('opt-in native Copilot smoke (new isolated sessions only)', () => {
  it('proves effective default → long → default budgets, native tool permissions and owned resume', async () => {
    if (!cwd || !resolve(cwd).startsWith('/') || cwd === process.cwd())
      throw new Error('Set COPILOT_ACP_NATIVE_CWD to a neutral, non-repository directory');
    const directory = resolve(`.copilot-acp-native-${randomUUID()}`);
    const sdk = new SdkTransport({ executable, args: ['--disable-builtin-mcps'] });
    const usage: Array<{ maxPromptTokens?: number }> = [];
    const updates: Array<Record<string, unknown>> = [];
    let permissions = 0;
    sdk.on('notification', (notification) => {
      if (notification.method === 'session.event' && notification.params?.event?.type === 'assistant.usage') {
        usage.push({ maxPromptTokens: notification.params.event.data.maxPromptTokens });
      }
    });
    const agent = new CopilotAdapter(
      {
        sessionUpdate: async ({ update }: { update: Record<string, unknown> }) => {
          updates.push(update);
        },
        requestPermission: async ({
          toolCall,
        }: {
          toolCall: { rawInput?: { kind?: string; fullCommandText?: string } };
        }) => {
          permissions++;
          // The smoke authorizes only its own harmless shell printf; all other permissions are denied.
          const request = toolCall.rawInput;
          const allowed =
            request?.kind === 'shell' &&
            typeof request.fullCommandText === 'string' &&
            /^printf\s+['"]?ACP_NATIVE_TOOL_OK(?:\\n)?['"]?\s*$/.test(request.fullCommandText);
          return { outcome: { outcome: 'selected', optionId: allowed ? 'allow_once' : 'reject_once' } };
        },
      },
      sdk,
      new SessionOwnership(directory)
    );
    try {
      await agent.initialize();
      const model =
        agent.models.find((entry) => entry.id === process.env.COPILOT_ACP_NATIVE_MODEL) ??
        agent.models.find(
          (entry) => contextChoices(entry).length === 2 && entry.supportedReasoningEfforts?.includes('none')
        );
      const single = agent.models.find((entry) => entry.id !== 'auto' && contextChoices(entry).length === 1);
      if (!model || !single) throw new Error('Native test requires enabled tiered and single-tier model metadata');
      const session = await agent.newSession({ cwd, mcpServers: [] });
      const sessionId = session.sessionId;
      const set = (configId: string, value: string) => agent.setSessionConfigOption({ sessionId, configId, value });
      expect(await agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/allow-all' }] })).toEqual({
        stopReason: 'end_turn',
      });
      expect(await sdk.rpc('session.permissions.getMode', { sessionId })).toEqual({ mode: 'allow-all' });
      await agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/allow-all off' }] });
      expect(await sdk.rpc('session.permissions.getMode', { sessionId })).toEqual({ mode: 'manual' });
      console.log(JSON.stringify({ proof: 'native-allow-all-command', enabledWithoutArgument: true }));
      await set('model', model.id);
      if (model.supportedReasoningEfforts?.includes('none')) await set('reasoning_effort', 'none');
      expect(await agent.prompt({ sessionId, prompt: [{ type: 'text', text: '/context' }] })).toEqual({
        stopReason: 'end_turn',
      });
      const budgets: number[] = [];
      for (const tier of ['default', 'long_context', 'default']) {
        await set('context_window', tier);
        const before = usage.length;
        expect(
          await agent.prompt({
            sessionId,
            prompt: [{ type: 'text', text: 'Reply only OK. Do not use tools or read files.' }],
          })
        ).toEqual({ stopReason: 'end_turn' });
        const actual = usage.slice(before).find((event) => typeof event.maxPromptTokens === 'number')?.maxPromptTokens;
        if (actual === undefined) throw new Error('No native assistant.usage maxPromptTokens evidence received');
        budgets.push(actual);
      }
      const prices = model.billing.tokenPrices;
      expect(budgets).toEqual([
        prices.maxPromptTokens ?? prices.contextMax,
        prices.longContext.maxPromptTokens ?? prices.longContext.contextMax,
        prices.maxPromptTokens ?? prices.contextMax,
      ]);
      console.log(
        JSON.stringify({
          proof: 'native-effective-context',
          model: model.id,
          tiers: ['default', 'long_context', 'default'],
          maxPromptTokens: budgets,
        })
      );
      const nativeName = await sdk.rpc('session.name.get', { sessionId });
      expect(nativeName.name).toBeTruthy();
      expect(updates.filter((update) => update.sessionUpdate === 'session_info_update').at(-1)).toMatchObject({
        title: nativeName.name,
      });
      const nativeTitle = 'Native session title sync';
      await sdk.rpc('session.name.set', { sessionId, name: nativeTitle });
      await vi.waitFor(() =>
        expect(updates.filter((update) => update.sessionUpdate === 'session_info_update').at(-1)).toMatchObject({
          title: nativeTitle,
        })
      );
      console.log(JSON.stringify({ proof: 'native-session-name-sync', generated: true, renamed: nativeTitle }));
      const small = await set('model', single.id);
      expect(small.configOptions.find((option) => option.id === 'context_window')).toMatchObject({
        currentValue: 'default',
        options: contextChoices(single),
      });
      await expect(set('context_window', 'long_context')).rejects.toThrow('Unsupported configuration');
      console.log(JSON.stringify({ proof: 'native-single-tier-clearing', model: single.id, optionCount: 1 }));
      await set('model', model.id);
      await agent.prompt({
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the bash tool exactly once to run exactly: printf ACP_NATIVE_TOOL_OK. Do not read files or run any other command. Then reply OK.',
          },
        ],
      });
      expect(
        updates.some(
          (update) =>
            update.sessionUpdate === 'tool_call_update' &&
            JSON.stringify(update).includes('ACP_NATIVE_TOOL_OK') &&
            update.status === 'completed'
        )
      ).toBe(true);
      expect(permissions).toBeGreaterThan(0);
      console.log(JSON.stringify({ proof: 'native-shell-permission-and-result', permissions }));
      const beforeDenial = updates.length;
      await agent.prompt({
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Use the bash tool exactly once to run exactly: printf ACP_NATIVE_DENIED. If permission is denied, do not retry or run any other command. Do not read files. Then reply OK.',
          },
        ],
      });
      const deniedTools = updates.slice(beforeDenial).filter((update) => update.sessionUpdate === 'tool_call_update');
      expect(deniedTools.some((update) => update.status === 'failed')).toBe(true);
      expect(JSON.stringify(deniedTools)).not.toMatch(/malformed payload|unexpected user permission response/);
      console.log(JSON.stringify({ proof: 'native-permission-rejection' }));
      await set('mode', 'autopilot');
      const beforeCompletion = updates.length;
      await agent.prompt({
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'Do not read files or execute commands. The entire task is to report OK using task_complete with summary "ACP_NATIVE_COMPLETION_OK". Do it now.',
          },
        ],
      });
      expect(
        updates
          .slice(beforeCompletion)
          .some(
            (update) =>
              update.sessionUpdate === 'tool_call_update' &&
              update.title === 'task_complete' &&
              update.status === 'completed' &&
              JSON.stringify(update.content).includes('ACP_NATIVE_COMPLETION_OK')
          )
      ).toBe(true);
      console.log(JSON.stringify({ proof: 'native-autopilot-task-complete-content' }));
      await agent.unstable_closeSession({ sessionId });
      const beforeReplay = updates.length;
      await agent.loadSession({ sessionId, cwd, mcpServers: [] });
      expect(updates.slice(beforeReplay).some((update) => update.sessionUpdate === 'agent_message_chunk')).toBe(true);
      expect(
        updates
          .slice(beforeReplay)
          .filter((update) => update.sessionUpdate === 'session_info_update')
          .at(-1)
      ).toMatchObject({ title: nativeTitle });
      await expect(agent.loadSession({ sessionId: randomUUID(), cwd, mcpServers: [] })).rejects.toThrow();
      console.log(JSON.stringify({ proof: 'owned-session-replay-and-foreign-load-rejection' }));
    } finally {
      await agent.close();
      await rm(directory, { recursive: true, force: true });
    }
  }, 240000);

  it('speaks ACP over the executable stdio boundary and exits on EOF', async () => {
    if (!cwd) throw new Error('Set COPILOT_ACP_NATIVE_CWD');
    const directory = resolve(`.copilot-acp-native-${randomUUID()}`);
    const child = spawn(resolve('packages/copilot-acp/index.mjs'), ['--acp'], {
      env: { ...process.env, AIONUI_COPILOT_CLI: executable, AIONUI_COPILOT_ACP_STATE_DIR: directory },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    const client = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>)
    );
    try {
      const initialized = await client.initialize({ protocolVersion: 1, clientCapabilities: {} });
      expect(initialized.agentInfo?.name).toBe('aionui-copilot-sdk-acp');
      const session = await client.newSession({ cwd, mcpServers: [] });
      expect(session.configOptions?.find((option) => option.id === 'context_window')?.category).toBe('context_window');
      const catalog = { config_options: session.configOptions };
      const modelChoices = session.configOptions?.find((option) => option.id === 'model');
      if (!modelChoices || !('options' in modelChoices)) throw new Error('Missing native model choices');
      const selectedModel = modelChoices.options.find(
        (option) => 'value' in option && buildAgentRuntimeContextWindowOption(catalog, option.value)
      );
      if (!selectedModel || !('value' in selectedModel)) throw new Error('Missing tiered model metadata');
      const context = buildAgentRuntimeContextWindowOption(catalog, selectedModel.value);
      const thought = buildAgentRuntimeThoughtLevelOption(catalog, selectedModel.value);
      expect(context?.options.map((option) => option.value)).toEqual(['default', 'long_context']);
      expect(thought?.options.length).toBeGreaterThan(1);
      expect(context?.options[0].label).toMatch(/^Default \([\d.]+[KM]\)$/);
      expect(context?.options[1].label).toMatch(/^Long context \([\d.]+[KM]\)$/);
      expect(context?.options[0].description).toMatch(/^[\d,]+ input tokens$/);
      expect(context?.options[1].description).toMatch(/^[\d,]+ input tokens$/);
      await client.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'model',
        value: selectedModel.value,
      });
      const effort =
        thought?.options.find((option) => option.value === 'high') ??
        thought?.options.find((option) => option.value !== 'default');
      if (!effort) throw new Error('Missing reasoning choices');
      const changed = await client.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'reasoning_effort',
        value: effort.value,
      });
      expect(changed.configOptions.find((option) => option.id === 'reasoning_effort')?.currentValue).toBe(effort.value);
      console.log(
        JSON.stringify({
          proof: 'homepage-model-metadata-and-reasoning',
          model: selectedModel.value,
          effort: effort.value,
        })
      );
      await client.unstable_closeSession({ sessionId: session.sessionId });
      child.stdin.end();
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Adapter did not exit on EOF')), 5000).unref()
      );
      await Promise.race([exited, timeout]);
      expect(child.exitCode).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
});
