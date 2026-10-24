#!/usr/bin/env node
// Post-deploy smoke test for Quorly.
//
//   node smoke.mjs https://quorly.dev
//
// Exits non-zero if anything regresses. It exists because a direct upload once stored
// assets with `Content-Type: application/octet-stream`; combined with `nosniff` the
// browser downloaded index.html instead of rendering it. Nothing in the deploy pipeline
// noticed. This does. Run it after every deploy.

const BASE = (process.argv[2] || 'https://quorly.dev').replace(/\/+$/, '');

// Cloudflare Access service token (optional). When previews/production are protected by
// Access, set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the environment so smoke
// requests authenticate. Absent => no headers (works against unprotected hosts).
const ACCESS_HEADERS = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  ACCESS_HEADERS['CF-Access-Client-Id'] = process.env.CF_ACCESS_CLIENT_ID;
  ACCESS_HEADERS['CF-Access-Client-Secret'] = process.env.CF_ACCESS_CLIENT_SECRET;
}

const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: { 'Accept-Encoding': 'identity', ...ACCESS_HEADERS } });
  const body = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, body };
}

// --- documents -------------------------------------------------------------------

await checkDocument('/', {
  type: 'text/html',
  contains: ['keeps your words on your device', 'og:image', 'rel="canonical"', 'application/ld+json', '/app/', 'rel="manifest"',
    // SEO hygiene pass: accurate category title/description, a WebApplication + FAQPage graph,
    // and the Markdown alternate used by the agent mirror.
    'Private Offline Text Editor', 'The private, offline text editor', '"@type": "WebApplication"', '"@type": "FAQPage"',
    'rel="alternate" type="text/markdown"',
    // Accuracy: the copy must not advertise features that no longer exist.
    'Everything you need to finish a draft', 'Minimal. Powerful. Yours.',
    // The logo images must describe themselves.
    'alt="Quorly private editor logo"',
    // The published contact address must survive to the reader. On the custom domain
    // Cloudflare rewrites an unprotected address into an obfuscated `__cfemail__` link,
    // which hides it and breaks the mailto: — so this is the tripwire for that.
    'mailto:hello@quorly.dev',
    // Internal link: the homepage points at the comparison page with descriptive anchor text.
    'See how Quorly compares to Typora',
    '/compare/typora/',
    '/compare/calmlywriter/',
    'Compare pages'],
  notContains: ['Version history', 'no tracking', '__cfemail__', 'email-protection#'],
});

await checkDocument('/index.md', {
  type: 'text/markdown',
  contains: ['# Quorly', '](https://quorly.dev/app/)', 'Focus Mode', 'Is Quorly really free?'],
  notContains: ['Version history'],
});

await checkDocument('/app/', {
  type: 'text/html',
  contains: ['id="focusModeBtn"', 'id="editBody"', '/styles.css', '/app.js', 'noindex',
    'id="recentsSearch"',    // DD-03: the storage layer must be in the document, and before /app.js.
    '/stories.js',
    // W-1 / W-2: installable, and the offline cue has somewhere to render.
    'rel="manifest"', 'id="netStatus"', 'apple-touch-icon',
    // WebMCP: the tool layer must ship, and after /app.js so its globals exist.
    '/webmcp.js'],
});

await checkDocument('/privacy/', {
  type: 'text/html',
  contains: ['Privacy', 'No accounts', 'hello@quorly.dev', 'mailto:hello@quorly.dev'],
  notContains: ['legal@', 'support@', 'Version History', 'doc_versions_v13', '__cfemail__', 'email-protection#'],
});

// The privacy notice has to stay true: the editor's own counter must be disclosed, and the
// old wording ("the only thing we measure is anonymous page visits") must not come back.
await checkDocument('/privacy/', {
  type: 'text/html',
  contains: ['Quorly also counts basic usage events', 'Cloudflare Web Analytics', 'do not include your writing'],
  notContains: ['The only thing we measure is anonymous page visits'],
});

await checkDocument('/compare/', {
  type: 'text/html',
  contains: [
    'Quorly vs',
    'Dillinger',
    'StackEdit',
    'CalmlyWriter',
    'https://quorly.dev/compare/',
    'https://typora.io/',
    'target="_blank" rel="noopener"',
    'Offline',
    'No account',
    'IndexedDB',
    'Radical transparency',
    'Frequently asked questions',
    'application/ld+json',
    '"@type": "FAQPage"',
    '"@type": "SoftwareApplication"',
    'What is the best free browser-based alternative to Typora?',
    'Free, Private Alternative',
    '/compare/typora/',
    '/compare/calmlywriter/',
    'Compare pages',
    '/landing.js',
  ],
  notContains: ['quorly.pages.dev', 'style="', 'onclick=', 'onload=', 'onerror='],
});

await checkDocument('/compare/typora/', {
  type: 'text/html',
  contains: [
    'Quorly vs Typora',
    'https://typora.io/',
    'https://store.typora.io/',
    'target="_blank" rel="noopener"',
    'https://quorly.dev/compare/typora/',
    'Free Browser Alternative',
    'Free, no tiers',
    '$14.99',
    'IndexedDB',
    'Radical transparency',
    'Frequently asked questions',
    'application/ld+json',
    '"@type": "FAQPage"',
    '"@type": "SoftwareApplication"',
    'Back to full comparison',
    '/landing.js',
  ],
  notContains: ['quorly.pages.dev', 'style="', 'onclick=', 'onload=', 'onerror=', 'no tracking'],
});

await checkDocument('/compare/calmlywriter/', {
  type: 'text/html',
  contains: [
    'Quorly vs CalmlyWriter',
    'https://calmlywriter.com/',
    'target="_blank" rel="noopener"',
    'https://quorly.dev/compare/calmlywriter/',
    'Free Browser Alternative',
    'Free, no tiers',
    '$23.90',
    'IndexedDB',
    'Radical transparency',
    'Frequently asked questions',
    'application/ld+json',
    '"@type": "FAQPage"',
    '"@type": "SoftwareApplication"',
    'Back to full comparison',
    '/landing.js',
  ],
  notContains: ['quorly.pages.dev', 'style="', 'onclick=', 'onload=', 'onerror=', 'no tracking'],
});

// --- agent discovery surface (llms.txt, skill, catalogs, robots signal) -----------

await checkDocument('/llms.txt', {
  type: 'text/plain',
  contains: ['# Quorly', '](https://quorly.dev/agent-skill.md)', 'WebMCP'],
});
await checkDocument('/agent-skill.md', {
  type: 'text/markdown',
  contains: ['name: quorly-editor', 'get_document', 'append_content', 'consequentialHint'],
});
await checkDocument('/AGENTS.md', {
  type: 'text/markdown',
  contains: ['# AGENTS.md', 'Strict CSP', 'webmcp.js'],
});

try {
  const { body, headers } = await get('/llms.txt');
  record('/llms.txt starts with an H1', body.startsWith('# '), body.slice(0, 20));
  record('/llms.txt has a markdown link', /\]\(https:\/\//.test(body), 'no link');
  record('/llms.txt is at least 50 characters', body.length >= 50, `length=${body.length}`);
  record('nosniff /llms.txt', headers.get('x-content-type-options') === 'nosniff', '');
} catch (e) {
  record('/llms.txt structure', false, String(e.message || e));
}

for (const path of ['/.well-known/ai-catalog.json', '/.well-known/ard.json']) {
  try {
    const { status, headers, body } = await get(path);
    const type = headers.get('content-type') || '';
    record(`GET ${path}`, status === 200, `status=${status}`);
    record(`${path} is JSON`, type.startsWith('application/json'), `type=${type}`);
    record(`nosniff ${path}`, headers.get('x-content-type-options') === 'nosniff', '');
    const doc = JSON.parse(body);
    const entry = Array.isArray(doc.entries) ? doc.entries[0] : null;
    record(`${path} has an ARD entry`, !!(entry && entry.identifier && entry.displayName && entry.type && entry.url), 'missing required fields');
    record(`${path} identifier is a domain URN`, !!entry && /^urn:air:quorly\.dev:/.test(entry.identifier || ''), entry ? entry.identifier : 'none');
    record(`${path} entry is an agent skill`, !!entry && entry.type === 'application/agent-skills+md', entry ? entry.type : 'none');
    const queries = entry && Array.isArray(entry.representativeQueries) ? entry.representativeQueries.length : 0;
    record(`${path} has 2-5 representative queries`, queries >= 2 && queries <= 5, `count=${queries}`);
  } catch (e) {
    record(`agent catalog ${path}`, false, String(e.message || e));
  }
}

try {
  const { status, headers, body } = await get('/.well-known/security.txt');
  const type = headers.get('content-type') || '';
  record('/.well-known/security.txt is served', status === 200, `status=${status}`);
  record('security.txt is text/plain', type.startsWith('text/plain'), `type=${type}`);
  record('security.txt has Contact and Canonical',
    /^Contact: mailto:hello@quorly\.dev$/m.test(body) && body.includes('Canonical: https://quorly.dev/.well-known/security.txt'),
    'contact or canonical missing');
  const expires = (body.match(/^Expires: (.+)$/m) || [])[1];
  record('security.txt Expires is in the future', !!expires && Date.parse(expires) > Date.now(), `expires=${expires || '(none)'}`);
} catch (e) {
  record('security.txt', false, String(e.message || e));
}

try {
  const { body } = await get('/robots.txt');
  record('/robots.txt has the Content-Signal', body.includes('Content-Signal: search=yes, ai-input=yes, ai-train=no'), 'missing');
  record('/robots.txt advertises the Agentmap', body.includes('Agentmap: https://quorly.dev/.well-known/ard.json'), 'missing');
  record('/robots.txt groups AI crawlers', body.includes('User-agent: GPTBot') && body.includes('User-agent: ClaudeBot'), 'missing');
  record('/robots.txt still allows everything', /User-agent: \*\r?\nAllow: \//.test(body), 'base group changed');
} catch (e) {
  record('/robots.txt agent directives', false, String(e.message || e));
}

// --- static assets: the exact failure class we are guarding against --------------

const assets = [
  ['/styles.css', 'text/css'],
  ['/landing.css', 'text/css'],
  ['/app.js', 'text/javascript'],
  ['/stories.js', 'text/javascript'],
  ['/webmcp.js', 'text/javascript'],
  ['/landing.js', 'text/javascript'],
  ['/sw.js', 'text/javascript'],
  ['/vendor/marked.min.js', 'text/javascript'],
  ['/vendor/dompurify.min.js', 'text/javascript'],
  ['/fonts/inter.woff2', 'font/woff2'],
  ['/fonts/montserrat.woff2', 'font/woff2'],
  ['/fonts/literata.woff2', 'font/woff2'],
  ['/fonts/crimson-pro.woff2', 'font/woff2'],
  ['/fonts/courier-prime.woff2', 'font/woff2'],
  ['/fonts/opendyslexic.woff2', 'font/woff2'],
  ['/fonts/fira-code.woff2', 'font/woff2'],
  ['/fonts/lora.woff2', 'font/woff2'],
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
    // UI-19: the welcome sample ends with a plain "Start writing..." line.
    'Start writing...',
    // S-2b: images are downscaled and re-encoded on the way in, and oversized ones refused.
    'const MAX_IMAGE_EDGE',
    'const MAX_IMAGE_BYTES',
    'function downscaleImage',
    // M-1: anonymous funnel counters (sendBeacon to /e).
    'const FUNNEL_EVENTS',
    'function track',
    'navigator.sendBeacon',
    // DD-03 (IDB-1/2/3): storage goes through the adapter, so a backend swap changes no caller.
    // These four are the read paths the library actually depends on.
    'QuorlyStore.putSnapshot',
    'QuorlyStore.getSnapshot',
    'QuorlyStore.listVersions',
    'QuorlyStore.appendVersion',
    // WebMCP shares the import pipeline; agent text is sanitized the same way.
    'function markdownToClean',
    // N-7: paste is rebuilt block by block before it reaches the document (tables included), and the
    // same normaliser is what the importers call. A stale or partial /app.js must fail here.
    'function normalizePastedHTML',
    'function plainTextToHTML',
    'function pasteTable',
    "addEventListener('paste'",
    // N-4: the export menu uses role="menuitem" while the other menus use role="option"; a role
    // selector in the shared click handler silently made every export option a no-op.
    'options().includes(li)',
    // N-29: every export shares one slug, and print reuses it as the suggested PDF filename.
    'function documentSlug()',
    'document.title = documentSlug();',
    'suggestedName: `${slug}.quorly`',
    'preparePrintTitle();',
    'restorePrintTitle();',
    // H-1: strict title-image validation and safe application (no direct img.src assignment without validation).
    'function isValidTitleImageSrc',
    'function applyTitleImage',
    'function setTitleImage(src)',
    'isValidTitleImageSrc',
  ];
  for (const marker of markers) {
    record(`/app.js has ${marker}`, body.includes(marker), 'missing');
  }
  // N-12: Formatting section must sit before Recents after a layout switch.
  record('/app.js uses sidebar-recents anchor', body.includes("panel.querySelector('.sidebar-recents')"), 'missing anchor');
  // H-1: exported HTML has CSP meta, escaped src, clamped width, and encoded markdown URL.
  record('/app.js export includes CSP meta', body.includes("http-equiv=\"Content-Security-Policy\""), 'missing CSP meta');
  record('/app.js generates escaped title src', body.includes('escapeHtml(titleImageData.src)'), 'missing escaped src');
  record('/app.js clamps title width safely', body.includes('function safeTitleImageWidth'), 'missing width clamp');
  record('/app.js encodes markdown image URL', body.includes('encodeURI'), 'missing encodeURI');
  record('/app.js has no dead insertSection lookup', !body.includes("getElementById('insertSection')"), 'dead reference still present');
} catch (e) {
  record('/app.js library markers', false, String(e.message || e));
}

try {
  const { body } = await get('/app.js');
  const dialogMarkers = [
    'quorlyConfirm',
    'quorlyPrompt',
    'showModal',
  ];
  for (const marker of dialogMarkers) {
    record(`/app.js dialog has ${marker}`, body.includes(marker), 'missing');
  }
  record(`/app.js no longer has native confirm delete`, !body.includes("confirm('Delete"), 'still present');
  record(`/app.js no longer has native URL prompt`, !body.includes("prompt('Enter URL:"), 'still present');
} catch (e) {
  record('/app.js dialog markers', false, String(e.message || e));
}

// --- N-11: paste fix — Range + DocumentFragment insertion -------------------

// --- print flow markers (N-4): natural pagination, clone padding --------------
try {
  const { body } = await get('/styles.css');
  const markers = [
    'box-decoration-break: clone',
    '-webkit-box-decoration-break: clone',
    '@page { size: A4; margin: 0; }',
    'body.q-app .reader {\n    padding: 16mm 15mm;',
    '\n    -webkit-print-color-adjust: exact !important;',
    '\n    print-color-adjust: exact !important;',
  ];
  for (const marker of markers) {
    // Multi-line markers are pinned exactly but labelled on one line.
    record(`/styles.css has ${marker.replace(/\s*\n\s*/g, ' ')}`, body.includes(marker), 'missing');
  }
} catch (e) {
  record('/styles.css print markers', false, String(e.message || e));
}

// --- WebMCP tool layer (W3C CG draft) -------------------------------------------

try {
  const { status, body } = await get('/webmcp.js');
  record('GET /webmcp.js', status === 200, `status=${status}`);

  const markers = [
    // Both entry points: spec draft on `document`, legacy on `navigator`.
    'document.modelContext',
    'navigator.modelContext',
    'registerTool',
    // Tools are torn down with a signal — the draft has no unregisterTool.
    'AbortController',
    // Safety annotations the spec defines.
    'readOnlyHint',
    'untrustedContentHint',
    'consequentialHint',
    // Destructive paths keep a human confirmation step in the page (with fallback).
    'quorlyConfirm',
  ];
  for (const marker of markers) {
    record(`/webmcp.js has ${marker}`, body.includes(marker), 'missing');
  }
} catch (e) {
  record('/webmcp.js markers', false, String(e.message || e));
}

// --- the storage layer (DD-03): the library is in IndexedDB, images are content-addressed ----

try {
  const { status, body } = await get('/stories.js');
  record('GET /stories.js', status === 200, `status=${status}`);

  const markers = [
    'indexedDB.open',
    'STORE_BLOBS',
    'STORE_SNAPSHOTS',
    'STORE_VERSIONS',
    // One name for every key this module owns, so app.js never has to know them.
    'LS_SNAPSHOT_PREFIX',
    'LS_VERSIONS_PREFIX',
    // Images: a data URL becomes a content-addressed blob, and comes back as a data URL.
    'quorly-blob:',
    'window.crypto.subtle',
    'function refsToDataURLs',
    'function dataURLsToRefs',
    // Nothing is deleted before its replacement is durable, and reads adopt on their own.
    'function adoptSnapshot',
    'function adoptVersions',
    'function sweepBlobs',
    // DD-03 (IDB-4): asking the browser to keep this origin's data, and reading back the answer.
    'function persisted',
    'window.QuorlyStore',
  ];
  for (const marker of markers) {
    record(`/stories.js has ${marker}`, body.includes(marker), 'missing');
  }

  // The one rule the DOM depends on: a blob reference must never reach a caller.
  record('/stories.js hydrates before returning', body.includes('return await hydrateImages(rec)'),
    'a stored blob reference could reach the DOM, where img-src has no blob:');
} catch (e) {
  record('/stories.js', false, String(e.message || e));
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
  // DD-03: without this, an offline first paint has the editor but not its storage layer.
  record('/sw.js precaches the storage layer', body.includes("'/stories.js'"),
    'an offline session would load /app.js against a missing QuorlyStore');
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
  // L-5: Cloudflare Web Analytics is enabled, so "no tracking" overclaims.
  record('manifest does not claim "no tracking"', !/no tracking/i.test(m.description || ''),
    `description=${m.description || '(none)'}`);
  record('manifest words privacy accurately', /no cookies/i.test(m.description || ''),
    `description=${m.description || '(none)'}`);
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
  // L-2: the editor must not share a browsing-context group with a cross-origin opener.
  record('Cross-Origin-Opener-Policy same-origin', headers.get('cross-origin-opener-policy') === 'same-origin',
    `coop=${headers.get('cross-origin-opener-policy') || '(none)'}`);
  // L-3: `tools` is not an implemented Permissions-Policy feature; it only logged a warning.
  const pp = headers.get('permissions-policy') || '';
  record('Permissions-Policy has no tools directive', !/(^|,)\s*tools\s*=/.test(pp), pp || '(none)');
  record('Permissions-Policy still disables powerful features',
    /geolocation=\(\)/.test(pp) && /microphone=\(\)/.test(pp) && /camera=\(\)/.test(pp), pp || '(none)');
} catch (e) {
  record('security headers', false, String(e.message || e));
}

// --- L-2: CORP is scoped, never global (social previews must keep working) --------
for (const path of ['/app/', '/app.js', '/styles.css']) {
  try {
    const { headers } = await get(path);
    record(`CORP same-origin on ${path}`, headers.get('cross-origin-resource-policy') === 'same-origin',
      `corp=${headers.get('cross-origin-resource-policy') || '(none)'}`);
  } catch (e) {
    record(`CORP ${path}`, false, String(e.message || e));
  }
}

try {
  const { headers } = await get('/og.png');
  record('/og.png stays embeddable (no CORP)', !headers.get('cross-origin-resource-policy'),
    `corp=${headers.get('cross-origin-resource-policy') || '(none)'}`);
} catch (e) {
  record('/og.png CORP', false, String(e.message || e));
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
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...ACCESS_HEADERS },
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

// M-2: the cap and the origin check must still fail open (204, no body, no CORS grant).
try {
  const res = await fetch(BASE + '/e', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...ACCESS_HEADERS },
    body: 'x'.repeat(4096),
  });
  record('POST /e caps an oversized body', res.status === 204, `status=${res.status}`);
} catch (e) {
  record('POST /e oversized body', false, String(e.message || e));
}

try {
  const res = await fetch(BASE + '/e', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8', Origin: 'https://evil.example', ...ACCESS_HEADERS },
    body: JSON.stringify({ e: 'smoke-check', format: 'smoke' }),
  });
  record('POST /e drops a cross-origin beacon', res.status === 204 && !res.headers.get('access-control-allow-origin'),
    `status=${res.status} acao=${res.headers.get('access-control-allow-origin') || '(none)'}`);
} catch (e) {
  record('POST /e cross-origin beacon', false, String(e.message || e));
}

// The Function source is not an asset; it must never be downloadable.
try {
  const { status } = await get('/functions/e.js');
  record('/functions/e.js is not public', status === 404, `status=${status} (expected 404)`);
} catch (e) {
  record('/functions/e.js is not public', false, String(e.message || e));
}

// --- N-11: paste fix — markers only ----------------------------------------------
// The real test is tools/paste-test.js, which runs inside the editor page and drives a
// genuine paste and a genuine Ctrl+Z. These markers only prove the code shape.

try {
  const { body } = await get('/app.js');
  record('N-11 Range-based insertion', body.includes('range.deleteContents') && body.includes('range.insertNode'),
    'Range.deleteContents / range.insertNode missing');
  record('N-11 app-level paste undo', body.includes('pasteUndo') && body.includes('replaceChildren'),
    'paste undo record missing');
  record('N-11 paste undo disarmed on a native edit', body.includes('beforeinput'),
    'beforeinput guard missing');
} catch (e) {
  record('N-11 paste fix markers', false, String(e.message || e));
}

// --- metafiles and unknown paths must NOT be public -------------------------------
// 404 means the file is not in the artifact. 403 means the edge refused it: the zone
// carries a WAF custom rule (M-6) blocking /.github/, because Pages can keep serving a
// removed asset from a deployment that still holds it until the asset's own cache TTL
// runs out. Either status means the bytes are unreachable, which is the actual invariant.

const NOT_PUBLIC = new Set([403, 404]);

for (const path of ['/README.md', '/_headers', '/.assetsignore', '/smoke.mjs', '/package.json', '/package-lock.json', '/.github/workflows/ci.yml', '/does-not-exist-xyz']) {
  try {
    const { status } = await get(path);
    const how = status === 404 ? 'not found' : status === 403 ? 'blocked at the edge' : 'SERVED';
    record(`${path} is not public`, NOT_PUBLIC.has(status), `status=${status} (${how}); expected 403 or 404`);
  } catch (e) {
    record(`${path} is not public`, false, String(e.message || e));
  }
}

// --- H-2 / M-3 / M-4 regression checks ----------------------------------------
try {
  const { body: vendBody } = await get('/vendor/dompurify.min.js');
  record('/vendor/dompurify.min.js contains 3.4.17', vendBody.includes('3.4.17'), 'version missing');
} catch (e) {
  record('/vendor/dompurify.min.js check', false, String(e.message || e));
}

try {
  const { body: markedBody } = await get('/vendor/marked.min.js');
  record('/vendor/marked.min.js is 18.1.1', markedBody.includes('marked v18.1.1'), 'version missing');
} catch (e) {
  record('/vendor/marked.min.js check', false, String(e.message || e));
}

try {
  const { body: appBody } = await get('/app.js');
  record('/app.js contains RETURN_DOM_FRAGMENT: true', appBody.includes('RETURN_DOM_FRAGMENT: true'), 'missing');
  record('/app.js contains afterSanitizeAttributes', appBody.includes('afterSanitizeAttributes'), 'missing');
  record('/app.js contains noopener noreferrer', appBody.includes('noopener noreferrer'), 'missing');
  record('/app.js contains sanitizeToFragment', appBody.includes('sanitizeToFragment'), 'missing');
  record('/app.js contains replaceChildren', appBody.includes('replaceChildren'), 'missing');
  record('/app.js no longer has editBody.innerHTML = temp.innerHTML', !appBody.includes('editBody.innerHTML = temp.innerHTML'), 'old double-parse still present');
  record('/app.js no longer has container.innerHTML = sanitizeHTML(insert)', !appBody.includes('container.innerHTML = sanitizeHTML(insert)'), 'old double-parse still present');
  record('/app.js no longer has the fail-open sanitizer fallback', !appBody.includes('t.innerHTML = String(html)'), 'fail-open fallback still present');
  record('/app.js forbids media and form tags on import', appBody.includes("'video', 'audio', 'source', 'track'") && appBody.includes("'input', 'button', 'select', 'textarea'"), 'FORBID_TAGS incomplete');
} catch (e) {
  record('/app.js H-2/M-3/M-4 markers', false, String(e.message || e));
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
