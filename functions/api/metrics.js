/* Metrics endpoint for the Quorly admin dashboard.
 *
 * Serves aggregated, anonymous funnel counters from Cloudflare Analytics Engine.
 * Gated by METRICS_KEY (query param `key` or header `X-Metrics-Key`); without it the
 * endpoint answers 404 so its existence is not even disclosed.
 *
 * Required env (Pages Function bindings / secrets):
 *   CF_ACCOUNT_ID   - Cloudflare account id (same as CLOUDFLARE_ACCOUNT_ID)
 *   CF_ANALYTICS_TOKEN - API token with Account Analytics: Read
 *   METRICS_KEY     - shared secret for the dashboard page
 *   ANALYTICS binding is NOT needed here (read-only).
 */
const QUERIES = [
  { id: 'funnel_customers', sql: "SELECT index1 AS event, COUNT() AS n FROM quorly_events WHERE blob5 = '' GROUP BY index1 ORDER BY n DESC" },
  { id: 'funnel_all', sql: "SELECT blob5 AS agent, index1 AS event, COUNT() AS n FROM quorly_events GROUP BY blob5, index1 ORDER BY n DESC" },
  { id: 'exports', sql: "SELECT blob2 AS format, COUNT() AS n FROM quorly_events WHERE index1 = 'export' AND blob5 = '' GROUP BY blob2 ORDER BY n DESC" },
  { id: 'webmcp_tools', sql: "SELECT blob3 AS tool, COUNT() AS n FROM quorly_events WHERE index1 = 'webmcp_tool' GROUP BY blob3 ORDER BY n DESC" },
  { id: 'daily_first_keystroke', sql: "SELECT toDate(timestamp) AS day, COUNT() AS n FROM quorly_events WHERE index1 = 'first_keystroke' GROUP BY day ORDER BY day" },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function runQuery(accountId, token, sql) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/analytics_engine/sql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
    body: sql,
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (_) { parsed = { raw: text }; }
  // The SQL API returns { meta, data, rows, ... } either at top level or under result[0].
  let data = null;
  if (Array.isArray(parsed && parsed.result) && parsed.result[0]) data = parsed.result[0].data || parsed.result[0].rows || null;
  if (data === null && Array.isArray(parsed && parsed.data)) data = parsed.data;
  if (data === null && parsed && parsed.rows) data = parsed.rows;
  return { ok: res.ok, status: res.status, data: data || [], raw: parsed };
}

export async function onRequest(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const provided = url.searchParams.get('key') || request.headers.get('x-metrics-key') || '';
  if (!env.METRICS_KEY || provided !== env.METRICS_KEY) {
    // 404 so the endpoint's existence is not disclosed.
    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const accountId = env.CF_ACCOUNT_ID || env.CLOUDFLARE_ACCOUNT_ID;
  const token = env.CF_ANALYTICS_TOKEN;
  if (!accountId || !token) {
    return json({ error: 'metrics not configured (missing CF_ACCOUNT_ID or CF_ANALYTICS_TOKEN)' }, 500);
  }

  const results = {};
  for (const q of QUERIES) {
    results[q.id] = await runQuery(accountId, token, q.sql);
  }
  return json({ generatedAt: new Date().toISOString(), results });
}