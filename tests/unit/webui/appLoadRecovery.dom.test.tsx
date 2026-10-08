import React, { Suspense } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AppLoader, { AppLoadBoundary } from '@/renderer/components/layout/AppLoader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('React page load recovery', () => {
  it('shows loading immediately and a manual reload only after 15 seconds', () => {
    vi.useFakeTimers();
    render(<AppLoader />);
    expect(screen.getByRole('status')).toHaveTextContent('common.loading');
    act(() => vi.advanceTimersByTime(14999));
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button', { name: 'common.reload' })).toBeVisible();
  });

  it('clears the recovery timer when startup completes', () => {
    vi.useFakeTimers();
    const view = render(<AppLoader />);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('provides immediate recovery for explicit failures', () => {
    render(<AppLoader failed />);
    expect(screen.getByRole('alert')).toHaveTextContent('common.pageLoadFailed');
    expect(screen.getByRole('button', { name: 'common.reload' })).toBeVisible();
  });

  it('logs rejected lazy modules and keeps a reload action instead of unmounting the app', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('Failed to fetch dynamically imported module');
    const Page = React.lazy(() => Promise.reject(failure));
    await act(async () => {
      render(
        <AppLoadBoundary>
          <Suspense fallback={<AppLoader />}>
            <Page />
          </Suspense>
        </AppLoadBoundary>
      );
    });
    expect(screen.getByRole('button', { name: 'common.reload' })).toBeVisible();
    expect(log).toHaveBeenCalledWith('Application rendering failed:', failure, expect.any(String));
  });

  it('allows a delayed page to finish without forcing a reload', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { default: React.ComponentType }) => void;
    const Page = React.lazy(
      () =>
        new Promise<{ default: React.ComponentType }>((done) => {
          resolve = done;
        })
    );
    render(
      <AppLoadBoundary>
        <Suspense fallback={<AppLoader />}>
          <Page />
        </Suspense>
      </AppLoadBoundary>
    );
    act(() => vi.advanceTimersByTime(15000));
    expect(screen.getByRole('button', { name: 'common.reload' })).toBeVisible();
    await act(async () => resolve({ default: () => <main>Ready</main> }));
    expect(screen.getByRole('main')).toHaveTextContent('Ready');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
