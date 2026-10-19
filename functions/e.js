/* Quorly funnel endpoint (M-1) — POST /e
 *
 * A same-origin, cookie-free counter. It records an event name and, at most, one short coarse
 * property (an export format) into Workers Analytics Engine. It never records document content,
 * an identifier, a cookie or an IP, and it sets no cookie in return. The client sends it with
 * navigator.sendBeacon() so a navigation is never delayed.
 *
 * Fail-open by design: any malformed body, missing binding or Analytics Engine hiccup still
 * answers 204. Analytics must never be able to break the editor, and this also covers the two
 * ordinary no-write cases — the local `wrangler pages dev` gate and preview deployments, where
 * the binding is deliberately absent so our own testing stays out of the dataset.
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

const MAX_BODY = 512; // a real payload is < 60 bytes; anything larger is not ours
const MAX_PROP = 32;

function noContent() {
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
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

  // Read at most one small body before doing anything else.
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return noContent();

  try {
    const raw = await request.text();
    if (raw && raw.length <= MAX_BODY) {
      const data = JSON.parse(raw);
      const event = data && data.e;
      // The allowlist is the schema: unknown events are dropped, never stored.
      if (typeof event === 'string' && EVENTS.has(event) && env.ANALYTICS) {
        const format = typeof data.format === 'string' ? data.format.slice(0, MAX_PROP) : '';
        const tool = typeof data.tool === 'string' ? data.tool.slice(0, MAX_PROP) : '';
        env.ANALYTICS.writeDataPoint({
          indexes: [event],
          blobs: [event, format, tool],
          doubles: [1],
        });
      }
    }
  } catch (err) {
    // Fail open — see the header note.
  }

  return noContent();
}
