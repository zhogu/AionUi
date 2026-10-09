/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-free core for WebUI browser notifications: pure gating and a
 * controller that turns conversation events into notification payloads.
 * Kept free of React / DOM globals so it is unit-testable in the node project.
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied';

export type NotificationGate = {
  isElectron: boolean;
  hasNotificationApi: boolean;
  isSecureContext: boolean;
  permission: NotificationPermissionState;
  settingEnabled: boolean;
  documentHidden: boolean;
};

export const shouldShowNotification = (gate: NotificationGate): boolean =>
  !gate.isElectron &&
  gate.hasNotificationApi &&
  gate.isSecureContext &&
  gate.permission === 'granted' &&
  gate.settingEnabled &&
  gate.documentHidden;

/**
 * Max length of a conversation name embedded in a turn-completed notification.
 * The name sits at the front of the body, so anything longer is truncated with
 * a trailing ellipsis (keep the beginning, where the title's meaning is). Kept
 * as a constant so it is easy to tune in one place.
 */
export const CONVERSATION_NAME_MAX_LENGTH = 20;

/**
 * Trim a conversation name and cap it at `maxLength`, appending an ellipsis when
 * it overflows. Keeps the leading characters (front-loaded titles read best).
 */
export const truncateConversationName = (name: string, maxLength: number = CONVERSATION_NAME_MAX_LENGTH): string => {
  const trimmed = name.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
};

export type NotificationKind = 'confirmation' | 'turnCompleted';

export type NotificationPayload = {
  body: string;
  conversationId?: string;
  kind: NotificationKind;
};

export type BrowserNotificationDeps = {
  /**
   * Whether a notification may be shown right now. The WebUI path derives this
   * from the browser gate (`shouldShowNotification`); the desktop path uses its
   * own condition (window focus is checked in the main process). Injecting the
   * predicate keeps this controller — and its turn-finish detection / dedup —
   * shared across both paths.
   */
  shouldShow: (conversationId?: string) => boolean;
  show: (payload: NotificationPayload) => void;
  /**
   * Build the notification body for a given kind. `conversationId` is provided
   * so the turn-completed body can name the originating conversation; the
   * confirmation body ignores it.
   */
  bodyFor: (kind: NotificationKind, conversationId?: string) => string;
};

/**
 * Shape of a conversation response-stream message (`message.stream`). Both the
 * turn-finish and permission-request signals ride this channel, keyed by
 * `type`. The dedicated turn.completed event can also be normalized to finish.
 */
export type StreamMessage = {
  type?: string;
  conversation_id?: string;
  turn_id?: string;
  /** Stable per-message id, used to dedup repeated confirmation frames
   *  (e.g. a reconnect replay re-delivering the same permission request). */
  msg_id?: string;
  data?: unknown;
};

// Stream `type` values that represent the agent blocking on the user: a tool
// permission request (`acp_permission` from ACP; `permission` too from aionrs)
// or a structured question (`ask`, AskUserQuestion). All surface the same
// "needs your input" notification.
const CONFIRMATION_TYPES = new Set(['acp_permission', 'permission', 'ask']);

export const createBrowserNotificationController = (deps: BrowserNotificationDeps) => {
  const seen = new Set<string>();
  const remember = (kind: NotificationKind, conversationId?: string, id?: string): boolean => {
    if (!id) return false;
    const key = JSON.stringify([kind, conversationId, id]);
    if (seen.has(key)) return true;
    seen.add(key);
    if (seen.size > 256) seen.delete(seen.values().next().value!);
    return false;
  };

  const onStreamMessage = (message: StreamMessage): void => {
    if (!message?.type) return;

    if (CONFIRMATION_TYPES.has(message.type)) {
      const data = asRecord(message.data);
      const tool = asRecord(data?.tool_call ?? data?.toolCall);
      // ACP reuses the turn envelope msg_id for multiple permission/questions.
      const requestId = data?.request_id ?? data?.requestId ?? data?.call_id ?? tool?.tool_call_id ?? tool?.toolCallId;
      const id = typeof requestId === 'string' && requestId ? requestId : message.msg_id;
      if (remember('confirmation', message.conversation_id, id)) return;
      if (!deps.shouldShow(message.conversation_id)) return;
      deps.show({
        body: deps.bodyFor('confirmation', message.conversation_id),
        conversationId: message.conversation_id,
        kind: 'confirmation',
      });
      return;
    }

    if (message.type === 'finish') {
      if (remember('turnCompleted', message.conversation_id, message.turn_id ?? message.msg_id)) return;
      if (!deps.shouldShow(message.conversation_id)) return;
      deps.show({
        body: deps.bodyFor('turnCompleted', message.conversation_id),
        conversationId: message.conversation_id,
        kind: 'turnCompleted',
      });
    }
  };

  return { onStreamMessage };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
