/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for renderer/hooks/agent/useManagedAgents.ts.
 *
 * The Agent settings management surface must read the
 * `include_disabled=true` view (a SEPARATE SWR key from any detected-agent
 * cache). Diagnostics-only actions can refresh the management cache only;
 * catalog-changing or health actions that affect generated assistants must also
 * invalidate assistant list caches.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let swrData: ManagedAgent[] = [];

vi.mock('swr', () => ({
  default: vi.fn(() => ({ data: swrData, error: null, isLoading: false })),
  mutate: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      create: { invoke: vi.fn() },
      ensureRuntime: { invoke: vi.fn() },
      remove: { invoke: vi.fn() },
    },
    acpConversation: {
      refreshCustomAgents: { invoke: vi.fn().mockResolvedValue(undefined) },
      checkManagedAgentHealthById: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/renderer/utils/model/agentTypes', () => ({
  MANAGED_AGENTS_SWR_KEY: 'agents.managed',
  fetchManagedAgents: vi.fn(),
}));

import {
  getManagedAgents,
  useManagedAgents,
  useManagedAgentRuntimeCatalog,
  refreshCustomAgentRuntimeCatalog,
  checkAndRefreshCustomAgentRuntimeCatalog,
} from '@/renderer/hooks/agent/useManagedAgents';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { ipcBridge } from '@/common';
import useSWR, { mutate } from 'swr';
import { fetchManagedAgents } from '@/renderer/utils/model/agentTypes';

describe('useManagedAgents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    swrData = [];
    (useSWR as any).mockImplementation(() => ({ data: swrData, error: null, isLoading: false }));
    vi.mocked(ipcBridge.conversation.create.invoke).mockResolvedValue({ id: 'probe' } as Awaited<
      ReturnType<typeof ipcBridge.conversation.create.invoke>
    >);
    vi.mocked(ipcBridge.conversation.ensureRuntime.invoke)
      .mockReset()
      .mockResolvedValue({} as Awaited<ReturnType<typeof ipcBridge.conversation.ensureRuntime.invoke>>);
    vi.mocked(ipcBridge.conversation.remove.invoke).mockReset().mockResolvedValue(true);
  });

  const customAgent: ManagedAgent = {
    id: 'adapter',
    name: 'Adapter',
    agent_type: 'acp',
    agent_source: 'custom',
    enabled: true,
    available: true,
    status: 'online',
  };

  it('refreshes custom model catalogs with an empty disposable runtime, never a prompt', async () => {
    await refreshCustomAgentRuntimeCatalog(customAgent);
    expect(ipcBridge.conversation.create.invoke).toHaveBeenCalledWith({
      type: 'acp',
      name: 'Adapter',
      extra: { agent_id: 'adapter', agent_source: 'custom', is_health_check: true },
    });
    expect(ipcBridge.conversation.ensureRuntime.invoke).toHaveBeenCalledWith({ conversation_id: 'probe' });
    expect(ipcBridge.conversation.remove.invoke).toHaveBeenCalledWith({ id: 'probe' });
  });

  it('cleans the disposable conversation even when runtime initialization fails', async () => {
    vi.mocked(ipcBridge.conversation.ensureRuntime.invoke).mockRejectedValueOnce(new Error('ACP unavailable'));
    await expect(refreshCustomAgentRuntimeCatalog(customAgent)).rejects.toThrow('ACP unavailable');
    expect(ipcBridge.conversation.remove.invoke).toHaveBeenCalledWith({ id: 'probe' });
  });

  it('reports cleanup failure rather than a successful connection refresh', async () => {
    vi.mocked(ipcBridge.conversation.remove.invoke).mockResolvedValueOnce(false);
    await expect(refreshCustomAgentRuntimeCatalog(customAgent)).rejects.toThrow('probe_cleanup_failed');
  });

  it('does not open runtimes for disabled, offline or builtin agents', async () => {
    for (const override of [{ enabled: false }, { status: 'offline' as const }, { agent_source: 'builtin' as const }]) {
      await refreshCustomAgentRuntimeCatalog({ ...customAgent, ...override });
    }
    expect(ipcBridge.conversation.create.invoke).not.toHaveBeenCalled();
  });

  it('checks a saved custom agent before persisting its runtime catalog', async () => {
    vi.mocked(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).mockResolvedValue(customAgent);

    await expect(checkAndRefreshCustomAgentRuntimeCatalog(customAgent.id)).resolves.toEqual(customAgent);

    expect(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).toHaveBeenCalledWith({
      id: customAgent.id,
    });
    expect(ipcBridge.conversation.ensureRuntime.invoke).toHaveBeenCalledWith({ conversation_id: 'probe' });
  });

  it('does not create a catalog runtime when the saved custom agent is offline', async () => {
    vi.mocked(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).mockResolvedValue({
      ...customAgent,
      status: 'offline',
      last_check_error_message: 'sign in required',
    });

    await expect(checkAndRefreshCustomAgentRuntimeCatalog(customAgent.id)).rejects.toThrow('sign in required');

    expect(ipcBridge.conversation.create.invoke).not.toHaveBeenCalled();
  });

  it('subscribes to the management SWR key with the managed fetcher', () => {
    (useSWR as any).mockReturnValue({ data: [], error: null, isLoading: false });

    renderHook(() => useManagedAgents());

    expect(useSWR).toHaveBeenCalledWith('agents.managed', fetchManagedAgents);
  });

  it('exposes the agents returned by SWR', () => {
    const agents = [
      { id: 'x', name: 'X', agent_type: 'acp', agent_source: 'custom', enabled: false, available: false },
    ];
    (useSWR as any).mockReturnValue({ data: agents, error: null, isLoading: false });

    const { result } = renderHook(() => useManagedAgents());

    expect(result.current.agents).toEqual(agents);
  });

  it('automatically refreshes stale bundled Copilot adapter metadata once', async () => {
    const staleAdapter = {
      ...customAgent,
      id: 'stale-bundled-adapter',
      command: '/home/test/.local/share/aionui-web/copilot-acp',
      config_options: [
        {
          id: 'model',
          category: 'model',
          options: [{ value: 'gpt-6-astra', name: 'GPT-6 Astra' }],
        },
      ],
    };
    swrData = [staleAdapter];
    vi.mocked(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).mockResolvedValue(staleAdapter);

    renderHook(() => useManagedAgentRuntimeCatalog());

    await act(async () => {
      await vi.waitFor(() => {
        expect(ipcBridge.acpConversation.checkManagedAgentHealthById.invoke).toHaveBeenCalledWith({
          id: staleAdapter.id,
        });
        expect(mutate).toHaveBeenCalledWith('agents.managed');
        expect(mutate).toHaveBeenCalledWith('assistants.list');
      });
    });
  });

  it('falls back to an empty list when SWR has no data yet', () => {
    (useSWR as any).mockReturnValue({ data: undefined, error: null, isLoading: true });

    const { result } = renderHook(() => useManagedAgents());

    expect(result.current.agents).toEqual([]);
  });

  it('revalidate refreshes only the management key', async () => {
    (useSWR as any).mockReturnValue({ data: [], error: null, isLoading: false });

    const { result } = renderHook(() => useManagedAgents());

    await act(async () => {
      await result.current.revalidate();
    });

    expect(mutate).toHaveBeenCalledWith('agents.managed');
    expect(mutate).not.toHaveBeenCalledWith('agents.detected');
  });

  it('refreshCatalog refreshes the management key and assistant list caches', async () => {
    (useSWR as any).mockReturnValue({ data: [], error: null, isLoading: false });

    const { result } = renderHook(() => useManagedAgents());

    await act(async () => {
      await result.current.refreshCatalog();
    });

    expect(mutate).toHaveBeenCalledWith('agents.managed');
    expect(mutate).toHaveBeenCalledWith('assistants.list');
  });

  it('refreshCustomAgents triggers a backend rescan then refreshes management and assistant caches', async () => {
    (useSWR as any).mockReturnValue({ data: [], error: null, isLoading: false });

    const { result } = renderHook(() => useManagedAgents());

    await act(async () => {
      await result.current.refreshCustomAgents();
    });

    expect(ipcBridge.acpConversation.refreshCustomAgents.invoke).toHaveBeenCalled();
    expect(mutate).toHaveBeenCalledWith('agents.managed');
    expect(mutate).toHaveBeenCalledWith('assistants.list');
  });

  it('getManagedAgents fetches the management catalog without invalidating the detected cache', async () => {
    const managedAgents = [
      { id: 'managed-1', name: 'Managed Agent', agent_type: 'acp', agent_source: 'builtin', enabled: true },
    ];
    (fetchManagedAgents as any).mockResolvedValue(managedAgents);

    const result = await getManagedAgents();

    expect(fetchManagedAgents).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith('agents.managed', managedAgents, { revalidate: false });
    expect(mutate).not.toHaveBeenCalledWith('agents.detected');
    expect(result).toEqual(managedAgents);
  });
});
