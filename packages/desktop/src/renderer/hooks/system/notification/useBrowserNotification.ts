/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getSnapshotConversationName } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { emitter } from '@/renderer/utils/emitter';
import {
  createBrowserNotificationController,
  shouldShowNotification,
  truncateConversationName,
  type NotificationPermissionState,
} from './browserNotificationCore';

/**
 * WebUI-only: show a browser notification when an agent requests a
 * confirmation or finishes a turn outside the focused conversation. Title
 * attention also works without browser notification permission or HTTPS.
 */
export const useBrowserNotification = (): void => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const currentConversation = useRef<string | undefined>(undefined);
  currentConversation.current = matchPath('/conversation/:id', pathname)?.params.id;

  useEffect(() => {
    if (isElectronDesktop()) return;
    const streamEmitter = ipcBridge.conversation.responseStream;
    if (!streamEmitter) return;

    // The controller's turn_id dedup is best-effort per effect lifetime: it
    // resets if this effect re-runs (e.g. on a language change). Acceptable —
    // worst case is one duplicate notification across a locale switch.
    const controller = createBrowserNotificationController({
      shouldShow: (conversationId) =>
        configService.get('system.notificationEnabled') !== false &&
        (document.hidden ||
          !document.hasFocus() ||
          (Boolean(conversationId) && conversationId !== currentConversation.current)),
      bodyFor: (kind, conversationId) => {
        const name = conversationId ? getSnapshotConversationName(conversationId) : undefined;
        if (kind === 'confirmation') {
          return name
            ? t('settings.browserNotification.bodyConfirmationNamed', { name: truncateConversationName(name) })
            : t('settings.browserNotification.bodyConfirmation');
        }
        return name
          ? t('settings.browserNotification.bodyTurnCompletedNamed', { name: truncateConversationName(name) })
          : t('settings.browserNotification.bodyTurnCompleted');
      },
      show: ({ body, conversationId }) => {
        emitter.emit('chat.attention', { body });
        const hasNotificationApi = typeof Notification !== 'undefined';
        if (
          !shouldShowNotification({
            isElectron: false,
            hasNotificationApi,
            isSecureContext: window.isSecureContext,
            permission: hasNotificationApi ? (Notification.permission as NotificationPermissionState) : 'denied',
            settingEnabled: configService.get('system.notificationEnabled') !== false,
            documentHidden: true, // The focused-conversation gate has already passed.
          })
        )
          return;
        try {
          const notification = new Notification('AionUi', { body });
          notification.onclick = () => {
            emitter.emit('chat.attention', null);
            window.focus();
            if (conversationId) void navigate(`/conversation/${conversationId}`);
            notification.close();
          };
        } catch (error) {
          console.error('[useBrowserNotification] Failed to show notification:', error);
        }
      },
    });

    const disposeStream = streamEmitter.on(controller.onStreamMessage);
    const disposeCompleted = ipcBridge.conversation.turnCompleted.on((event) => {
      controller.onStreamMessage({ type: 'finish', conversation_id: event.session_id, turn_id: event.turn_id });
    });
    const disposeSetting = configService.subscribe('system.notificationEnabled', (enabled) => {
      if (enabled === false) emitter.emit('chat.attention', null);
    });
    return () => {
      disposeStream();
      disposeCompleted();
      disposeSetting();
      emitter.emit('chat.attention', null);
    };
  }, [navigate, t]);
};
