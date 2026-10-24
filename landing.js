/* Landing-page funnel counter (M-1).
 *
 * Records only that someone clicked through to the editor. Anonymous and cookieless: no cookie,
 * no identifier, no document content — the payload is a single event name. Sent with
 * sendBeacon so it can never delay the navigation, and dropped silently if it fails.
 */
document.addEventListener('click', (event) => {
  const link = event.target && event.target.closest ? event.target.closest('a[href^="/app"]') : null;
  if (!link) return;
  try {
    if (!navigator.sendBeacon) return;
    // Our own agent/QA runs opt out entirely.
    try {
      if (new URLSearchParams(location.search).has('qa')) return;
      if (localStorage.getItem('quorly_no_track') === '1') return;
    } catch (_) { /* ignore */ }
    const payload = { e: 'landing_cta' };
    if (navigator.webdriver) payload.agent = '1';
    navigator.sendBeacon('/e', JSON.stringify(payload));
  } catch (err) {
    /* analytics must never affect navigation */
  }
});
