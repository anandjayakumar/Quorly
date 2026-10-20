# Quorly — static web build

A single-user, browser-based writer/editor. Everything runs client-side; documents are
stored in the visitor's `localStorage`, and optional "Sync to Disk" uses the File System
Access API.

This folder is the split, CSP-hardened build, **ready to deploy to Cloudflare Pages**.

## Layout

```
index.html             landing page (marketing, SEO head, JSON-LD)  ->  /
landing.css            landing-page styles
app/index.html         the editor                                     ->  /app/
styles.css             editor styles + self-hosted @font-face rules
app.js                 all editor behaviour (external, loaded with defer)
privacy/index.html     privacy policy                                 ->  /privacy/
404.html               served by Cloudflare for unmatched paths
vendor/                marked 15.0.12 + DOMPurify 3.2.4 (vendored, no CDN)
fonts/*.woff2          self-hosted variable webfonts
quorly.png             brand mark
favicon.png            site icon
icon-192.png           PWA icons (generated)
icon-512.png
og.png                 social card, 1200x630 (generated)
manifest.webmanifest   PWA manifest
sw.js                  service worker: offline shell (must stay at the root for scope /)
robots.txt / sitemap.xml
_headers               Cloudflare security + caching headers
smoke.mjs              post-deploy verification (not published)
```

The editor lives at `/app/` and references every asset with an **absolute** path
(`/styles.css`, `/vendor/...`), so it does not depend on being served from the root.
`@font-face` URLs in the CSS resolve relative to `/styles.css`, which stays at the root.

## Network activity: exactly one third-party request

The editor makes **no network requests at all**. Fonts, scripts, styles and images are
same-origin, and the page never calls `fetch`, `XMLHttpRequest` or `sendBeacon`.

The one exception is **Cloudflare Web Analytics**, loaded for anonymous visit counts. It
fetches `beacon.min.js` from `static.cloudflareinsights.com` and beacons to
`cloudflareinsights.com`. `connect-src` also keeps `'self'`, which is not used by the app
but is required for the origin to read its own `/robots.txt` and `/sitemap.xml` (without it
Lighthouse reports "robots.txt is not valid"). No document content is ever transmitted, and
no cookies are set.

The service worker does not change this. It only ever caches **same-origin** responses and skips
every cross-origin request, so the beacon passes through untouched; it adds no requests beyond
re-fetching the app's own files.

The AI **Write-Assist** feature is absent from this build. There is no API call, no API key
prompt, and no model IDs anywhere in the shipped code.

## Deploy

### Cloudflare Pages (current production)

The app is a git repo, and deploys go through `tools/release/release.mjs`. Commits on `dev` run the
smoke gate and, if it passes, deploy a preview automatically — detached, so committing is never
blocked. Production is **only** ever promoted by hand. Design and rationale:
`docs/QUORLY_RELEASE_PIPELINE.md` in the project docs.

```sh
node tools/release/release.mjs run                     # snapshot HEAD -> gate -> preview -> verify alias -> prune
node tools/release/release.mjs run --dry-run           # gate only, deploy nothing
node tools/release/release.mjs status                  # the last run's result (.release/status.json)
node tools/release/release.mjs promote --commit <sha>  # production; manual, and only for a commit that passed
```

The stage is built with `git archive <sha>`: `.gitattributes` marks `README.md`, `smoke.mjs`,
`.assetsignore`, `.gitignore`, `.gitattributes`, `.githooks/` and `tools/` as `export-ignore`, so
exactly the deployable tree is uploaded and nothing private can leak. (This replaces the old
`robocopy /XF` recipe, which had to be remembered on every deploy and could capture a half-written
file.)

Enabling it in a fresh clone:

```sh
git config core.hooksPath .githooks
```

Prefer a scoped `CLOUDFLARE_API_TOKEN` for unattended runs; the cached wrangler OAuth token expires
in about an hour, and the runner reports which one it used in `authWarning`.

Production URL: <https://quorly.us.ci> (the canonical domain; `quorly.pages.dev` 301s to it).

### Verify after every deploy

```sh
node smoke.mjs https://quorly.us.ci
```

This asserts every asset's `Content-Type` (including `/sw.js`), that `nosniff` is present, that
the CSP allows the analytics beacon, the manifest and the service worker and never
`'unsafe-inline'`, that HTML stays revalidated, that `sw.js` still carries the agreed cache
strategies, that the manifest keeps its installability fields, that the expected markup is in each
document, and that `README.md`, `_headers`, `.assetsignore` and `smoke.mjs` are **not** publicly
readable. It exists because a direct upload once stored assets as
`application/octet-stream`; with `nosniff` the browser downloaded `index.html` instead of
rendering it, and nothing in the pipeline noticed.

## Security headers (`_headers`)

```
Content-Security-Policy: default-src 'none'; script-src 'self' https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data: https:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=()
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000
```

`script-src` has no `'unsafe-inline'`, which is only possible because the markup contains
no inline `<script>`, no inline `<style>` and no inline event handlers. The JSON-LD block
in the landing page is a data block, not executable script, so it does not require a CSP
exception. If you ever add an inline handler you would have to weaken this to
`'unsafe-inline'` — avoid that.

`manifest-src` and `worker-src` are named explicitly because both fall back to `default-src`,
which is `'none'`. Without them the web app manifest would be blocked and the service worker could
not register. Chrome only fetches the manifest once a page is installable — which requires a
service worker — so this stayed invisible until the worker landed.

### Why MIME types are pinned

On a Worker with static assets, the direct-upload API records the `Content-Type` sent for
each file part and keys assets by content hash, so a stored type cannot be corrected later
without changing the file bytes. The `_headers` `Content-Type` pins make the served type
independent of that. Cloudflare Pages derives MIME from the file extension, so the pins are
redundant there but harmless.

### Hosts that can't read `_headers`

Add a `<meta http-equiv="Content-Security-Policy">` fallback to each document. A meta
policy cannot express `frame-ancestors`.

## Fonts

Self-hosted, open-source (OFL) only. The editor offers five reading faces: **Default**
(Inter body + Montserrat titles), **Literature** (Literata), **Paperback** (Crimson Pro),
**Screenwriter** (Courier Prime) and **OpenDyslexic**. Fira Code sets code blocks, and the
landing page keeps Lora as its serif. Google serves the variable families as one file per
style covering the full weight range; the OFL notices live in `fonts/LICENSE.md`. Twitter's
proprietary **Chirp** was removed because it cannot be redistributed.

## Offline + installable (service worker)

`sw.js` is served from the **root** — that is what gives it scope `/`. `app.js` registers it on
`window.load`, and only from the editor: the landing page deliberately does not, so a visitor who
only reads the marketing page never downloads the app shell. Once installed it controls the whole
origin, so `/` is covered from then on.

Caching is deliberately conservative, because the worst failure for an app that promises "your
words are safe" is a cache that outlives a deploy:

| Request | Strategy | Why |
|---|---|---|
| HTML navigations | **network-first** | a deploy can never be masked by a stale cached page |
| `/fonts/*` | **cache-first** | served `immutable` by `_headers`; they cannot change |
| everything else (CSS, JS, vendor, manifest, icons) | **stale-while-revalidate** | instant from cache and self-healing, so a forgotten version bump cannot pin an old `/app.js` forever |
| anything cross-origin | not intercepted | the analytics beacon must pass straight through |

Two failure modes are handled explicitly:

- **A 4xx passes through; a 5xx falls back to the cache.** An origin or proxy error must never
  replace a working offline shell with an error page. (Found in testing: a 502 was being shown
  instead of the cached editor.)
- **Precaching never aborts the install.** Each URL is added independently, so one bad file cannot
  leave the origin with no worker at all.

Documents are unaffected — the worker caches **code** only (the shell and its assets); your words
stay in `localStorage` as data. `VERSION` in `sw.js` only needs bumping when the *strategy* changes;
`activate` deletes any `quorly-*` cache that does not match the current name.

When the browser reports itself offline the editor's footer shows a small chip — *"Offline — saved
in this browser"* — and a "Back online" toast when it returns. The cue follows `navigator.onLine`,
which reflects the network interface rather than reachability, so a reachable-looking network with
a dead origin will not show the chip.

Installability was checked against the live manifest: `id` and `start_url` are `/app/`, `scope` is
`/`, `display` is `standalone`, `theme_color`/`background_color` are `#0e0e0e`, and the icon set is
192 + 512 plus a 512 `maskable`. The maskable entry reuses `icon-512.png`; the logo spans only the
centre of the canvas (furthest corner 189.6 px from centre versus a 204.8 px safe radius), so a
circular mask crops background and nothing else.

## Storage keys

The live document keeps its original keys, unchanged: `doc_title_v13`, `doc_body_v13`,
`doc_title_image_v13` and `mode`. (`doc_versions_v13` was the pre-library version history; it is
migrated into `quorly_versions_<id>` and then deleted — see below.)

The Recents library adds four:

| Key | Contents |
|---|---|
| `quorly_current_id_v1` | id of the document that is open |
| `quorly_files_v1` | index: `[{ id, title, updatedAt, wordCount }]`, newest first |
| `quorly_file_<id>` | that document's snapshot: `{ title, body, titleImage, updatedAt }` |
| `quorly_versions_<id>` | that document's version history (last 20 snapshots) |

**The open document is stored once.** The live keys above *are* its storage; an autosave only
upserts its (small) index entry. A body snapshot under `quorly_file_<id>` is written at the moment
the document is **parked** — before switching away from it (`parkCurrentDocument()`), which happens
in `newFile()`, `openRecent()` and when the 48 h restore window has lapsed. If a park fails because
storage is full, the switch is **refused** rather than overwriting the only copy.

The index is capped at `MAX_RECENTS = 10`; the oldest entries are evicted together with their
snapshot **and their version history**, and the open document is never evicted. On open, the last
document is restored only if it was touched within `RESTORE_WINDOW_MS` (48 h); otherwise the live
document is parked first and the editor opens a clean page, leaving the old document in the list.

Version history used to live in the shared `doc_versions_v13` list. It is now per document
(`quorly_versions_<id>`). The old key is read once and migrated; as soon as the per-document copy
exists the legacy key is **deleted**, because it is dead weight and can be image-sized. If the
migration cannot be written (quota), the legacy key is left alone rather than discarded.

Clicking the `×` on a Recents row deletes that document from this browser: its snapshot, its
version history, its session disk link and its index entry. Deleting the open document starts a
clean page.

Disk handles are **session-only**: a `FileSystemFileHandle` cannot be stored in `localStorage`, so
handles live in an in-memory `Map` keyed by document id. Rationale in `docs/QUORLY_UI_SPRINT.md`.

## Theme

Dark is the default on every page, and the visitor's OS preference is deliberately **not** consulted
(`grep prefers-color-scheme` → 0 hits). The editor's sidebar has a sun/moon button that toggles
`body.light-mode` and persists the choice in the `mode` key — the only route to the light theme. The
button shows the *current* mode (moon = dark, sun = light) and swaps via a `body.light-mode` CSS rule,
so it needs no JavaScript and no image request. The static pages (landing, privacy, 404) share
`landing.css` and have no toggle; they are dark-first to match the editor.

## Notes

- `document.execCommand` is still used for rich-text editing (deprecated but functional).
- The `vendor/` files are byte-identical to the pinned npm releases.
- Images are stored as data URLs in `localStorage` (≈5 MB origin quota; the real quota varies by
  browser). The open document is stored **once** — see "Storage keys" above. IndexedDB was
  considered and **rejected**: persistence stays `localStorage`-only, so the remaining work is to
  reduce bytes (image downscaling, text-only version snapshots) rather than move them —
  `docs/QUORLY_DD01_LOCALSTORAGE.md`.
- The privacy page deliberately publishes **no contact address**. Cloudflare has no free mailbox,
  and Email Routing needs `quorly.dev` registered first — see `docs/QUORLY_NEXT_PHASE.md` §5b.
  Revisit when the domain is bought.
