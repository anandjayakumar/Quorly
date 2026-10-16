#!/usr/bin/env node
// Post-deploy smoke test for Quorly.
//
//   node smoke.mjs https://quorly.pages.dev
//
// Exits non-zero if anything regresses. It exists because a direct upload once stored
// assets with `Content-Type: application/octet-stream`; combined with `nosniff` the
// browser downloaded index.html instead of rendering it. Nothing in the deploy pipeline
// noticed. This does. Run it after every deploy.

const BASE = (process.argv[2] || 'https://quorly.pages.dev').replace(/\/+$/, '');

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'Accept-Encoding': 'identity' } });
  const body = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, body };
}

// --- documents -------------------------------------------------------------------

await checkDocument('/', {
  type: 'text/html',
  contains: ['never sees', 'og:image', 'rel="canonical"', 'application/ld+json', '/app/', 'rel="manifest"'],
});

await checkDocument('/app/', {
  type: 'text/html',
  contains: ['id="focusModeBtn"', 'id="editBody"', '/styles.css', '/app.js', 'noindex',
    'id="recentsSearch"', 'data-action="export-txt"', 'data-action="copy-md"',
    // W-1 / W-2: installable, and the offline cue has somewhere to render.
    'rel="manifest"', 'id="netStatus"', 'apple-touch-icon'],
});

await checkDocument('/privacy/', {
  type: 'text/html',
  contains: ['Privacy', 'No accounts, no email'],
  notContains: ['mailto:', '@quorly'],
});

// --- static assets: the exact failure class we are guarding against --------------

const assets = [
  ['/styles.css', 'text/css'],
  ['/landing.css', 'text/css'],
  ['/app.js', 'text/javascript'],
  ['/landing.js', 'text/javascript'],
  ['/sw.js', 'text/javascript'],
  ['/vendor/marked.min.js', 'text/javascript'],
  ['/vendor/dompurify.min.js', 'text/javascript'],
  ['/fonts/inter.woff2', 'font/woff2'],
  ['/fonts/lora.woff2', 'font/woff2'],
  ['/fonts/fira-code.woff2', 'font/woff2'],
  ['/og.png', 'image/png'],
  ['/icon-192.png', 'image/png'],
  ['/icon-512.png', 'image/png'],
  ['/favicon.png', 'image/png'],
  ['/quorly.png', 'image/png'],
  ['/manifest.webmanifest', 'application/manifest+json'],
  ['/robots.txt', 'text/plain'],
  ['/sitemap.xml', 'application/xml'],
];

for (const [path, expectedType] of assets) {
  try {
    const { status, headers } = await get(path);
    const type = headers.get('content-type') || '';
    record(`GET ${path}`, status === 200 && type.startsWith(expectedType),
      `status=${status} type=${type || '(none)'} expected=${expectedType}`);
    record(`nosniff ${path}`, headers.get('x-content-type-options') === 'nosniff',
      `x-content-type-options=${headers.get('x-content-type-options')}`);
  } catch (e) {
    record(`GET ${path}`, false, String(e.message || e));
  }
}

// --- editor library wiring (the shipped app.js, not just its MIME type) -----------

try {
  const { body } = await get('/app.js');
  const markers = [
    'function deleteRecent',
    'function readVersions',
    "quorly_versions_",
    'function copyMarkdown',
    'function exportText',
    // S-2a: the open document is stored once (live keys) and snapshotted only when parked.
    'function parkCurrentDocument',
    'function touchCurrentDocument',
    'function snapshotFromLiveKeys',
    // W-1 / W-2: offline registration and the offline cue.
    'function registerServiceWorker',
    "serviceWorker.register('/sw.js'",
    'function initConnectivityCue',
    // UI-17: alignment is a class. execCommand's inline style is blocked by `style-src 'self'`.
    'function applyAlignment',
    'q-align-center',
    // UI-19: the welcome sample ends with a plain "Start writing.." line.
    'Start writing..',
    // S-2b: images are downscaled and re-encoded on the way in, and oversized ones refused.
    'const MAX_IMAGE_EDGE',
    'const MAX_IMAGE_BYTES',
    'function downscaleImage',
    // M-1: anonymous funnel counters (sendBeacon to /e).
    'const FUNNEL_EVENTS',
    'function track',
    'navigator.sendBeacon',
  ];
  for (const marker of markers) {
    record(`/app.js has ${marker}`, body.includes(marker), 'missing');
  }
} catch (e) {
  record('/app.js library markers', false, String(e.message || e));
}

// --- service worker (W-1): it has to be loadable and keep the agreed strategies ----

try {
  const { status, headers, body } = await get('/sw.js');
  record('GET /sw.js', status === 200, `status=${status}`);

  // The one failure mode that outlives a deploy. `max-age=0, must-revalidate` (Pages'
  // default) is acceptable; a long max-age is not.
  const cc = headers.get('cache-control') || '';
  record('/sw.js is revalidated', /no-cache|max-age=0/.test(cc), `cache-control=${cc || '(none)'}`);

  for (const marker of ['const VERSION', "addEventListener('install'", "addEventListener('activate'",
    "addEventListener('fetch'", 'skipWaiting', 'clients.claim']) {
    record(`/sw.js has ${marker}`, body.includes(marker), 'missing');
  }

  record('/sw.js is network-first for HTML', body.includes("req.mode === 'navigate'"),
    'the navigation branch is gone — a deploy could be masked by a stale cache');
  record('/sw.js is cache-first only for fonts', body.includes("startsWith('/fonts/')"),
    'the immutable-asset branch is gone');
  record('/sw.js never touches cross-origin', body.includes('url.origin !== self.location.origin'),
    'the cross-origin guard is gone — the analytics beacon must pass through untouched');
  record('/sw.js falls back to cache on 5xx', body.includes('res.status >= 500'),
    'an origin or proxy 5xx would replace a working offline shell with an error page');
  record('/sw.js leaves its own script alone', body.includes('url.pathname === SW_PATH'),
    'the worker script must be left to the browser, never served from its own cache');
} catch (e) {
  record('/sw.js', false, String(e.message || e));
}

// --- web app manifest (W-2): installability fields --------------------------------

try {
  const { status, body } = await get('/manifest.webmanifest');
  const m = JSON.parse(body);
  record('manifest is valid JSON', status === 200, `status=${status}`);
  record('manifest start_url is /app/', m.start_url === '/app/', `start_url=${m.start_url}`);
  record('manifest scope is /', m.scope === '/', `scope=${m.scope}`);
  record('manifest display is standalone', m.display === 'standalone', `display=${m.display}`);
  record('manifest colours match the dark theme',
    m.theme_color === '#0e0e0e' && m.background_color === '#0e0e0e',
    `theme=${m.theme_color} background=${m.background_color}`);
  const icons = m.icons || [];
  record('manifest has 192 and 512 icons',
    icons.some((i) => i.sizes === '192x192') && icons.some((i) => i.sizes === '512x512'),
    `${icons.length} icons`);
  record('manifest has a maskable icon', icons.some((i) => (i.purpose || '').includes('maskable')),
    'no maskable icon — Android will letterbox the icon');
} catch (e) {
  record('manifest', false, String(e.message || e));
}

// --- HTML must stay revalidated, worker or no worker ------------------------------

for (const path of ['/', '/app/']) {
  try {
    const { headers } = await get(path);
    const cc = headers.get('cache-control') || '';
    record(`${path} HTML is revalidated`, /max-age=0|no-cache|no-store/.test(cc),
      `cache-control=${cc || '(none)'} — a pinned document could mask a deploy`);
  } catch (e) {
    record(`${path} HTML cache-control`, false, String(e.message || e));
  }
}

// --- security headers ------------------------------------------------------------

try {
  const { headers } = await get('/');
  const csp = headers.get('content-security-policy') || '';
  record('CSP present', csp.includes("default-src 'none'"), csp.slice(0, 60) || '(none)');
  record('CSP has no unsafe-inline', !csp.includes('unsafe-inline'), 'unsafe-inline present');
  record('CSP allows analytics beacon', csp.includes('https://static.cloudflareinsights.com'),
    'beacon origin missing — Web Analytics will not report');
  record("CSP allows same-origin reads", csp.includes("connect-src 'self'"),
    "connect-src must include 'self' so /robots.txt and /sitemap.xml stay readable");
  // Both directives fall back to default-src, which is 'none'.
  record('CSP allows the web app manifest', csp.includes("manifest-src 'self'"),
    "manifest-src 'self' required — without it the manifest is blocked and the app is not installable");
  record('CSP allows the service worker', csp.includes("worker-src 'self'"),
    "worker-src 'self' required or navigator.serviceWorker.register() is refused");
  record('X-Frame-Options DENY', headers.get('x-frame-options') === 'DENY',
    `x-frame-options=${headers.get('x-frame-options')}`);
  record('Referrer-Policy no-referrer', headers.get('referrer-policy') === 'no-referrer',
    `referrer-policy=${headers.get('referrer-policy')}`);
} catch (e) {
  record('security headers', false, String(e.message || e));
}

// --- funnel endpoint (M-1): same-origin, anonymous, fail-open ------------------------

// POST -> 204. The body deliberately carries a name that is NOT in the function's allowlist, so
// running this gate against production can never write a fake event into the funnel dataset — the
// contract being checked (204 + no-store) is identical for an accepted, a rejected or an unbound
// request. Unbound locally (the Analytics Engine binding cannot be used with `wrangler pages dev`),
// which is the no-write case the handler must tolerate.
try {
  const res = await fetch(BASE + '/e', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ e: 'smoke-check', format: 'smoke' }),
  });
  record('POST /e answers 204', res.status === 204, `status=${res.status}`);
  record('/e is not cached', /no-store/i.test(res.headers.get('cache-control') || ''),
    `cache-control=${res.headers.get('cache-control') || '(none)'}`);
} catch (e) {
  record('POST /e', false, String(e.message || e));
}

try {
  const { status } = await get('/e');
  record('GET /e is refused', status === 405, `status=${status} (expected 405)`);
} catch (e) {
  record('GET /e', false, String(e.message || e));
}

// The Function source is not an asset; it must never be downloadable.
try {
  const { status } = await get('/functions/e.js');
  record('/functions/e.js is not public', status === 404, `status=${status} (expected 404)`);
} catch (e) {
  record('/functions/e.js is not public', false, String(e.message || e));
}

// --- metafiles and unknown paths must NOT be public -------------------------------

for (const path of ['/README.md', '/_headers', '/.assetsignore', '/smoke.mjs', '/does-not-exist-xyz']) {
  try {
    const { status } = await get(path);
    record(`${path} is not public`, status === 404, `status=${status} (expected 404)`);
  } catch (e) {
    record(`${path} is not public`, false, String(e.message || e));
  }
}

// --- report ----------------------------------------------------------------------

async function checkDocument(path, { type, contains, notContains = [] }) {
  try {
    const { status, headers, body } = await get(path);
    const ct = headers.get('content-type') || '';
    record(`GET ${path}`, status === 200 && ct.startsWith(type), `status=${status} type=${ct}`);
    for (const needle of contains) {
      record(`${path} contains ${JSON.stringify(needle)}`, body.includes(needle), 'missing marker');
    }
    for (const needle of notContains) {
      record(`${path} omits ${JSON.stringify(needle)}`, !body.includes(needle), 'found but should be absent');
    }
  } catch (e) {
    record(`GET ${path}`, false, String(e.message || e));
  }
}

const pad = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(pad)}  ${r.ok ? '' : r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed against ${BASE}`);
process.exit(failed ? 1 : 0);
