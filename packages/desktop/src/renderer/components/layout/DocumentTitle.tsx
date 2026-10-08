/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { matchPath, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import { isElectronDesktop } from '@/renderer/utils/platform';

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
  // Observe the page's existing cache: no extra request or rename subscription.
  const { data: conversation } = useSWR<TChatConversation | null>(
    hostname !== undefined && conversationId ? `conversation/${conversationId}` : null,
    { fetcher: null, keepPreviousData: false }
  );
  const conversationName = conversation && conversation.id === conversationId ? conversation.name : undefined;

  useEffect(() => {
    document.title = titleForPath(pathname, t, hostname, conversationName);
  }, [pathname, t, i18n.language, hostname, conversationName]);

  return null;
};

export default DocumentTitle;
