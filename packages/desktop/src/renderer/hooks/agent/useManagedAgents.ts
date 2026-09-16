/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { MANAGED_AGENTS_SWR_KEY, fetchManagedAgents } from '@/renderer/utils/model/agentTypes';
import useSWR, { mutate } from 'swr';
import { ensureConversationRuntime } from '@/renderer/pages/conversation/utils/ensureConversationRuntime';
import { useEffect } from 'react';

export type UseManagedAgentsResult = {
  agents: ManagedAgent[];
  isLoading: boolean;
  isRefreshing: boolean;
  error: unknown;
  revalidate: () => Promise<ManagedAgent[] | undefined>;
  refreshCatalog: () => Promise<ManagedAgent[] | undefined>;
  refreshCustomAgents: () => Promise<void>;
};

export async function refreshManagedAgentCatalogAndAssistants(): Promise<ManagedAgent[] | undefined> {
  const [agents] = await Promise.all([mutate<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY), mutate('assistants.list')]);
  return agents;
}

/** Refresh custom ACP capabilities without sending a prompt or retaining a conversation. */
export async function refreshCustomAgentRuntimeCatalog(agent: ManagedAgent): Promise<void> {
  if (agent.agent_source !== 'custom' || agent.agent_type !== 'acp' || !agent.enabled || agent.status !== 'online')
    return;
  // AionCore 0.2.2 probes health but only persists catalogs on the runtime/session path.
  // A runtime-only probe must not bind an assistant or update its saved preferences.
  const probe = await ipcBridge.conversation.create.invoke({
    type: 'acp',
    name: agent.name,
    extra: { agent_id: agent.id, agent_source: 'custom', is_health_check: true },
  });
  if (!probe?.id) throw new Error('agent_catalog: probe_conversation_missing');
  try {
    await ensureConversationRuntime(probe.id);
  } finally {
    await ipcBridge.conversation.remove.invoke({ id: probe.id }).then((removed) => {
      if (!removed) throw new Error(`agent_catalog: probe_cleanup_failed (${probe.id})`);
    });
  }
}

export async function checkAndRefreshCustomAgentRuntimeCatalog(agentId: string): Promise<ManagedAgent> {
  const agent = await ipcBridge.acpConversation.checkManagedAgentHealthById.invoke({ id: agentId });
  if (agent.status !== 'online') {
    throw new Error(agent.last_check_error_message || `agent_catalog: agent_not_online (${agent.id})`);
  }
  await refreshCustomAgentRuntimeCatalog(agent);
  return agent;
}

function isBundledCopilotAdapter(agent: ManagedAgent): boolean {
  return (
    agent.agent_source === 'custom' &&
    agent.agent_type === 'acp' &&
    /(^|[/\\])copilot-acp(?:\.exe)?$/i.test(agent.command?.trim() ?? '')
  );
}

function hasModelCapabilityMetadata(agent: ManagedAgent): boolean {
  const options = Array.isArray(agent.config_options) ? agent.config_options : [];
  const model = options.find((option) => {
    if (!option || typeof option !== 'object') return false;
    const candidate = option as Record<string, unknown>;
    return candidate.id === 'model' || candidate.category === 'model';
  }) as Record<string, unknown> | undefined;
  const choices = Array.isArray(model?.options) ? model.options : [];
  return choices.some((choice) => {
    if (!choice || typeof choice !== 'object') return false;
    const meta = (choice as Record<string, unknown>)._meta;
    return (
      !!meta && typeof meta === 'object' && Array.isArray((meta as Record<string, unknown>)['aionui/model-config'])
    );
  });
}

const automaticCatalogRefreshes = new Set<string>();

/**
 * Hook for the Agent settings management surface only. Reads the dedicated
 * `/api/agents/management` diagnostics view (`MANAGED_AGENTS_SWR_KEY`) so
 * user-disabled or missing agents stay listed with working test-connection
 * and re-enable actions.
 *
 * `revalidate` refreshes only the management key. It is the right action for
 * diagnostics-only changes such as health checks that should not invalidate the
 * shared detected-agent catalog.
 *
 * `refreshCatalog` refreshes the management catalog plus assistant list caches
 * after structural or health changes that can affect generated generated assistants.
 * Business assistant pickers must not depend on this hook or on `/api/agents`.
 *
 * Do not use this anywhere other than `AgentSettings`.
 */
export const useManagedAgents = (): UseManagedAgentsResult => {
  const { data, isLoading, isValidating, error } = useSWR<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY, fetchManagedAgents);

  const revalidateManaged = () => mutate<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY);

  return {
    agents: data ?? [],
    isLoading,
    isRefreshing: isValidating && !isLoading,
    error,
    revalidate: revalidateManaged,
    refreshCatalog: refreshManagedAgentCatalogAndAssistants,
    refreshCustomAgents: async () => {
      await ipcBridge.acpConversation.refreshCustomAgents.invoke();
      await refreshManagedAgentCatalogAndAssistants();
    },
  };
};

/**
 * Lightweight runtime catalog read model for assistant-bound agent rows.
 * Uses the same `/api/agents/management` payload because that endpoint is
 * backed by `agent_metadata`, where ACP catalog snapshots are persisted.
 */
export const useManagedAgentRuntimeCatalog = (): ManagedAgent[] => {
  const { data } = useSWR<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY, fetchManagedAgents);
  useEffect(() => {
    for (const agent of data ?? []) {
      if (
        !isBundledCopilotAdapter(agent) ||
        hasModelCapabilityMetadata(agent) ||
        automaticCatalogRefreshes.has(agent.id)
      ) {
        continue;
      }
      automaticCatalogRefreshes.add(agent.id);
      void checkAndRefreshCustomAgentRuntimeCatalog(agent.id)
        .then(() => refreshManagedAgentCatalogAndAssistants())
        .catch((error) => {
          console.error(`[agent_catalog] Automatic Copilot adapter refresh failed (${agent.id}):`, error);
        });
    }
  }, [data]);
  return data ?? [];
};

/**
 * Non-hook entry point for settings/tooling surfaces that need the management
 * diagnostics catalog rather than the business-facing detected agent list.
 * Writes the result into the shared management cache only. Callers that
 * actually mutate the agent directory should invalidate the detected-agent
 * cache separately.
 */
export async function getManagedAgents(): Promise<ManagedAgent[]> {
  const data = await fetchManagedAgents();
  await mutate(MANAGED_AGENTS_SWR_KEY, data, { revalidate: false });
  return data;
}
