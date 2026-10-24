(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY_STORAGE = 'quorly_metrics_key';

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function table(rows, cols) {
    if (!rows || !rows.length) return '<p class="empty">No data yet.</p>';
    const head = cols.map((c) => `<th>${esc(c)}</th>`).join('');
    const body = rows.map((r) => '<tr>' + cols.map((c) => {
      const v = r[c];
      const num = typeof v === 'number';
      return `<td class="${num ? 'num' : ''}">${esc(v)}</td>`;
    }).join('') + '</tr>').join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  async function load(key) {
    const status = $('status');
    const out = $('out');
    status.textContent = 'Loading…';
    out.innerHTML = '';
    try {
      const res = await fetch('/api/metrics?key=' + encodeURIComponent(key), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      render(json);
      status.textContent = 'Updated ' + new Date(json.generatedAt).toLocaleTimeString();
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
    }
  }

  function render(json) {
    const out = $('out');
    const R = json.results || {};
    const cards = [];

    // Funnel (customers)
    const funnel = (R.funnel_customers && R.funnel_customers.data) || [];
    cards.push(card('Funnel — customers', table(funnel, funnel.length ? Object.keys(funnel[0]) : ['event', 'n'])));

    // Agent vs customer
    const all = (R.funnel_all && R.funnel_all.data) || [];
    cards.push(card('Funnel — by agent flag', table(all, all.length ? Object.keys(all[0]) : ['agent', 'event', 'n'])));

    // Exports
    const exports = (R.exports && R.exports.data) || [];
    cards.push(card('Exports by format', table(exports, exports.length ? Object.keys(exports[0]) : ['format', 'n'])));

    // WebMCP tools
    const tools = (R.webmcp_tools && R.webmcp_tools.data) || [];
    cards.push(card('WebMCP tool calls', table(tools, tools.length ? Object.keys(tools[0]) : ['tool', 'n'])));

    // Daily trend chart
    const daily = (R.daily_first_keystroke && R.daily_first_keystroke.data) || [];
    const chartCard = document.createElement('div');
    chartCard.className = 'card';
    chartCard.style.gridColumn = '1 / -1';
    chartCard.innerHTML = '<h2>Daily first keystrokes</h2><canvas id="chart" width="900" height="180"></canvas>';
    out.innerHTML = cards.join('');
    out.appendChild(chartCard);
    drawChart(daily);
  }

  function card(title, body) {
    return `<div class="card"><h2>${esc(title)}</h2>${body}</div>`;
  }

  function drawChart(rows) {
    const canvas = document.getElementById('chart');
    if (!canvas || !rows.length) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const vals = rows.map((r) => Number(r.n || r.count || 0));
    const max = Math.max(1, ...vals);
    const pad = 24;
    const bw = (w - pad * 2) / vals.length;
    ctx.fillStyle = '#2a6df4';
    vals.forEach((v, i) => {
      const bh = (v / max) * (h - pad * 2);
      ctx.fillRect(pad + i * bw + 2, h - pad - bh, bw - 4, bh);
    });
    ctx.fillStyle = '#9aa0a6';
    ctx.font = '10px system-ui';
    rows.forEach((r, i) => {
      const label = String(r.day || '').slice(5);
      ctx.fillText(label, pad + i * bw + 2, h - 6);
    });
  }

  // Errors per query
  const origRender = render;
  // wrap to show per-query errors
  function renderWithErrors(json) {
    origRender(json);
    const out = $('out');
    const R = json.results || {};
    for (const k of Object.keys(R)) {
      if (R[k] && R[k].ok === false) {
        const d = document.createElement('div');
        d.className = 'err';
        d.textContent = k + ': ' + (R[k].raw && (R[k].raw.errors || R[k].raw.message) || R[k].status);
        out.appendChild(d);
      }
    }
  }

  // init
  const saved = sessionStorage.getItem(KEY_STORAGE);
  if (saved) $('key').value = saved;
  $('load').addEventListener('click', () => {
    const k = $('key').value.trim();
    sessionStorage.setItem(KEY_STORAGE, k);
    load(k);
  });
  $('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('load').click(); });

  // auto-load if key present
  if (saved) load(saved);
})();
" path">
C:\Users\anand\Downloads\ArticleWriter.metrics\admin\metrics.js