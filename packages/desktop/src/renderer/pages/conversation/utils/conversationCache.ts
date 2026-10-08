/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import type { TChatConversation } from '@/common/config/storage';
import { mutate } from 'swr';
import {
  getConversationRuntimeViewSnapshot,
  subscribeConversationRuntimeView,
} from '../runtime/conversationRuntimeViewStore';

type ResyncCallback = () => void | Promise<unknown>;
const conversationRefreshers = new Map<string, Set<ResyncCallback>>();

/** Reconcile snapshots after a transport gap or a suspended browser tab. Never replay prompts. */
export function subscribeConversationResync(
  refresh: ResyncCallback,
  conversationId?: string,
  pollWhileProcessing = false
): () => void {
  if (conversationId) {
    const callbacks = conversationRefreshers.get(conversationId) ?? new Set<ResyncCallback>();
    callbacks.add(refresh);
    conversationRefreshers.set(conversationId, callbacks);
  }
  const dispose = ipcBridge.realtime.reconnected.on(refresh);
  const onVisible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', refresh);
  let lastStreamAt = Date.now();
  let pending = false;
  let disposed = false;
  const disposeStream =
    conversationId && pollWhileProcessing
      ? ipcBridge.acpConversation.responseStream.on((message) => {
          if (message.conversation_id === conversationId) lastStreamAt = Date.now();
        })
      : undefined;
  // Only the mounted message list opts in. Quiet healthy agents are not
  // disconnected; HTTP snapshots also cover a half-open or blocked WebSocket.
  let timer: number | undefined;
  const syncTimer = () => {
    const active =
      pollWhileProcessing && conversationId && getConversationRuntimeViewSnapshot(conversationId).isProcessing;
    if (!active) {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      return;
    }
    if (timer !== undefined) return;
    lastStreamAt = Date.now();
    timer = window.setInterval(() => {
      if (
        disposed ||
        pending ||
        document.visibilityState !== 'visible' ||
        Date.now() - lastStreamAt < 10000 ||
        !getConversationRuntimeViewSnapshot(conversationId).isProcessing
      )
        return;
      pending = true;
      void Promise.resolve()
        .then(() => {
          if (!disposed) {
            return Promise.allSettled(
              [...(conversationRefreshers.get(conversationId) ?? [])].map((callback) =>
                Promise.resolve().then(callback)
              )
            ).then((results) => {
              for (const result of results) {
                if (result.status === 'rejected') {
                  console.error('[conversationResync] Failed to catch up quiet active conversation:', result.reason);
                }
              }
            });
          }
        })
        .catch((error) => {
          console.error('[conversationResync] Failed to catch up quiet active conversation:', error);
        })
        .finally(() => {
          pending = false;
        });
    }, 5000);
  };
  const disposeRuntime =
    conversationId && pollWhileProcessing ? subscribeConversationRuntimeView(syncTimer) : undefined;
  syncTimer();
  return () => {
    disposed = true;
    if (timer !== undefined) window.clearInterval(timer);
    disposeRuntime?.();
    disposeStream?.();
    if (conversationId) {
      const callbacks = conversationRefreshers.get(conversationId);
      callbacks?.delete(refresh);
      if (!callbacks?.size) conversationRefreshers.delete(conversationId);
    }
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
