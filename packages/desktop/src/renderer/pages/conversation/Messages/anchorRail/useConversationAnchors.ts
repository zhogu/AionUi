/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TMessage } from '@/common/chat/chatLib';
import { useMemo } from 'react';
import { buildMessageAnchors, type MessageAnchorItem } from './anchors';

/**
 * Build anchors only from pages already held by the chat.
 *
 * Opening a conversation must remain bounded to its latest message page. The
 * rail used to fetch every historical page in the background, which made large
 * tool-heavy conversations download and parse their full history before the
 * page became responsive. Earlier anchors appear naturally as the user pages up;
 * explicit whole-conversation search remains available from the title panel.
 */
export const useConversationAnchors = (
  conversationId: string | undefined,
  liveMessages: TMessage[]
): MessageAnchorItem[] =>
  useMemo(() => (conversationId ? buildMessageAnchors(liveMessages) : []), [conversationId, liveMessages]);
