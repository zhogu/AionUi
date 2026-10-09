/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import {
  shouldShowNotification,
  createBrowserNotificationController,
  truncateConversationName,
  CONVERSATION_NAME_MAX_LENGTH,
  type NotificationGate,
} from '@/renderer/hooks/system/notification/browserNotificationCore';

const openGate: NotificationGate = {
  isElectron: false,
  hasNotificationApi: true,
  isSecureContext: true,
  permission: 'granted',
  settingEnabled: true,
  documentHidden: true,
};

describe('shouldShowNotification', () => {
  it('returns true when all gates pass', () => {
    expect(shouldShowNotification(openGate)).toBe(true);
  });

  it.each([
    ['isElectron', { isElectron: true }],
    ['no api', { hasNotificationApi: false }],
    ['insecure', { isSecureContext: false }],
    ['not granted', { permission: 'default' as const }],
    ['setting off', { settingEnabled: false }],
    ['tab visible', { documentHidden: false }],
  ])('returns false when %s', (_label, override) => {
    expect(shouldShowNotification({ ...openGate, ...override })).toBe(false);
  });
});

describe('truncateConversationName', () => {
  it('returns a short name unchanged (trimmed)', () => {
    expect(truncateConversationName('  My chat  ')).toBe('My chat');
  });

  it('keeps a name exactly at the limit', () => {
    const exact = 'a'.repeat(CONVERSATION_NAME_MAX_LENGTH);
    expect(truncateConversationName(exact)).toBe(exact);
  });

  it('truncates from the end and appends an ellipsis when over the limit', () => {
    const long = 'a'.repeat(CONVERSATION_NAME_MAX_LENGTH + 5);
    expect(truncateConversationName(long)).toBe(`${'a'.repeat(CONVERSATION_NAME_MAX_LENGTH)}…`);
  });

  it('honors a custom max length', () => {
    expect(truncateConversationName('abcdef', 3)).toBe('abc…');
  });
});

describe('createBrowserNotificationController.onStreamMessage', () => {
  const makeDeps = (gate: NotificationGate = openGate) => {
    const show = vi.fn();
    const bodyFor = vi.fn((kind: string) => kind);
    const controller = createBrowserNotificationController({
      shouldShow: () => shouldShowNotification(gate),
      show,
      bodyFor,
    });
    return { show, bodyFor, controller };
  };

  it('shows a turn-completed notification on a finish stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledWith({ body: 'turnCompleted', conversationId: 'c1', kind: 'turnCompleted' });
  });

  it('passes the conversation id to bodyFor so the body can name the conversation', () => {
    const { bodyFor, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(bodyFor).toHaveBeenCalledWith('turnCompleted', 'c1');
  });

  it('shows a confirmation notification on an acp_permission stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c2' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c2', kind: 'confirmation' });
  });

  it('shows a confirmation notification on a permission stream message (aionrs)', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c3' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c3', kind: 'confirmation' });
  });

  it('shows a confirmation notification on an ask stream message', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'ask', conversation_id: 'c4', msg_id: 'm4' });
    expect(show).toHaveBeenCalledWith({ body: 'confirmation', conversationId: 'c4', kind: 'confirmation' });
  });

  it('dedups repeated confirmation frames carrying the same message id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1', msg_id: 'm1' });
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1', msg_id: 'm1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('notifies again for a different confirmation message id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c1', msg_id: 'm1' });
    controller.onStreamMessage({ type: 'permission', conversation_id: 'c1', msg_id: 'm2' });
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('ignores non-terminal stream message types', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'thinking', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'text', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'start', conversation_id: 'c1', turn_id: 't1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('does not show when the gate is closed', () => {
    const { show, controller } = makeDeps({ ...openGate, documentHidden: false });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });

  it('dedups repeated finish for the same turn_id', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c1', turn_id: 't1' });
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('deduplicates interleaved finishes per conversation rather than only the last turn', () => {
    const { show, controller } = makeDeps();
    for (const conversation_id of ['c1', 'c2', 'c1', 'c2']) {
      controller.onStreamMessage({ type: 'finish', conversation_id, turn_id: 'same-id' });
    }
    expect(show).toHaveBeenCalledTimes(2);
  });

  it.each([
    (id: string) => ({ tool_call: { tool_call_id: id, title: 'ask_user' } }),
    (id: string) => ({ toolCall: { toolCallId: id, title: 'ask_user' } }),
    (id: string) => ({ request_id: id }),
  ])('uses the request identity, not the shared turn envelope, for questions', (data) => {
    const { show, controller } = makeDeps();
    for (const id of ['first', 'second', 'first']) {
      controller.onStreamMessage({ type: 'acp_permission', conversation_id: 'c', msg_id: 'turn', data: data(id) });
    }
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('does not alert on replay of an event already seen while the user was watching', () => {
    let enabled = false;
    const show = vi.fn();
    const controller = createBrowserNotificationController({ show, shouldShow: () => enabled, bodyFor: () => '' });
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c', turn_id: 't' });
    enabled = true;
    controller.onStreamMessage({ type: 'finish', conversation_id: 'c', turn_id: 't' });
    expect(show).not.toHaveBeenCalled();
  });

  it('ignores messages without a type', () => {
    const { show, controller } = makeDeps();
    controller.onStreamMessage({ conversation_id: 'c1' });
    expect(show).not.toHaveBeenCalled();
  });
});
