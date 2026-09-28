/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { Alert, Button, Message, Modal, Spin } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

const SessionIdModal: React.FC<{ conversationId: string; onClose: () => void }> = ({ conversationId, onClose }) => {
  const { t } = useTranslation();
  const [state, setState] = useState<{ loading: boolean; id?: string; failed?: boolean }>({ loading: true });
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    ipcBridge.conversation.get.invoke({ id: conversationId }).then(
      (conversation) => {
        if (active) setState({ loading: false, id: conversation.backend_session_id?.trim() || undefined });
      },
      (error: unknown) => {
        console.error('[SessionIdModal] Failed to load session identity:', error);
        if (active) setState({ loading: false, failed: true });
      }
    );
    return () => {
      active = false;
    };
  }, [conversationId]);

  const copy = async () => {
    if (!state.id) return;
    try {
      await copyText(state.id);
      Message.success(t('messages.copySuccess'));
    } catch {
      Message.error(t('common.copyFailed'));
    }
  };

  return (
    <Modal
      visible
      title={t('conversation.history.cliSessionId')}
      onCancel={onClose}
      style={{ width: 'min(480px, calc(100vw - 32px))' }}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button type='primary' disabled={!state.id || state.loading} onClick={() => void copy()}>
            {t('common.copy')}
          </Button>
        </>
      }
    >
      {state.loading ? (
        <Spin />
      ) : state.failed ? (
        <Alert type='error' content={t('conversation.history.cliSessionIdFailed')} />
      ) : state.id ? (
        <div className='font-mono select-text break-all' data-testid='cli-session-id'>
          {state.id}
        </div>
      ) : (
        <Alert type='info' content={t('conversation.history.cliSessionIdUnavailable')} />
      )}
    </Modal>
  );
};

export default SessionIdModal;
