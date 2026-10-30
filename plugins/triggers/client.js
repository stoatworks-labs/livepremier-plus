/*
 * Triggers — the plugin's page half: the panel, the cue field, and a cue's
 * `then`.
 *
 * ## What the page does, and what it leaves to the server
 *
 * A cue fires here, because the cue stack runs here, and its `triggers`
 * action is one POST: which triggers, and when to put them back. Everything
 * after that is the server's — sending the lines, holding the back lines,
 * hearing a deck's clip end — so the house lights come back even if this tab
 * has gone by then.
 *
 * What only this page can do is move its own cue stack: a restore's
 * `then go` or `then cue 13`. The server says `restored` on its stream, and
 * the page that fired the cue — matched by an id made fresh on every load —
 * does it, and says so. **It does it only if nobody has moved the stack
 * since**: the standby must still be the cue after the one that made the
 * hold. An operator who pressed GO through the end of a VT has already done
 * what `then go` was for, and a second GO would skip a cue.
 *
 * `at next cue` is this page's to notice too: every cue it fires is told to
 * the server while it has such a hold, and the server restores the holds that
 * end there.
 */

import { createTriggersPanel } from './panel.js';
import { parseCueText, formatCueText, describeCueAction, cueName } from './core.js';

export default function activate(ctx) {
  const pageId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`;
  const state = { data: null, error: null, pageId };
  let stream = null;
  /* Holds this page made that end at the next cue. */
  const nextHolds = new Set();

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      state.data = await res.json();
      state.error = null;
    } catch (err) {
      state.error = `Could not reach the launcher: ${err.message}`;
    }
    ctx.refresh();
  }

  /* Held only once needed — the panel is open, or this page has a hold — as HyperDecks does. */
  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('state', (ev) => {
        try { state.data = JSON.parse(ev.data); } catch { return; }
        const live = new Set((state.data.holds || []).map((h) => h.id));
        for (const id of nextHolds) if (!live.has(id)) nextHolds.delete(id);
        ctx.refresh();
      });
      stream.addEventListener('restored', (ev) => {
        let e;
        try { e = JSON.parse(ev.data); } catch { return; }
        onRestored(e);
      });
    } catch { /* no EventSource: the panel still draws from load() */ }
  }

  async function post(path, body) {
    const res = await fetch(ctx.url(path), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (res.status >= 400) throw new Error(payload.error || String(res.status));
    return payload;
  }

  async function save(setup) {
    try {
      const res = await fetch(ctx.url('/'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(setup),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload.error || String(res.status));
      state.data = payload;
      state.error = null;
    } catch (err) {
      state.error = `Could not save: ${err.message}`;
    }
    ctx.refresh();
  }

  const names = () => ({ triggers: (state.data && state.data.triggers) || [], decks: (state.data && state.data.decks) || [] });

  /* ------------------------------------------------------------ then */

  function onRestored(e) {
    if (!e || !e.hold || e.hold.page !== pageId || !e.then) return;
    const stack = ctx.use('stack');
    const what = e.then === 'go' ? 'GO' : `cue ${e.then.cue}`;
    const report = (ok, text) => { void post('/then', { hold: e.hold.id, ok, text }).catch(() => {}); };
    if (!stack) { report(false, `${cueName(e.hold.cue)} → ${what}: the Timeline is off in this page`); return; }

    const cues = stack.cues();
    const at = cues.findIndex((c) => c.id === e.hold.cue.id);
    const standby = stack.standby;
    if (at < 0 || !standby || !cues[at + 1] || cues[at + 1].id !== standby.id) {
      report(false, `${cueName(e.hold.cue)} → ${what} not done: the stack has moved on since`);
      return;
    }
    if (e.then === 'go') {
      stack.go();
      report(true, `${cueName(e.hold.cue)} → GO`);
      return;
    }
    const target = cues.find((c) => String(c.number) === String(e.then.cue));
    if (!target) { report(false, `${cueName(e.hold.cue)} → no cue ${e.then.cue} in this stack`); return; }
    stack.gotoId(target.id);
    stack.go();
    report(true, `${cueName(e.hold.cue)} → cue ${e.then.cue}`);
  }

  /* ------------------------------------------------------------ the cue */

  ctx.contribute('cueAction', {
    kind: 'triggers',
    label: 'Triggers',
    async run(action, { cue }) {
      if (action.restore) listen();
      const r = await post('/fire', {
        page: pageId,
        cue: { id: cue.id, number: cue.number, label: cue.label },
        fire: action.fire || [],
        restore: action.restore || null,
      });
      if (r.hold && action.restore && action.restore.next) nextHolds.add(r.hold);
      if (!r.ok) {
        throw new Error(r.results.filter((x) => !x.ok).map((x) => `${x.line}: ${x.error}`).join('; '));
      }
    },
    describe: (action) => describeCueAction(action, names()),
    field: {
      label: 'Triggers',
      placeholder: 'VT audio; House down; restore when Mitti ends then go',
      hint: 'Triggers to fire, ; between them, and when to send them back: restore when <deck> ends, after 5:00, at next cue or by hand — then go, or then cue 13.',
      parse: (text) => parseCueText(text, names()),
      format: (actions) => formatCueText(actions, names()),
    },
  });

  const stack = ctx.use('stack');
  if (stack) {
    stack.addEventListener('fired', (ev) => {
      if (!nextHolds.size) return;
      void post('/next', { page: pageId, cue: ev.detail && ev.detail.cueId }).catch((err) => ctx.log.warn('triggers: next cue', err));
    });
  }

  /* ------------------------------------------------------------ the panel */

  void load();
  const panel = createTriggersPanel({
    ctx,
    state,
    open: () => { if (!state.data && !state.error) void load(); listen(); },
    post: (path, body) => post(path, body).catch((err) => { state.error = err.message; ctx.refresh(); }),
    save,
  });
  ctx.ui.sidebar({
    id: 'triggers',
    label: 'Triggers',
    icon: ['send-18', 'gpio-18', 'connector-gpio-18', 'properties-18'],
    order: 56,
    render: () => panel.render(),
    busy: () => panel.busy(),
  });
}
