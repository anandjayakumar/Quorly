/* Quorly funnel endpoint (M-1) — POST /e
 *
 * A same-origin, cookie-free counter. It records an event name and, at most, one short coarse
 * property (an export format, a theme, a WebMCP tool name) into Workers Analytics Engine. It never
 * records document content, an identifier, a cookie or an IP, and it sets no cookie in return. The
 * client sends it with navigator.sendBeacon() so a navigation is never delayed.
 *
 * Fail-open by design: any malformed body, missing binding or Analytics Engine hiccup still
 * answers 204. Analytics must never be able to break the editor, and this also covers the two
 * ordinary no-write cases — the local `wrangler pages dev` gate and preview deployments, where
 * the binding is deliberately absent so our own testing stays out of the dataset.
 *
 * Bounded by design too (M-2): the body is read through a stream cap, never with request.text(),
 * because a chunked request can omit or lie about Content-Length. Cross-site browser beacons are
 * dropped, and every property must match an explicit allowlist before it is written.
 *
 * The dataset (`quorly_events`, bound as ANALYTICS) is configured on the production environment
 * in the Cloudflare dashboard; it cannot be attached with `wrangler pages deploy`.
 */

const EVENTS = new Set([
  'landing_cta',
  'first_keystroke',
  'export',
  'storage_quota_exceeded',
  'returning_writer',
  'webmcp_tool',
]);

// The exported values are a closed set; anything else is dropped rather than truncated.
const FORMATS = new Set(['quorly', 'pdf', 'md', 'txt']);
const THEMES = new Set(['light', 'dark']);
const TOOLS = new Set([
  'get_document',
  'list_documents',
  'open_document',
  'create_document',
  'set_document_title',
  'append_content',
  'replace_document_content',
  'insert_table',
  'set_reading_preferences',
  'delete_document',
]);

const MAX_BODY = 512; // a real payload is < 100 bytes; anything larger is not ours

function noContent() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

// Read at most MAX_BODY bytes, whatever the headers claim. Returns null on overflow.
async function readCapped(request) {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const len = Number(declared);
    if (!Number.isFinite(len) || len < 0 || len > MAX_BODY) return null;
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch (_) {
    return null;
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

// Only a same-origin page may report. A browser always sends Origin on a cross-origin POST and
// Sec-Fetch-Site on every request; both are advisory (a script can omit them) but they stop
// casual drive-by beacons. The answer stays 204 so the check is not an oracle.
function isSameOrigin(request) {
  let origin = null;
  try {
    origin = new URL(request.url).origin;
  } catch (_) {
    return false;
  }
  const claimed = request.headers.get('origin');
  if (claimed !== null && claimed !== origin) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site === 'cross-site') return false;
  return true;
}

function isAutomated(request) {
  // Defense in depth: drop beacons from headless/automated browsers and explicit QA opt-outs.
  // Real visitors never send these. (Primary guard is client-side `navigator.webdriver`.)
  try {
    const url = new URL(request.url);
    if (url.searchParams.has('qa')) return true;
  } catch (_) { /* ignore */ }
  const ua = request.headers.get('user-agent') || '';
  return /HeadlessChrome|Playwright|Puppeteer|Selenium|PhantomJS|webdriver/i.test(ua);
}

function pick(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : '';
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
        'Cache-Control': 'no-store',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  if (!isSameOrigin(request) || isAutomated(request)) return noContent();

  try {
    const raw = await readCapped(request);
    if (raw) {
      const data = JSON.parse(raw);
      const event = data && data.e;
      // The allowlist is the schema: unknown events are dropped, never stored.
      if (typeof event === 'string' && EVENTS.has(event) && env.ANALYTICS) {
        env.ANALYTICS.writeDataPoint({
          indexes: [event],
          blobs: [
            event,
            pick(data.format, FORMATS),
            pick(data.tool, TOOLS),
            pick(data.theme, THEMES),
          ],
          doubles: [1],
        });
      }
    }
  } catch (err) {
    // Fail open — see the header note.
  }

  return noContent();
}
