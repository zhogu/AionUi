/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { subscribeConversationResync } from '@/renderer/pages/conversation/utils/conversationCache';

const mocks = vi.hoisted(() => ({
  active: true,
  stream: undefined as undefined | ((message: { conversation_id: string }) => void),
  runtime: undefined as undefined | (() => void),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    realtime: { reconnected: { on: () => () => {} } },
    acpConversation: {
      responseStream: {
        on: (cb: typeof mocks.stream) => {
          mocks.stream = cb;
          return () => {
            mocks.stream = undefined;
          };
        },
      },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/runtime/conversationRuntimeViewStore', () => ({
  getConversationRuntimeViewSnapshot: () => ({ isProcessing: mocks.active }),
  subscribeConversationRuntimeView: (cb: () => void) => {
    mocks.runtime = cb;
    return () => {
      mocks.runtime = undefined;
    };
  },
}));

let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  mocks.active = true;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('quiet active conversation recovery', () => {
  it('fetches during a lost push stream after ten seconds, without waiting for completion', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    dispose = subscribeConversationResync(refresh, 'c', true);
    await vi.advanceTimersByTimeAsync(9999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not poll healthy streams or idle conversations', async () => {
    const refresh = vi.fn();
    dispose = subscribeConversationResync(refresh, 'c', true);
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(4000);
      mocks.stream?.({ conversation_id: 'c' });
    }
    expect(refresh).not.toHaveBeenCalled();
    mocks.active = false;
    mocks.runtime?.();
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores other conversations and pauses when the tab is hidden', async () => {
    const refresh = vi.fn();
    dispose = subscribeConversationResync(refresh, 'c', true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    mocks.stream?.({ conversation_id: 'other' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not overlap slow requests and stops after unmount', async () => {
    let finish!: () => void;
    const refresh = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    dispose = subscribeConversationResync(refresh, 'c', true);
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    dispose();
    finish();
    await vi.advanceTimersByTimeAsync(30000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mocks.stream).toBeUndefined();
  });

  it('logs a failed catch-up and retries on the next tick', async () => {
    const error = new Error('network unavailable');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refresh = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    dispose = subscribeConversationResync(refresh, 'c', true);
    await vi.advanceTimersByTimeAsync(15000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('[conversationResync] Failed to catch up quiet active conversation:', error);
  });

  it('also reconciles runtime state and stops polling when the missed completion is recovered', async () => {
    const history = vi.fn();
    const runtime = vi.fn(() => {
      mocks.active = false;
      mocks.runtime?.();
    });
    const disposeRuntime = subscribeConversationResync(runtime, 'c');
    dispose = subscribeConversationResync(history, 'c', true);
    try {
      await vi.advanceTimersByTimeAsync(30000);
      expect(history).toHaveBeenCalledTimes(1);
      expect(runtime).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      disposeRuntime();
    }
  });
});
