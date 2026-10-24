(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const KEY_STORAGE = 'quorly_metrics_key';

  const EVENT_LABELS = {
    landing_cta: 'Landing page CTA clicks',
    first_keystroke: 'First keystroke (new writers)',
    export: 'Document exports',
    storage_quota_exceeded: 'Storage quota exceeded',
    returning_writer: 'Returning writers',
    webmcp_tool: 'WebMCP tool calls (agents)',
  };

  const FORMAT_LABELS = {
    quorly: 'Quorly (.quorly)',
    pdf: 'PDF',
    md: 'Markdown',
    txt: 'Plain text',
  };

  const TOOL_LABELS = {
    get_document: 'Read document',
    list_documents: 'List documents',
    open_document: 'Open document',
    create_document: 'New document',
    set_document_title: 'Set title',
    append_content: 'Append content',
    replace_document_content: 'Replace content',
    insert_table: 'Insert table',
    set_reading_preferences: 'Set preferences',
    delete_document: 'Delete document',
  };

  function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function num(n) { return Number(n || 0).toLocaleString(); }

  function totalOf(rows, col) {
    return (rows || []).reduce((s, r) => s + Number(r[col] || 0), 0);
  }

  function pct(n, total) {
    if (!total) return '0%';
    return Math.round((n / total) * 100) + '%';
  }

  function table(rows, cols, opts) {
    opts = opts || {};
    if (!rows || !rows.length) return '<p class="empty">' + (opts.empty || 'No data yet.') + '</p>';
    const head = cols.map((c) => '<th>' + esc(c) + '</th>').join('');
    const body = rows.map((r) => {
      return '<tr>' + cols.map((c) => {
        const v = r[c];
        const isNum = typeof v === 'number' || /^\d+$/.test(v);
        let cell = esc(v);
        if (opts.barCol && c === opts.barCol) {
          const t = opts.barTotal || totalOf(rows, opts.barCol);
          const p = pct(Number(v), t);
          cell = '<div class="bar-cell"><div class="bar-fill" style="width:' + Math.max(4, (Number(v) / t) * 100) + 'px"></div><span>' + num(v) + '</span><span class="bar-pct">' + p + '</span></div>';
        } else if (isNum) {
          cell = num(v);
        }
        return '<td class="' + (isNum && c !== opts.barCol ? 'num' : '') + '">' + cell + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table>';
  }

  function card(title, desc, body) {
    return '<div class="card"><h2>' + esc(title) + '</h2><p class="desc">' + esc(desc) + '</p>' + body + '</div>';
  }

  async function load(key) {
    const status = $('status');
    const out = $('out');
    const kpis = $('kpis');
    status.textContent = 'Loading...';
    out.innerHTML = '';
    kpis.innerHTML = '';
    try {
      const res = await fetch('/api/metrics?key=' + encodeURIComponent(key), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      render(json);
      status.textContent = 'Updated ' + new Date(json.generatedAt).toLocaleString();
    } catch (e) {
      status.textContent = 'Failed: ' + e.message;
    }
  }

  function render(json) {
    const out = $('out');
    const kpis = $('kpis');
    const R = json.results || {};

    const funnelCust = (R.funnel_customers && R.funnel_customers.data) || [];
    const funnelAll = (R.funnel_all && R.funnel_all.data) || [];
    const exports = (R.exports && R.exports.data) || [];
    const tools = (R.webmcp_tools && R.webmcp_tools.data) || [];
    const daily = (R.daily_first_keystroke && R.daily_first_keystroke.data) || [];

    // KPIs
    const totalCust = totalOf(funnelCust, 'n');
    const totalAgent = funnelAll.filter((r) => r.agent === '1').reduce((s, r) => s + Number(r.n || 0), 0);
    const totalExports = totalOf(exports, 'n');
    const activeDays = daily.length;

    kpis.innerHTML =
      kpi('Customer events', totalCust, 'Non-agent traffic (first_keystroke, export, etc.)') +
      kpi('Agent events', totalAgent, 'WebMCP + WebDriver + headless traffic') +
      kpi('Total exports', totalExports, 'Documents exported by customers') +
      kpi('Active days', activeDays, 'Days with at least one first keystroke');

    const cards = [];

    // Funnel - customers
    const funnelRows = funnelCust.map((r) => ({
      event: EVENT_LABELS[r.event] || r.event,
      count: Number(r.n),
    }));
    cards.push(card(
      'Funnel — customers only',
      'Events from real (non-agent) browser sessions. Agent traffic is excluded.',
      table(funnelRows, ['event', 'count'], { barCol: 'count', empty: 'No customer events recorded yet. Visit the landing page and start writing to generate data.' })
    ));

    // Agent vs customer breakdown
    const agentRows = [];
    const events = [...new Set(funnelAll.map((r) => r.event))];
    events.forEach((ev) => {
      const cust = funnelAll.filter((r) => r.event === ev && r.agent !== '1').reduce((s, r) => s + Number(r.n || 0), 0);
      const agt = funnelAll.filter((r) => r.event === ev && r.agent === '1').reduce((s, r) => s + Number(r.n || 0), 0);
      agentRows.push({ event: EVENT_LABELS[ev] || ev, customers: cust, agents: agt, total: cust + agt });
    });
    cards.push(card(
      'Agent vs customer split',
      'Same events broken down by who triggered them. Use this to verify agent traffic is tagged correctly.',
      table(agentRows, ['event', 'customers', 'agents', 'total'], { empty: 'No events recorded yet.' })
    ));

    // Exports
    const exportRows = exports.map((r) => ({
      format: FORMAT_LABELS[r.format] || r.format || '(unknown)',
      count: Number(r.n),
    }));
    cards.push(card(
      'Exports by format',
      'How customers export their documents.',
      table(exportRows, ['format', 'count'], { barCol: 'count', empty: 'No exports recorded yet.' })
    ));

    // WebMCP tools
    const toolRows = tools.map((r) => ({
      tool: TOOL_LABELS[r.tool] || r.tool || '(unknown)',
      calls: Number(r.n),
    }));
    cards.push(card(
      'WebMCP tool calls (agents)',
      'Tools invoked by AI agents via the browser WebMCP interface.',
      table(toolRows, ['tool', 'calls'], { barCol: 'calls', empty: 'No WebMCP tool calls yet. Agents need Chrome with WebMCP enabled.' })
    ));

    // Daily chart
    const chartCard = document.createElement('div');
    chartCard.className = 'card';
    chartCard.style.gridColumn = '1 / -1';
    chartCard.innerHTML = '<h2>Daily first keystrokes</h2><p class="desc">New writers per day (customer traffic only). Shows engagement trend over time.</p><div class="chart-wrap"><canvas id="chart" width="900" height="200"></canvas><div class="chart-labels" id="chartLabels"></div></div>';
    out.innerHTML = cards.join('');
    out.appendChild(chartCard);
    drawChart(daily);

    // Errors
    const results = json.results || {};
    for (const k of Object.keys(results)) {
      if (results[k] && results[k].ok === false) {
        const d = document.createElement('div');
        d.className = 'err';
        d.textContent = k + ': ' + (results[k].raw || results[k].status || 'unknown error');
        out.appendChild(d);
      }
    }
  }

  function kpi(label, value, hint) {
    return '<div class="kpi"><div class="label">' + esc(label) + '</div><div class="value">' + num(value) + '</div><div class="hint">' + esc(hint) + '</div></div>';
  }

  function drawChart(rows) {
    const canvas = document.getElementById('chart');
    const labels = document.getElementById('chartLabels');
    if (!canvas || !rows.length) {
      if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#6b7280';
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('No data yet — first keystrokes will appear here', canvas.width / 2, canvas.height / 2);
      }
      return;
    }
    const ctx = canvas.getContext('2d');
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const vals = rows.map((r) => Number(r.n || r.count || 0));
    const max = Math.max(1, ...vals);
    const pad = { top: 20, bottom: 30, left: 10, right: 10 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;
    const bw = plotW / vals.length;
    // grid lines
    ctx.strokeStyle = '#1e2228';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + (plotH * i / 4);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(w - pad.right, y);
      ctx.stroke();
    }
    // bars
    ctx.fillStyle = '#2a6df4';
    vals.forEach((v, i) => {
      const bh = (v / max) * plotH;
      const x = pad.left + i * bw + 2;
      const y = pad.top + plotH - bh;
      ctx.fillRect(x, y, bw - 4, bh);
      // value label
      if (v > 0) {
        ctx.fillStyle = '#9aa0a6';
        ctx.font = '9px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(String(v), x + (bw - 4) / 2, y - 4);
        ctx.fillStyle = '#2a6df4';
      }
    });
    // x labels
    ctx.fillStyle = '#6b7280';
    ctx.font = '9px system-ui';
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(rows.length / 8));
    rows.forEach((r, i) => {
      if (i % step === 0 || i === rows.length - 1) {
        const label = String(r.day || '').slice(5);
        ctx.fillText(label, pad.left + i * bw + bw / 2, h - 8);
      }
    });
    // y-axis max label
    ctx.textAlign = 'left';
    ctx.fillText(String(max), 2, pad.top + 4);
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

  if (saved) load(saved);
})();