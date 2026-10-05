const CACHE_NAME = 'aionui-webui-v3';
const SCOPE_URL = new URL('./', self.location.href);
const OFFLINE_PAGE_URL = new URL('./index.html', SCOPE_URL).toString();
const PRECACHE_URLS = [
  OFFLINE_PAGE_URL,
  new URL('./manifest.webmanifest', SCOPE_URL).toString(),
  new URL('./pwa/icon-192.png', SCOPE_URL).toString(),
  new URL('./pwa/icon-512.png', SCOPE_URL).toString(),
];

// fetch() resolves at the headers, before a truncated body fails. Validate the
// whole response within the deadline before returning or caching executable code.
async function fetchComplete(request, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(request, { signal: controller.signal, cache: 'no-cache' });
    await response.clone().arrayBuffer();
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function openCache() {
  try {
    return await caches.open(CACHE_NAME);
  } catch (error) {
    console.warn('[PWA] Cache unavailable; using network', error);
    return undefined;
  }
}

async function storeResponse(cache, request, response) {
  if (!cache || !response.ok || response.redirected) return;
  try {
    await cache.put(request, response.clone());
  } catch (error) {
    console.warn('[PWA] Could not cache response', request.url || request, error);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openCache();
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetchComplete(url, 15000);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            await storeResponse(cache, url, response);
          } catch (error) {
            // Optional offline resources must not prevent installing the fix.
            console.warn('[PWA] Precache failed', url, error);
          }
        })
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.filter((key) => /^aionui-webui-v[12]$/.test(key)).map((key) => caches.delete(key)));
      } catch (error) {
        console.warn('[PWA] Could not remove obsolete caches', error);
      }
      // Do not navigate open tabs: activation must not discard unsent drafts.
      await self.clients.claim();
    })()
  );
});

function shouldHandleRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== SCOPE_URL.origin || !url.pathname.startsWith(SCOPE_URL.pathname)) return false;
  const path = url.pathname.slice(SCOPE_URL.pathname.length);
  return !/^(?:api(?:\/|$)|login(?:\/|$)|logout(?:\/|$)|qr-login(?:\/|$)|ws(?:\/|$))/.test(path);
}

function isAssetContentTypeMismatch(request, response) {
  const contentType = response.headers.get('content-type') || '';
  if (request.destination === 'script') return !/javascript|ecmascript|wasm/i.test(contentType);
  if (request.destination === 'style') return !/css/i.test(contentType);
  return false;
}

async function networkFirst(request) {
  const cache = await openCache();
  try {
    const response = await fetchComplete(request, 15000);
    await storeResponse(cache, request, response);
    return response;
  } catch (error) {
    console.warn('[PWA] Navigation failed; trying offline copy', request.url, error);
    return (await cache?.match(request)) || (await cache?.match(OFFLINE_PAGE_URL)) || Response.error();
  }
}

async function loadAsset(request) {
  const cache = await openCache();
  const url = new URL(request.url);
  // Content-hashed build files are immutable. Exact-URL matching prevents
  // mixing versions; never substitute another hash or an HTML fallback.
  const immutable = /\/assets\/[^/]+-[\w-]{8,}\.(?:js|css)$/.test(url.pathname);
  const cached = await cache?.match(request);
  if (cached && !isAssetContentTypeMismatch(request, cached) && immutable) return cached;
  if (cached && isAssetContentTypeMismatch(request, cached)) await cache.delete(request);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetchComplete(request);
      if (!response.ok || response.redirected || isAssetContentTypeMismatch(request, response)) {
        console.warn('[PWA] Invalid asset response', request.url, response.status);
        return Response.error();
      }
      await storeResponse(cache, request, response);
      return response;
    } catch (error) {
      console.warn('[PWA] Asset download failed', request.url, attempt + 1, error);
    }
  }
  return Response.error();
}

async function staleWhileRevalidate(request, event) {
  const cache = await openCache();
  const cached = await cache?.match(request);
  const network = fetchComplete(request)
    .then(async (response) => {
      await storeResponse(cache, request, response);
      return response;
    })
    .catch((error) => {
      console.warn('[PWA] Resource download failed', request.url, error);
      return Response.error();
    });
  event.waitUntil(network.then(() => undefined));
  return cached || network;
}

self.addEventListener('fetch', (event) => {
  if (!shouldHandleRequest(event.request)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request));
  } else if (['script', 'style'].includes(event.request.destination)) {
    event.respondWith(loadAsset(event.request));
  } else if (['image', 'font'].includes(event.request.destination)) {
    event.respondWith(staleWhileRevalidate(event.request, event));
  }
});
