/* Quorly service worker — W-1.
 *
 * Gives the editor an offline shell and makes the site installable. The caching has to be
 * conservative, because the failure we care about most is a cache that outlives a deploy:
 * this app's whole promise is that your words are safe, so hiding a fix (or serving a stale
 * editor over fresh data) is worse than not caching at all.
 *
 * Strategy
 *   HTML navigations  → network-first        a deploy can never be masked by a stale cache.
 *   /fonts/*          → cache-first          served `immutable` by _headers; cannot change.
 *   everything else   → stale-while-revalidate   instant from cache and self-healing, so a
 *                                              forgotten version bump can never pin an old
 *                                              /app.js forever.
 *
 * Only same-origin GETs are intercepted. The analytics beacon is cross-origin and passes
 * straight through; no document content ever leaves the device.
 *
 * VERSION only needs bumping when the *strategy* changes (stale-while-revalidate keeps the
 * assets themselves fresh). It also namespaces the cache, and activate deletes any
 * `quorly-*` cache that does not match.
 */

const VERSION = 'quorly-v4';
const CACHE = `quorly-static-${VERSION}`;
const SW_PATH = '/sw.js';

// Cached at install. Fonts and icons are stable and served `immutable`, so they are allowed
// to be satisfied from the HTTP cache; everything else is fetched with `cache: 'reload'` so
// a fresh deploy always lands in the cache rather than being read back from the browser.
const PRECACHE_STABLE = [
  // Only the default reading pair is precached: offline first paint must not fetch a font
  // before it can draw. The optional faces (Literature, Paperback, Screenwriter,
  // OpenDyslexic) are cached on first use by the cache-first branch below instead, so a
  // writer who never opens the menu never downloads them.
  '/fonts/inter.woff2',
  '/fonts/inter-italic.woff2',
  '/fonts/montserrat.woff2',
  '/fonts/fira-code.woff2',
  '/favicon.png',
  '/icon-192.png',
];

const PRECACHE_FRESH = [
  '/',
  '/app/',
  '/styles.css',
  '/landing.css',
  '/landing.js',
  '/stories.js',
  '/app.js',
  '/webmcp.js',
  '/vendor/marked.min.js',
  '/vendor/dompurify.min.js',
  '/manifest.webmanifest',
];

// Last-resort page, only used when the network is down and the requested page was never
// cached. Contains no script and no external requests.
const OFFLINE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — Quorly</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0e0e0e;color:#f5f6f7;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}
main{max-width:32em}h1{font-size:20px;font-weight:600}
a{color:#f5f6f7}
</style></head>
<body><main>
<h1>You're offline</h1>
<p>This page hasn't been cached yet. Your saved documents are safe in this browser — open the
editor and they will be there.</p>
<p><a href="/app/">Open the editor</a></p>
</main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One bad URL must never abort the install: a worker that fails to install gives no
    // offline support at all, which is both worse and harder to diagnose remotely than a
    // partially filled cache.
    await Promise.all([
      ...PRECACHE_STABLE.map((url) => cache.add(url).catch(() => null)),
      ...PRECACHE_FRESH.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith('quorly-') && name !== CACHE).map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch (e) {
    return;
  }
  if (url.origin !== self.location.origin) return; // the analytics beacon and anything else
  if (req.headers.has('range')) return;            // let range requests reach the network
  if (url.pathname === SW_PATH) return;            // the worker script is the browser's own job
  if (url.pathname === '/e') return;               // funnel counter: always live, never cached

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req));
  } else if (url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req));
  } else {
    event.respondWith(staleWhileRevalidate(event, req));
  }
});

function cacheable(res) {
  return !!res
    && res.status === 200
    && res.type === 'basic'
    && !/no-store/i.test(res.headers.get('cache-control') || '');
}

async function put(req, res) {
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
}

async function networkFirst(req) {
  let res = null;
  try {
    res = await fetch(req);
  } catch (e) {
    res = null; // the network is unreachable
  }

  if (res && cacheable(res)) {
    await put(req, res.clone());
    return res;
  }

  // A 4xx is an answer *about this URL*, so it passes through. A 5xx — or no network at all —
  // means trouble reaching the origin, and the locally cached copy is the better answer: a
  // proxy or origin hiccup must never replace a working offline shell with an error page.
  if (!res || res.status >= 500) {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    // Nothing stored for this exact URL: fall back to the shell it belongs to.
    let path = '/';
    try { path = new URL(req.url).pathname; } catch (e2) { /* keep '/' */ }
    const fallback = await caches.match(path.startsWith('/app') ? '/app/' : '/');
    if (fallback) return fallback;
    if (res) return res;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return res;
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (cacheable(res)) await put(req, res.clone());
    return res;
  } catch (e) {
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

function staleWhileRevalidate(event, req) {
  const network = fetch(req)
    .then(async (res) => {
      if (cacheable(res)) await put(req, res.clone());
      return res;
    })
    .catch(() => null);

  // Keep the background refresh alive even when the cached copy answers immediately.
  event.waitUntil(network);

  return caches.match(req).then(
    (cached) => cached || network.then((res) => res || new Response('', { status: 504, statusText: 'Offline' })),
  );
}
