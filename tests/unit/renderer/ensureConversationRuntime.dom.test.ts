import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureConversationRuntime,
  resetEnsureConversationRuntimeStateForTests,
} from '@/renderer/pages/conversation/utils/ensureConversationRuntime';

vi.mock('@/common', async () => {
  const { httpPost } = await import('@/common/adapter/httpBridge');
  return {
    ipcBridge: {
      conversation: {
        ensureRuntime: httpPost(
          (params: { conversation_id: string }) => `/api/conversations/${params.conversation_id}/runtime/ensure`,
          () => undefined,
          { timeoutMs: 90_000 }
        ),
      },
    },
  };
});

describe('bounded shared runtime startup', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetEnsureConversationRuntimeStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetEnsureConversationRuntimeStateForTests();
  });

  it('shares one request, releases a stalled entry and keeps its late result out of a retry', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal('fetch', fetchMock);
    const first = ensureConversationRuntime('c');
    expect(ensureConversationRuntime('c')).toBe(first);
    const rejected = expect(first).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    const retry = ensureConversationRuntime('c');
    expect(retry).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const response = () =>
      new Response(JSON.stringify({ data: { recovered: false, config_options: [] } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    resolvers[0](response());
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureConversationRuntime('c')).toBe(retry);
    resolvers[1](response());
    await expect(retry).resolves.toMatchObject({ config_options: [] });
    expect(vi.getTimerCount()).toBe(0);
  });
});
