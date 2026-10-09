/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { emitter } from '@/renderer/utils/emitter';

const streamHandlers: Array<(e: unknown) => void> = [];
const completedHandlers: Array<(e: { session_id: string; turn_id: string }) => void> = [];
let settingEnabled = true;
let settingListener: ((enabled: boolean) => void) | undefined;
const disposeStream = vi.fn();
const disposeCompleted = vi.fn();
const disposeSetting = vi.fn();

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: {
        on: (h: (e: unknown) => void) => {
          streamHandlers.push(h);
          return disposeStream;
        },
      },
      turnCompleted: {
        on: (h: (e: { session_id: string; turn_id: string }) => void) => {
          completedHandlers.push(h);
          return disposeCompleted;
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));
vi.mock('@/common/config/configService', () => ({
  configService: {
    get: () => settingEnabled,
    subscribe: (_key: string, listener: typeof settingListener) => {
      settingListener = listener;
      return disposeSetting;
    },
  },
}));
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: '/conversation/s1' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { useBrowserNotification } from '@/renderer/hooks/system/notification/useBrowserNotification';

const emitStream = (message: unknown) => streamHandlers.forEach((h) => h(message));

class FakeNotification {
  static permission = 'granted';
  onclick: (() => void) | null = null;
  close = vi.fn();
  constructor(
    public title: string,
    public options: { body: string }
  ) {
    FakeNotification.instances.push(this);
  }
  static instances: FakeNotification[] = [];
}

beforeEach(() => {
  streamHandlers.length = 0;
  completedHandlers.length = 0;
  settingEnabled = true;
  FakeNotification.permission = 'granted';
  vi.clearAllMocks();
  FakeNotification.instances.length = 0;
  navigate.mockClear();
  (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
  // jsdom does not implement window.focus(); stub it so the click path is quiet.
  window.focus = vi.fn();
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(document, 'hidden', { value: true, configurable: true });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('useBrowserNotification', () => {
  it.each(['denied', 'default'])(
    'requests title attention without requesting notification permission: %s',
    (permission) => {
      FakeNotification.permission = permission;
      const attention = vi.spyOn(emitter, 'emit');
      renderHook(() => useBrowserNotification());
      emitStream({ type: 'ask', conversation_id: 's1', data: { request_id: 'question' } });
      expect(attention).toHaveBeenCalledWith('chat.attention', {
        body: 'settings.browserNotification.bodyConfirmation',
      });
      expect(FakeNotification.instances).toHaveLength(0);
    }
  );

  it('keeps title fallback when Notification API is absent or the context is insecure', () => {
    vi.stubGlobal('Notification', undefined);
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const attention = vi.spyOn(emitter, 'emit');
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(attention).toHaveBeenCalledWith('chat.attention', {
      body: 'settings.browserNotification.bodyTurnCompleted',
    });
    expect(FakeNotification.instances).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it('does not disturb the focused conversation, but alerts for another session', () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(FakeNotification.instances).toHaveLength(0);
    emitStream({ type: 'finish', conversation_id: 's2', turn_id: 't2' });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('notifies when the tab is visible but the window is not focused', () => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it('deduplicates completion channels, while allowing multiple ask_user requests in the same turn', () => {
    renderHook(() => useBrowserNotification());
    for (const id of ['a', 'b', 'a']) {
      emitStream({
        type: 'acp_permission',
        conversation_id: 's1',
        msg_id: 'envelope',
        data: { tool_call: { tool_call_id: id, title: 'ask_user' } },
      });
    }
    completedHandlers.forEach((h) => h({ session_id: 's1', turn_id: 't1' }));
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(FakeNotification.instances).toHaveLength(3);
  });

  it('respects disabled notifications and clears attention when disabled or unmounted', () => {
    const attention = vi.spyOn(emitter, 'emit');
    settingEnabled = false;
    const { unmount } = renderHook(() => useBrowserNotification());
    emitStream({ type: 'ask', conversation_id: 's1', msg_id: 'm1' });
    expect(attention).not.toHaveBeenCalled();
    settingListener?.(false);
    expect(attention).toHaveBeenCalledWith('chat.attention', null);
    unmount();
    expect(disposeStream).toHaveBeenCalled();
    expect(disposeCompleted).toHaveBeenCalled();
    expect(disposeSetting).toHaveBeenCalled();
  });

  it('retains title attention and logs when the browser refuses to create a notification', () => {
    const attention = vi.spyOn(emitter, 'emit');
    const error = new Error('Notification unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal(
      'Notification',
      class {
        static permission = 'granted';
        constructor() {
          throw error;
        }
      }
    );
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(attention).toHaveBeenCalledWith('chat.attention', {
      body: 'settings.browserNotification.bodyTurnCompleted',
    });
    expect(log).toHaveBeenCalledWith('[useBrowserNotification] Failed to show notification:', error);
    vi.unstubAllGlobals();
  });

  it('shows a confirmation notification on an acp_permission stream message when hidden', () => {
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'acp_permission', conversation_id: 'c1' });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].options.body).toBe('settings.browserNotification.bodyConfirmation');
  });

  it('shows a turn-completed notification on a finish stream message and navigates on click', () => {
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'finish', conversation_id: 's1', turn_id: 't1' });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0].options.body).toBe('settings.browserNotification.bodyTurnCompleted');
    FakeNotification.instances[0].onclick?.();
    expect(navigate).toHaveBeenCalledWith('/conversation/s1');
  });

  it('ignores non-terminal stream messages', () => {
    renderHook(() => useBrowserNotification());
    emitStream({ type: 'thinking', conversation_id: 's1', turn_id: 't1' });
    emitStream({ type: 'text', conversation_id: 's1', turn_id: 't1' });
    expect(FakeNotification.instances).toHaveLength(0);
  });
});
