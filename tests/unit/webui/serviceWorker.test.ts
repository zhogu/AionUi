import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync('public/sw.js', 'utf8');
type SwRequest = { url: string; method: string; mode: string; destination: string };
type SwEvent = {
  request?: SwRequest;
  waitUntil: (promise: Promise<unknown>) => void;
  respondWith: (promise: Promise<Response>) => void;
};

function harness(scope = 'https://example.test/aionui/') {
  const handlers = new Map<string, (event: SwEvent) => void>();
  const entries = new Map<string, Response>();
  const key = (request: string | SwRequest) => (typeof request === 'string' ? request : request.url);
  const cache = {
    match: vi.fn(async (request: string | SwRequest) => entries.get(key(request))?.clone()),
    put: vi.fn(async (request: string | SwRequest, response: Response) => {
      entries.set(key(request), response.clone());
    }),
    delete: vi.fn(async (request: string | SwRequest) => entries.delete(key(request))),
  };
  const caches = {
    open: vi.fn(async () => cache),
    keys: vi.fn(async () => ['aionui-webui-v1', 'aionui-webui-v2', 'other-app', 'aionui-webui-v3']),
    delete: vi.fn(async () => true),
  };
  const fetch = vi.fn<typeof globalThis.fetch>();
  const self = {
    location: new URL(`${scope}sw.js`),
    addEventListener: (type: string, handler: (event: SwEvent) => void) => handlers.set(type, handler),
    skipWaiting: vi.fn(async () => {}),
    clients: { claim: vi.fn(async () => {}) },
  };
  runInNewContext(source, { self, caches, fetch, URL, Response, AbortController, setTimeout, clearTimeout, console });
  function dispatch(type: string, path = 'assets/vendor-12345678.js', options: Partial<SwRequest> = {}) {
    const wait: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(type)!({
      request: { url: new URL(path, scope).href, method: 'GET', mode: 'cors', destination: 'script', ...options },
      waitUntil: (promise) => wait.push(promise),
      respondWith: (promise) => {
        response = promise;
      },
    });
    return { response, done: () => Promise.all(wait) };
  }
  return { cache, caches, entries, fetch, self, dispatch };
}

const js = () => new Response('export default 42;', { headers: { 'Content-Type': 'application/javascript' } });

afterEach(() => vi.useRealTimers());

describe('WebUI service worker resource recovery', () => {
  it('installs even when optional precache requests fail', async () => {
    const h = harness();
    h.fetch.mockRejectedValue(new TypeError('network offline'));
    await h.dispatch('install').done();
    expect(h.self.skipWaiting).toHaveBeenCalledOnce();
    expect(h.cache.put).not.toHaveBeenCalled();
  });

  it('deletes only obsolete AionUi caches and does not navigate clients', async () => {
    const h = harness();
    await h.dispatch('activate').done();
    expect(h.caches.delete.mock.calls).toEqual([['aionui-webui-v1'], ['aionui-webui-v2']]);
    expect(h.self.clients.claim).toHaveBeenCalledOnce();
  });

  it('serves an exact cached hash without waiting for the network', async () => {
    const h = harness();
    h.entries.set('https://example.test/aionui/assets/vendor-12345678.js', js());
    const response = await h.dispatch('fetch').response;
    expect(await response?.text()).toBe('export default 42;');
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not substitute a cached asset with a different hash', async () => {
    const h = harness();
    h.entries.set('https://example.test/aionui/assets/vendor-oldhash1.js', js());
    h.fetch.mockRejectedValue(new TypeError('offline'));
    expect((await h.dispatch('fetch').response)?.type).toBe('error');
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a 200 whose body is truncated and caches only the complete retry', async () => {
    const h = harness();
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new TypeError('ERR_CONTENT_LENGTH_MISMATCH'));
        },
      }),
      { headers: { 'Content-Type': 'application/javascript' } }
    );
    h.fetch.mockResolvedValueOnce(broken).mockResolvedValueOnce(js());
    const response = await h.dispatch('fetch').response;
    expect(await response?.text()).toBe('export default 42;');
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.cache.put).toHaveBeenCalledOnce();
  });

  it('bounds both attempts including a stalled response body', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.fetch.mockImplementation(
      async (_request, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { headers: { 'Content-Type': 'application/javascript' } }
        )
    );
    const response = h.dispatch('fetch').response;
    await vi.advanceTimersByTimeAsync(120001);
    expect((await response)?.type).toBe('error');
    expect(h.cache.put).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects HTML masquerading as a script and removes a poisoned cached entry', async () => {
    const h = harness();
    h.entries.set(
      'https://example.test/aionui/assets/vendor-12345678.js',
      new Response('<html>', {
        headers: { 'Content-Type': 'text/html' },
      })
    );
    h.fetch.mockResolvedValue(new Response('<html>', { headers: { 'Content-Type': 'text/html' } }));
    expect((await h.dispatch('fetch').response)?.type).toBe('error');
    expect(h.cache.delete).toHaveBeenCalledOnce();
    expect(h.cache.put).not.toHaveBeenCalled();
  });

  it('still serves complete downloads if cache storage is unavailable or full', async () => {
    const h = harness();
    h.caches.open.mockRejectedValueOnce(new Error('storage disabled'));
    h.fetch.mockImplementation(async () => js());
    expect((await h.dispatch('fetch').response)?.status).toBe(200);
    h.cache.put.mockRejectedValueOnce(new Error('quota exceeded'));
    expect((await h.dispatch('fetch').response)?.status).toBe(200);
  });

  it.each(['api/auth/me', 'login', 'logout', 'qr-login', 'ws', '/api/auth/me', 'https://other.test/file.js'])(
    'never intercepts private or out-of-scope request %s',
    (path) => {
      expect(harness().dispatch('fetch', path).response).toBeUndefined();
    }
  );

  it('uses cached HTML only for navigation when the network is unavailable', async () => {
    const h = harness();
    h.entries.set('https://example.test/aionui/index.html', new Response('offline page'));
    h.fetch.mockRejectedValue(new Error('offline'));
    const navigation = await h.dispatch('fetch', './', { mode: 'navigate', destination: 'document' }).response;
    expect(await navigation?.text()).toBe('offline page');
    expect((await h.dispatch('fetch').response)?.type).toBe('error');
  });
});
