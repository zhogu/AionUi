/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { addEventListener } from '@/renderer/utils/emitter';

/**
 * Single owner of `document.title`.
 *
 * Web tabs identify the host and active conversation. Desktop windows retain
 * their existing route-based title, including the localized login title.
 */
export function titleForPath(
  pathname: string,
  t: (key: string) => string,
  hostname?: string,
  conversationName?: string
): string {
  if (hostname !== undefined) {
    const name = matchPath('/conversation/:id', pathname) ? conversationName?.trim() : undefined;
    const hostLabel =
      hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
        ? hostname
        : (hostname.split('.').find((label) => label && label.toLowerCase() !== 'www') ?? hostname);
    return ['AionUI', hostLabel, name].filter(Boolean).join(' - ');
  }
  return pathname.startsWith('/login') ? t('login.pageTitle') : 'AionUi';
}

const DocumentTitle: React.FC = () => {
  const { pathname } = useLocation();
  const { t, i18n } = useTranslation();
  const hostname = isElectronDesktop() ? undefined : window.location.hostname;
  const conversationId = matchPath('/conversation/:id', pathname)?.params.id;
  // Share the page's cache and fetcher: a fetcher-less first subscriber would
  // swallow SWR revalidation triggered by rename events.
  const { data: conversation } = useSWR<TChatConversation | null>(
    hostname !== undefined && conversationId ? `conversation/${conversationId}` : null,
    (key: string) => getConversationOrNull(key.slice('conversation/'.length)),
    { revalidateOnMount: false, keepPreviousData: false }
  );
  const conversationName = conversation && conversation.id === conversationId ? conversation.name : undefined;
  const [attention, setAttention] = useState<string | null>(null);
  const [showAttention, setShowAttention] = useState(false);

  useEffect(() => {
    if (hostname === undefined) return;
    const clear = () => setAttention(null);
    const onVisible = () => {
      if (!document.hidden && document.hasFocus()) clear();
    };
    const dispose = addEventListener('chat.attention', (notice) => {
      setAttention(notice?.body ?? null);
      setShowAttention(Boolean(notice));
    });
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('pointerdown', clear);
    document.addEventListener('keydown', clear);
    return () => {
      dispose();
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerdown', clear);
      document.removeEventListener('keydown', clear);
    };
  }, [hostname]);

  useEffect(() => {
    setAttention(null);
  }, [pathname]);

  useEffect(() => {
    if (!attention) return;
    const timer = window.setInterval(() => setShowAttention((visible) => !visible), 1000);
    return () => window.clearInterval(timer);
  }, [attention]);

  useEffect(() => {
    const title = titleForPath(pathname, t, hostname, conversationName);
    document.title = attention && showAttention ? `${attention} - ${title}` : title;
  }, [pathname, t, i18n.language, hostname, conversationName, attention, showAttention]);

  return null;
};

export default DocumentTitle;
