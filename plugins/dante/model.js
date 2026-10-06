/*
 * Dante — the page's view of the server half: what the devices said last,
 * and the requests that change it. No DOM; `fetch` and `EventSource` only,
 * both injectable so the tests can run it.
 *
 * One of these per page, made by the page half and handed to a popped-out
 * window through `ctx.share` — so the window shows the same devices, the same
 * pending clicks and the same last result as the tab, over the tab's one
 * stream. A page has six connections to its origin to share with the vendor's
 * own app; a second stream for the same facts would spend one for nothing.
 *
 * The stream is opened the first time something asks to see the devices (the
 * panel drawing), not at load: a page whose operator never opens the Dante
 * panel never holds it.
 */

export function createDanteModel({ url, fetchImpl = (...a) => fetch(...a), EventSourceImpl = globalThis.EventSource, log = () => {} }) {
  const listeners = new Set();
  const state = {
    data: null,        // the server's snapshot: devices, discovery, interfaces, snapshots
    error: null,       // could not reach the server half
    note: null,        // { tone, text } — the last thing done, in a sentence
    result: null,      // the last write's per-channel results
    pending: new Map(),// "device\u0000number" → the route asked for, until the next snapshot
    version: 0
  };
  let stream = null;
  let loading = null;

  const changed = () => {
    state.version += 1;
    for (const fn of listeners) { try { fn(); } catch (err) { log(`dante: ${err.message}`); } }
  };

  function take(data) {
    if (!data || !Array.isArray(data.devices)) return;
    state.data = data;
    state.error = null;
    changed();
  }

  async function call(path, { method = 'POST', body } = {}) {
    const res = await fetchImpl(url(path), {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store'
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok && !(payload && Array.isArray(payload.results))) throw new Error(payload.error || `the app answered ${res.status}`);
    return payload;
  }

  function load() {
    if (loading) return loading;
    loading = call('/', { method: 'GET' })
      .then(take)
      .catch((err) => { state.error = `Could not reach the Dante plugin: ${err.message}`; changed(); })
      .finally(() => { loading = null; });
    return loading;
  }

  function listen() {
    if (stream || typeof EventSourceImpl !== 'function') return;
    try {
      stream = new EventSourceImpl(url('/stream'));
      stream.addEventListener('dante', (ev) => {
        try { take(JSON.parse(ev.data)); } catch { /* a torn frame; the next one will do */ }
      });
    } catch { stream = null; }
  }

  const note = (tone, text) => { state.note = { tone, text, at: Date.now() }; changed(); };

  /** Apply routes. `what` is how the note line says it. */
  async function apply(routes, what = 'Dante routing') {
    for (const r of routes) {
      if (r && r.rx) state.pending.set(`${r.rx.device}\u0000${r.rx.channel}`, r.tx || null);
    }
    changed();
    try {
      const result = await call('/apply', { body: { routes } });
      state.result = result;
      note(result.ok ? 'ok' : 'warn', `${what} — ${result.summary}${result.ok ? '' : `: ${result.error || 'see below'}`}`);
      return result;
    } catch (err) {
      note('warn', `${what} — not applied: ${err.message}`);
      throw err;
    } finally {
      for (const r of routes) if (r && r.rx) state.pending.delete(`${r.rx.device}\u0000${r.rx.channel}`);
      await load();
    }
  }

  return {
    state,
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Make sure the devices are loaded and kept live. */
    want() { if (!state.data && !loading) void load(); listen(); },
    load,
    apply,
    isPending: (device, number) => state.pending.has(`${device}\u0000${number}`),
    async refresh(device = null) {
      try { take(await call('/refresh', { body: device ? { device } : {} })); note('ok', device ? `Read ${device} again` : 'Read every device again'); } catch (err) { note('warn', `Could not refresh: ${err.message}`); }
    },
    exportUrl(devices = [], name = '') {
      const q = new URLSearchParams();
      if (devices.length) q.set('devices', devices.join(','));
      if (name) q.set('name', name);
      const s = q.toString();
      return url('/preset') + (s ? `?${s}` : '');
    },
    presetDiff: (xml, assign = {}) => call('/preset/diff', { body: { xml, assign } }),
    async presetApply(xml, assign, digest) {
      try {
        const result = await call('/preset/apply', { body: { xml, assign, digest } });
        state.result = result;
        note(result.ok ? 'ok' : 'warn', `Preset applied — ${result.summary}${result.ok ? '' : `: ${result.error || 'see below'}`}`);
        return result;
      } finally { await load(); }
    },
    async saveSnapshot(name, devices = []) {
      try { take(await call('/snapshots', { body: { name, devices } })); note('ok', `Saved snapshot “${name}”`); } catch (err) { note('warn', `Could not save “${name}”: ${err.message}`); }
    },
    async deleteSnapshot(name) {
      try { take(await call('/snapshots/delete', { body: { name } })); note('ok', `Deleted snapshot “${name}”`); } catch (err) { note('warn', `Could not delete “${name}”: ${err.message}`); }
    },
    recallPlan: (name) => call('/snapshots/recall', { body: { name, dryRun: true } }),
    async recall(name) {
      try {
        const result = await call('/snapshots/recall', { body: { name } });
        state.result = result;
        note(result.ok ? 'ok' : 'warn', `Recalled “${name}” — ${result.summary}${result.ok ? '' : `: ${result.error || 'see below'}`}`);
        return result;
      } catch (err) { note('warn', `Could not recall “${name}”: ${err.message}`); throw err; } finally { await load(); }
    },
    note,
    stop() { if (stream) { try { stream.close(); } catch { /* gone */ } } stream = null; }
  };
}
