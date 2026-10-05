import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const html = readFileSync('packages/desktop/src/renderer/index.html', 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .find((value) => value.includes('__AIONUI_BOOT_MESSAGES__'))!;
const messages = {
  'en-US': { loading: 'Loading', failed: 'Download failed', reload: 'Reload' },
  'zh-CN': { loading: '加载中', failed: '下载失败', reload: '重试' },
};

function mount() {
  document.body.innerHTML =
    '<div id="root"><div id="boot-status"><p id="boot-message"></p><a id="boot-reload" hidden></a></div></div>';
  window.eval(script.replace('__AIONUI_BOOT_MESSAGES__', JSON.stringify(messages)));
}

afterEach(async () => {
  document.getElementById('root')?.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dependency-free page load recovery', () => {
  it('shows a localized retry after 15 seconds without waiting for React', async () => {
    vi.useFakeTimers();
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('zh-CN');
    mount();
    expect(document.getElementById('boot-message')?.textContent).toBe('加载中');
    await vi.advanceTimersByTimeAsync(15000);
    expect(document.getElementById('boot-message')?.textContent).toBe('下载失败');
    expect(document.getElementById('boot-reload')).not.toHaveAttribute('hidden');
  });

  it('shows recovery immediately on module load failure', () => {
    mount();
    const module = document.createElement('script');
    document.body.append(module);
    module.dispatchEvent(new Event('error'));
    expect(document.getElementById('boot-reload')).not.toHaveAttribute('hidden');
  });

  it('removes its timer and error listener when the app replaces the placeholder', async () => {
    vi.useFakeTimers();
    const remove = vi.spyOn(window, 'removeEventListener');
    mount();
    document.getElementById('root')!.replaceChildren(document.createElement('main'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('error', expect.any(Function), true);
  });
});
