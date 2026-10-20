# AGENTS.md — working on quorly.us.ci

Conventions for coding agents that read this repository's published output. This file describes
the project; it is not an instruction channel for the running app, and the app never reads it.

## What this is

Quorly is a private, local-first writing app. The editor is a single page of plain HTML, CSS and
JavaScript: no framework, no build step, no package manager, no bundler. Everything is served as
static files from Cloudflare Pages, with one Pages Function for the visit counter.

## Layout

| Path | Purpose |
|---|---|
| `/` | Landing page (`index.html`, `landing.css`, `landing.js`) |
| `/app/` | The editor (`app/index.html`) |
| `/app.js` | Editor behaviour; classic script, globals are the module boundary |
| `/stories.js` | Storage layer (IndexedDB + localStorage adapter), loaded before `app.js` |
| `/webmcp.js` | WebMCP tool registration for in-browser agents; loaded after `app.js` |
| `/styles.css` | Editor styles, including the mobile breakpoints at 1180 px and 720 px |
| `/sw.js` | Service worker: network-first for HTML, stale-while-revalidate for assets |
| `/functions/e.js` | `POST /e` — cookieless, allowlisted event counter |
| `/_headers` | CSP, MIME pins, cache policy. Read it before adding any file |

## Rules that are easy to break

1. **Strict CSP.** `script-src 'self'`, `style-src 'self'`, no `unsafe-inline`. No inline
   `<script>`, no inline `style` attributes, no inline event handlers, no `eval`. Style changes
   go through CSSOM property writes (`el.style.width = ...`), not `setAttribute('style', ...)`.
2. **Frozen storage keys.** `doc_title_v13`, `doc_body_v13`, `doc_title_image_v13` hold the open
   document. Do not rename them; older builds read the same keys.
3. **No document content leaves the origin.** The only network calls are same-origin assets and
   the counter at `/e`, which accepts an allowlisted event name plus one short property.
4. **`nosniff` is on.** A new file needs a `Content-Type` pin in `_headers` or it will not load.
5. **Deploys go through the release pipeline.** A commit on the release branch runs the smoke
   suite and deploys a preview; production is promoted only on explicit approval.

## Agent-facing surface

- `/llms.txt` — site summary and links.
- `/agent-skill.md` — the WebMCP skill: tool names, inputs, annotations.
- `/.well-known/ai-catalog.json` and `/.well-known/ard.json` — ARD entries pointing at that skill.
- `robots.txt` — AI crawler groups plus `Content-Signal` (`ai-train=no`).

The running app has no server-side API. Its agent tools are registered in the browser through
WebMCP and exist only while the page is open.
