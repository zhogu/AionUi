/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TChatConversation } from '@/common/config/storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcBridge } from '@/common';
import { copyText } from '@/renderer/utils/ui/clipboard';
import { Message } from '@arco-design/web-react';

vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Message: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: vi.fn() } } },
}));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(undefined) }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: null }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/pages/conversation/utils/conversationAssistantIdentity', () => ({
  resolveConversationLeadingMark: () => ({ kind: 'default' }),
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobIndicator: () => null,
}));

vi.mock('@/renderer/utils/model/agentLogo', () => ({
  useAgentLogos: () => ({}),
}));

vi.mock('@/renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: vi.fn(),
  getSiderTooltipProps: () => ({ disabled: true }),
}));

import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import type { ConversationRowProps } from '@/renderer/pages/conversation/GroupedHistory/types';

const conversation = {
  id: 'cron-menu-conversation',
  name: 'Scheduled task source',
  type: 'acp',
  created_at: 1,
  modified_at: 1,
  extra: { backend: 'claude' },
  model: {},
} as TChatConversation;

const makeProps = (overrides: Partial<ConversationRowProps> = {}): ConversationRowProps => ({
  conversation,
  isGenerating: false,
  hasUnread: false,
  collapsed: false,
  tooltipEnabled: false,
  batchMode: false,
  checked: false,
  selected: false,
  menuVisible: true,
  onToggleChecked: vi.fn(),
  onConversationClick: vi.fn(),
  onOpenMenu: vi.fn(),
  onMenuVisibleChange: vi.fn(),
  onEditStart: vi.fn(),
  onCreateCronTask: vi.fn(),
  onArchive: vi.fn(),
  onTogglePin: vi.fn(),
  getJobStatus: () => 'none',
  ...overrides,
});

describe('conversation scheduled-task menu item', () => {
  it('renders the Timer action between Rename and Archive and invokes it for the selected row', async () => {
    const onCreateCronTask = vi.fn();
    const onEditStart = vi.fn();
    const onArchive = vi.fn();
    render(<ConversationRow {...makeProps({ onCreateCronTask, onArchive, onEditStart })} />);

    const rename = await screen.findByText('conversation.history.rename');
    const createCronTask = screen.getByText('conversation.history.createCronTask');
    const archiveItem = screen.getByText('conversation.history.archive');

    expect(rename.compareDocumentPosition(createCronTask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(createCronTask.compareDocumentPosition(archiveItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(rename);
    await waitFor(() => expect(onEditStart).toHaveBeenCalledWith(conversation));
    fireEvent.click(archiveItem);
    await waitFor(() => expect(onArchive).toHaveBeenCalledWith(conversation));
    fireEvent.click(createCronTask);
    await waitFor(() => expect(onCreateCronTask).toHaveBeenCalledWith(conversation));
  });

  describe('CLI session identity menu', () => {
    beforeEach(() => {
      vi.mocked(ipcBridge.conversation.get.invoke).mockReset();
      vi.mocked(copyText).mockClear();
    });

    it.each(['copilot', 'custom'])(
      'loads and copies the current %s session, not the conversation id',
      async (backend) => {
        vi.mocked(ipcBridge.conversation.get.invoke).mockResolvedValue({
          ...conversation,
          backend_session_id: 'native-session-uuid',
        });
        const onConversationClick = vi.fn();
        render(
          <ConversationRow
            {...makeProps({
              conversation: { ...conversation, extra: { backend } } as TChatConversation,
              onConversationClick,
            })}
          />
        );
        expect(ipcBridge.conversation.get.invoke).not.toHaveBeenCalled();
        fireEvent.click(await screen.findByText('conversation.history.cliSessionId'));
        expect(await screen.findByTestId('cli-session-id')).toHaveTextContent('native-session-uuid');
        fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
        await waitFor(() => expect(copyText).toHaveBeenCalledWith('native-session-uuid'));
        expect(onConversationClick).not.toHaveBeenCalled();
      }
    );

    it('disables copying when no backend session has been created', async () => {
      vi.mocked(ipcBridge.conversation.get.invoke).mockResolvedValue(conversation);
      render(<ConversationRow {...makeProps()} />);
      fireEvent.click(await screen.findByText('conversation.history.cliSessionId'));
      expect(await screen.findByText('conversation.history.cliSessionIdUnavailable')).toBeVisible();
      expect(screen.getByRole('button', { name: 'common.copy' })).toBeDisabled();
    });

    it('reloads the identity each time the dialog opens', async () => {
      vi.mocked(ipcBridge.conversation.get.invoke)
        .mockResolvedValueOnce({ ...conversation, backend_session_id: 'old-session' })
        .mockResolvedValueOnce({ ...conversation, backend_session_id: 'new-session' });
      render(<ConversationRow {...makeProps()} />);
      fireEvent.click(await screen.findByText('conversation.history.cliSessionId'));
      expect(await screen.findByTestId('cli-session-id')).toHaveTextContent('old-session');
      fireEvent.click(screen.getByRole('button', { name: 'common.close' }));
      fireEvent.click(screen.getByText('conversation.history.cliSessionId'));
      await waitFor(() => expect(screen.getByTestId('cli-session-id')).toHaveTextContent('new-session'));
    });

    it('reports load failure without falling back to a stale list identity', async () => {
      vi.mocked(ipcBridge.conversation.get.invoke).mockRejectedValue(new Error('not found'));
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<ConversationRow {...makeProps({ conversation: { ...conversation, backend_session_id: 'stale' } })} />);
      fireEvent.click(await screen.findByText('conversation.history.cliSessionId'));
      expect(await screen.findByText('conversation.history.cliSessionIdFailed')).toBeVisible();
      expect(screen.getByRole('button', { name: 'common.copy' })).toBeDisabled();
      log.mockRestore();
    });

    it('reports clipboard failure', async () => {
      vi.mocked(ipcBridge.conversation.get.invoke).mockResolvedValue({ ...conversation, backend_session_id: 'native' });
      vi.mocked(copyText).mockRejectedValueOnce(new Error('denied'));
      const error = vi.spyOn(Message, 'error');
      render(<ConversationRow {...makeProps()} />);
      fireEvent.click(await screen.findByText('conversation.history.cliSessionId'));
      await screen.findByTestId('cli-session-id');
      fireEvent.click(screen.getByRole('button', { name: 'common.copy' }));
      await waitFor(() => expect(error).toHaveBeenCalledWith('common.copyFailed'));
      error.mockRestore();
    });
  });

  it('keeps row actions hidden while batch selection is active', () => {
    render(<ConversationRow {...makeProps({ batchMode: true, menuVisible: false })} />);

    expect(screen.queryByText('conversation.history.createCronTask')).not.toBeInTheDocument();
  });
});
