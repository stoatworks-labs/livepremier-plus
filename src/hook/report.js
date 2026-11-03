/*
 * LivePremier Plus — the page's own errors, into the app's log.
 *
 * Inlined by the proxy ahead of the WebSocket hook, as a classic script, for
 * the failure that leaves nothing else running to say so: a panel module that
 * does not load. Every one of them 404'd on Windows from August to 2026-11-03
 * (`server/proxy.js`, `ownSourceFile`), the page was the plain Web RCS, and
 * the only witness was the browser's console on somebody else's PC.
 *
 * It sends `POST /__lpp/logs/page` (`server/logbook.js`): a script or style of
 * ours that would not load, and an error or rejected promise whose stack runs
 * through `/__lpp/`. The vendor's own errors are the vendor's, and are left
 * alone. Each distinct message goes once per page load, twenty at most; the
 * server keeps its own limit too.
 *
 * Dependency-free and tiny, as the hook is, and it never throws into the page.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.__LPP_REPORT) return;

  const TO = '/__lpp/logs/page';
  const MAX = 20;
  const seen = new Set();
  const ours = (text) => typeof text === 'string' && text.indexOf('/__lpp/') !== -1;

  function send(level, msg, where) {
    try {
      const key = level + '\n' + msg + '\n' + (where || '');
      if (seen.has(key) || seen.size >= MAX) return;
      seen.add(key);
      const body = JSON.stringify({
        level, msg: String(msg).slice(0, 2000), where: where ? String(where).slice(0, 2000) : undefined,
        url: location.pathname + location.hash
      });
      if (navigator.sendBeacon && navigator.sendBeacon(TO, new Blob([body], { type: 'application/json' }))) return;
      fetch(TO, { method: 'POST', body, headers: { 'content-type': 'application/json' }, keepalive: true }).catch(() => {});
    } catch (_) { /* a report that cannot be sent is not a reason to break the page */ }
  }

  /* Capture phase: a script or stylesheet that fails to load fires `error` on
     the element, and that event does not bubble to `window`. A module whose
     import fails reports on the <script> that started the graph — main.js. */
  window.addEventListener('error', (ev) => {
    const t = ev.target;
    if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
      const src = t.src || t.href || '';
      if (ours(src)) send('error', 'could not load ' + src.replace(location.origin, ''), 'a <' + t.tagName.toLowerCase() + '> on the page');
      return;
    }
    const stack = ev.error && ev.error.stack ? String(ev.error.stack) : '';
    if (!ours(ev.filename) && !ours(stack)) return;
    send('error', ev.message || 'script error', stack || ev.filename + ':' + ev.lineno + ':' + ev.colno);
  }, true);

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason;
    const stack = r && r.stack ? String(r.stack) : '';
    if (!ours(stack)) return;
    send('warn', 'unhandled rejection: ' + (r && r.message ? r.message : String(r)), stack);
  });

  window.__LPP_REPORT = send;
})();
