/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { TChatConversation } from '@/common/config/storage';
import { mutate } from 'swr';

/** Reconcile snapshots after a transport gap or a suspended browser tab. Never replay prompts. */
export function subscribeConversationResync(refresh: () => void): () => void {
  const dispose = ipcBridge.realtime.reconnected.on(refresh);
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', refresh);
  return () => {
    dispose();
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', refresh);
  };
}

export async function getConversationOrNull(conversation_id: string): Promise<TChatConversation | null> {
  try {
    return await ipcBridge.conversation.get.invoke({ id: conversation_id });
  } catch (error) {
    if (isBackendHttpError(error) && error.status === 404 && error.code === 'NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

export async function refreshConversationCache(conversation_id: string): Promise<void> {
  const conversation = await getConversationOrNull(conversation_id);
  if (!conversation) return;

  await mutate<TChatConversation>(`conversation/${conversation_id}`, conversation, false);
}
