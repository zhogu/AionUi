/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useConversationAnchors } from '@/renderer/pages/conversation/Messages/anchorRail/useConversationAnchors';

/** Builds one user/assistant turn pair. */
const turn = (n: number): TMessage[] =>
  [
    {
      id: `u-${n}`,
      msg_id: `u-${n}`,
      conversation_id: 'c1',
      type: 'text',
      position: 'right',
      created_at: n * 2,
      content: { content: `question ${n}` },
    },
    {
      id: `a-${n}`,
      msg_id: `a-${n}`,
      conversation_id: 'c1',
      type: 'text',
      position: 'left',
      created_at: n * 2 + 1,
      content: { content: `answer ${n}` },
    },
  ] as unknown as TMessage[];

const history = (count: number) => Array.from({ length: count }, (_, i) => turn(i + 1)).flat();

describe('useConversationAnchors', () => {
  it('uses only the bounded history already loaded by the chat', () => {
    const paged = history(40).slice(-4); // chat area holds the last 2 turns

    const { result } = renderHook(() => useConversationAnchors('c1', paged));

    expect(result.current).toHaveLength(2);
    expect(result.current[0]?.question).toContain('question 39');
    expect(result.current[1]?.question).toContain('question 40');
  });

  it('extends the rail when newly sent or newly paged messages enter memory', () => {
    const { result, rerender } = renderHook(({ live }) => useConversationAnchors('c1', live), {
      initialProps: { live: history(5) },
    });

    expect(result.current).toHaveLength(5);
    rerender({ live: history(6) });
    expect(result.current).toHaveLength(6);
  });

  it('hides anchors as soon as there is no active conversation', () => {
    const { result, rerender } = renderHook(({ id }) => useConversationAnchors(id, history(3)), {
      initialProps: { id: 'c1' },
    });
    expect(result.current).toHaveLength(3);
    rerender({ id: undefined });
    expect(result.current).toEqual([]);
  });

  it('renders no ticks without a conversation', () => {
    const { result } = renderHook(() => useConversationAnchors(undefined, []));
    expect(result.current).toEqual([]);
  });
});
