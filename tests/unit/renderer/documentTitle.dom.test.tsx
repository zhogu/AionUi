/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import type { NavigateFunction } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import useSWR, { SWRConfig, useSWRConfig } from 'swr';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

let mockLanguage = 'en-US';

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: vi.fn(() => true),
}));

beforeEach(() => {
  mockLanguage = 'en-US';
  vi.mocked(isElectronDesktop).mockReturnValue(true);
  vi.mocked(getConversationOrNull).mockReset();
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (mockLanguage === 'zh-CN' ? `zh:${key}` : key),
    i18n: { language: mockLanguage },
  }),
}));

import DocumentTitle, { titleForPath } from '@/renderer/components/layout/DocumentTitle';

describe('titleForPath', () => {
  const t = (key: string) => `t(${key})`;

  it('uses the login title on the login route only', () => {
    expect(titleForPath('/login', t)).toBe('t(login.pageTitle)');
    expect(titleForPath('/guid', t)).toBe('AionUi');
    expect(titleForPath('/conversation/abc', t)).toBe('AionUi');
    expect(titleForPath('/settings/agent', t)).toBe('AionUi');
  });

  it('formats browser tabs with the hostname and current session name', () => {
    expect(titleForPath('/conversation/abc', t, 'nas.example.com', '调查消息延迟')).toBe('AionUI - nas - 调查消息延迟');
    expect(titleForPath('/settings/agent', t, 'nas.example.com', 'stale name')).toBe('AionUI - nas');
    expect(titleForPath('/login', t, 'localhost')).toBe('AionUI - localhost');
  });

  it.each([
    ['gateway.example.com', 'gateway'],
    ['www.gateway.example.com', 'gateway'],
    ['WWW.gateway.example.com', 'gateway'],
    ['www.www.gateway.example.com.', 'gateway'],
    ['gateway', 'gateway'],
    ['localhost', 'localhost'],
    ['192.168.1.20', '192.168.1.20'],
    ['[2001:db8::1]', '[2001:db8::1]'],
    ['www', 'www'],
  ])('uses the first non-www domain label but preserves IP hosts: %s', (hostname, label) => {
    expect(titleForPath('/conversation/abc', t, hostname, 'Session')).toBe(`AionUI - ${label} - Session`);
  });

  it('omits missing or blank names without adding dangling separators', () => {
    expect(titleForPath('/conversation/abc', t, 'localhost')).toBe('AionUI - localhost');
    expect(titleForPath('/conversation/abc', t, 'localhost', '   ')).toBe('AionUI - localhost');
    expect(titleForPath('/conversation/abc', t, '', 'Session')).toBe('AionUI - Session');
  });
});

describe('DocumentTitle', () => {
  it('does not block the conversation page from revalidating its name after a rename event', async () => {
    vi.mocked(isElectronDesktop).mockReturnValue(false);
    let name = 'Before rename';
    const fetchConversation = vi.fn(async () => ({ id: 'first', name }));
    vi.mocked(getConversationOrNull).mockImplementation(async () => ({
      id: 'first',
      name,
      type: 'acp',
      extra: {},
      created_at: 0,
      modified_at: 0,
    }));
    let refresh!: () => Promise<unknown>;
    const Page = () => {
      const { mutate } = useSWR('conversation/first', fetchConversation);
      refresh = mutate;
      return null;
    };
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <MemoryRouter initialEntries={['/conversation/first']}>
          <DocumentTitle />
          <Page />
        </MemoryRouter>
      </SWRConfig>
    );
    await waitFor(() => expect(document.title).toContain('Before rename'));
    name = 'After rename';
    await act(() => refresh());
    await waitFor(() => expect(document.title).toContain('After rename'));
  });

  it('tracks cache-backed session renames and navigation without fetching or retaining a stale name', async () => {
    vi.mocked(isElectronDesktop).mockReturnValue(false);
    const fetcher = vi.fn();
    let navigate!: NavigateFunction;
    let mutate!: ReturnType<typeof useSWRConfig>['mutate'];
    const Controls = () => {
      navigate = useNavigate();
      mutate = useSWRConfig().mutate;
      return <DocumentTitle />;
    };
    const hostTitle = `AionUI - ${window.location.hostname}`;
    render(
      <SWRConfig value={{ provider: () => new Map(), fetcher }}>
        <MemoryRouter initialEntries={['/conversation/first']}>
          <Controls />
        </MemoryRouter>
      </SWRConfig>
    );
    expect(document.title).toBe(hostTitle);
    await act(() => mutate('conversation/first', { id: 'first', name: 'First session' }, false));
    await waitFor(() => expect(document.title).toBe(`${hostTitle} - First session`));
    await act(() => mutate('conversation/first', { id: 'first', name: 'Renamed session' }, false));
    await waitFor(() => expect(document.title).toBe(`${hostTitle} - Renamed session`));
    await act(() => navigate('/conversation/second'));
    expect(document.title).toBe(hostTitle);
    await act(() => mutate('conversation/first', { id: 'first', name: 'Late update' }, false));
    expect(document.title).toBe(hostTitle);
    await act(() => mutate('conversation/second', { id: 'second', name: 'Second session' }, false));
    await waitFor(() => expect(document.title).toBe(`${hostTitle} - Second session`));
    await act(() => navigate('/guid'));
    expect(document.title).toBe(hostTitle);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('resets the title to AionUi after leaving the login page', () => {
    // The old behaviour set document.title once on the login page and never
    // updated it again, so post-login pages kept the login title.
    document.title = 'AionUi - stale login title';
    render(
      <MemoryRouter initialEntries={['/guid']}>
        <DocumentTitle />
      </MemoryRouter>
    );
    expect(document.title).toBe('AionUi');
  });

  it('sets the localised login title on the login route', () => {
    mockLanguage = 'zh-CN';
    render(
      <MemoryRouter initialEntries={['/login']}>
        <DocumentTitle />
      </MemoryRouter>
    );
    expect(document.title).toBe('zh:login.pageTitle');
    mockLanguage = 'en-US';
  });
});
