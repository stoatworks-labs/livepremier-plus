/*
 * grandMA3 — the engine between a desk's feedback and the switcher.  ** PREVIEW **
 *
 * `core.js` reads a message and says what a rule does with it; this keeps the
 * state that needs time — which faders are armed, a T-bar stroke, one write in
 * flight per fader — and does the sending, through what it is handed:
 *
 * - `dispatch(msg)` is `server/osc.js`'s `createOscDispatcher`, the path a UDP
 *   packet takes. A rule's target is one of this app's OSC addresses, so it
 *   meets the refusals a packet would: `preview` and `program` over UDP, a
 *   release, a `$` variable. Nothing here is a second copy of those rules.
 * - `switcher` is a `ConsoleSwitcher`, for the T-bar only: a stroke is the
 *   consoles' (`src/core/console-intents.js` `tbarWrites`, `strokeProgress`),
 *   which needs where each screen's T-bar rests, read once per stroke.
 *
 * Holds nothing open on the switcher, for the reason every console here
 * doesn't (`plugins/pixelhue/supervisor.js` argues it at its head).
 */

import { EventEmitter } from 'node:events';

import { sentDetail } from '../../server/console-switcher.js';
import { tbarWrites, strokeProgress, STROKE_END } from '../../src/core/console-intents.js';
import { readFeedback, parseMap, actionFor, faderEdge, viaName } from './core.js';

/* A fader-as-T-bar with no reading for this long has stopped; the stroke is over. */
const STROKE_IDLE_MS = 2000;
const HISTORY = 40;
const HEARD = 32;

export class Grandma3Bridge extends EventEmitter {
  #drive = false;
  #rules = new Map();
  #errors = [];
  /* Per rule key: { armed, lever, stroke, pending, busy } — reset when its line changes. */
  #state = new Map();

  /**
   * @param {object} o
   * @param {(msg: {address: string, args: unknown[]}) => Promise<object>} o.dispatch
   * @param {import('../../server/console-switcher.js').ConsoleSwitcher} o.switcher
   */
  constructor({ dispatch, switcher, log = () => {}, strokeIdleMs = STROKE_IDLE_MS } = {}) {
    super();
    this.dispatch = dispatch;
    this.switcher = switcher;
    this.log = log;
    this.strokeIdleMs = strokeIdleMs;
    this.heard = new Map();
    this.history = [];
  }

  /**
   * Follow the settings. A handle whose line changed or went starts afresh —
   * unarmed, no stroke — and the others carry on: saving a new line mid-show
   * must not drop a T-bar stroke on another fader.
   */
  apply(settings) {
    this.#drive = !!settings?.grandma3Drive;
    const { rules, errors } = parseMap(settings?.grandma3Map || '');
    const before = this.#rules;
    this.#rules = new Map(rules.map((r) => [r.key, r]));
    this.#errors = errors;
    for (const [key, st] of this.#state) {
      const was = before.get(key);
      const now = this.#rules.get(key);
      if (now && was && JSON.stringify(now.target) === JSON.stringify(was.target)) continue;
      this.#endStroke(st);
      this.#state.delete(key);
    }
    this.emit('activity');
    return this.describe();
  }

  stop() {
    for (const st of this.#state.values()) this.#endStroke(st);
    this.#state.clear();
  }

  /**
   * An `oscAddress` handler: one message under `/ma3/`, answered the way the
   * OSC listener logs it. A message that is not playback feedback is refused;
   * one that is, but has no line, is heard and answered "not mapped", which is
   * not a failure — most of a desk's playbacks have nothing to do with video.
   */
  async handle(address, args, meta = {}) {
    const r = readFeedback(address, args, meta.types);
    if (!r) return { ok: false, error: 'not grandMA3 playback feedback (an object address, a function, a value)' };
    this.#hear(r);
    const said = `${r.object} ${r.fn} ${r.kind === 'key' ? (r.value ? 'pressed' : 'released') : r.value}`;
    const rule = this.#rules.get(`${r.object} ${r.fn}`);
    if (!rule) return { ok: true, summary: `${said} — not mapped`, count: 0 };

    const act = actionFor(rule, r);
    if (act.do === 'nothing') return { ok: true, summary: `${said} — ${act.why}`, count: 0 };
    const st = this.#stateFor(rule.key);

    if (act.do === 'edge') {
      const edge = faderEdge(st.armed, r.value);
      st.armed = edge.armed;
      if (!edge.fire) return { ok: true, summary: `${said} — ${st.armed ? 'armed' : 'fires once it has been back to the bottom'}`, count: 0 };
    }
    if (!this.#drive) {
      const what = act.do === 'tbar' ? `T-bar ${rule.target.screens.join(' ')}` : rule.target.address;
      return { ok: true, summary: `${said} → ${what} — not sent: driving the switcher is off`, count: 0 };
    }
    if (act.do === 'tbar') return this.#tbar(rule, st, r, said);
    if (act.do === 'value') return this.#value(rule, st, Math.min(1, Math.max(0, r.value / 100)), said);
    return this.#send(rule, rule.target.args, said);
  }

  /* -------------------------------------------------------------- sending */

  async #send(rule, args, said) {
    const entry = await this.dispatch({ address: rule.target.address, args });
    return this.#answer(rule, entry, said);
  }

  #answer(rule, entry, said) {
    const target = [rule.target.address, ...(entry.args || [])].join(' ');
    if (entry.error) {
      this.#note({ rule: rule.key, error: `${target}: ${entry.error}` });
      return { ok: false, error: entry.error, summary: `${said} → ${target}` };
    }
    /* The resolver's summary starts with the address, which `target` already says. */
    const lead = `${rule.target.address} — `;
    const how = entry.summary ? String(entry.summary) : '';
    const tail = how.startsWith(lead) ? how.slice(lead.length) : how;
    this.#note({ rule: rule.key, note: `${target}${tail ? ` — ${tail}` : ''}`, sent: entry.paths || [] });
    return { ok: true, summary: `${said} → ${target}${tail ? ` (${tail})` : ''}`, count: entry.writes || 0 };
  }

  /**
   * A fader on a `/norm` address: one write in flight, the newest position
   * waiting behind it. A fader sends a stream; sending every reading at once
   * would let an older one land last. Each reading's answer says what became
   * of it, superseded included.
   */
  #value(rule, st, v, said) {
    if (st.pending) st.pending.resolve({ ok: true, summary: `${said} — overtaken by a newer position`, count: 0 });
    return new Promise((resolve) => {
      st.pending = { v, said, resolve };
      void this.#pump(rule, st);
    });
  }

  async #pump(rule, st) {
    if (st.busy) return;
    st.busy = true;
    try {
      while (st.pending) {
        const { v, said, resolve } = st.pending;
        st.pending = null;
        resolve(await this.#send(rule, [v], said));
      }
    } finally {
      st.busy = false;
    }
  }

  /* ---------------------------------------------------------------- T-bar */

  /**
   * A fader as a T-bar, on the consoles' terms (`plugins/barco-ec/supervisor.js`
   * `#onTbar`): the first reading is only where it rests; a stroke starts with
   * the next, from there, and the throw back the other way is the next take.
   * Where each screen's T-bar rests is read once per stroke.
   */
  #tbar(rule, st, r, said) {
    const f = Math.min(1, Math.max(0, r.value / 100));
    const from = st.lever;
    st.lever = f;
    if (from === null) return { ok: true, summary: `${said} — where the fader rests; the next move is a stroke`, count: 0 };
    if (!st.stroke) {
      st.stroke = { from, rests: null, dialect: null, pending: null, busy: false, timer: null, lastSent: [] };
      void this.#readRests(rule, st, st.stroke);
    }
    const stroke = st.stroke;
    stroke.pending = f;
    clearTimeout(stroke.timer);
    stroke.timer = setTimeout(() => this.#endStroke(st), this.strokeIdleMs);
    stroke.timer.unref?.();
    void this.#pumpTbar(rule, st);
    return { ok: true, summary: `${said} → T-bar ${rule.target.screens.join(' ')}`, count: 0 };
  }

  async #readRests(rule, st, stroke) {
    try {
      /* Identified per stroke, not once: the app can be re-pointed at a backup
         frame between two throws, and the other one may be a Midra. */
      stroke.dialect = await this.switcher.identify();
      this.switcher.dialect = stroke.dialect;
      stroke.rests = await this.switcher.restsFor(rule.target.screens);
    } catch (err) {
      this.#note({ rule: rule.key, error: `T-bar: ${err.message}` });
      this.#endStroke(st);
      return;
    }
    void this.#pumpTbar(rule, st);
  }

  async #pumpTbar(rule, st) {
    const stroke = st.stroke;
    if (!stroke || stroke.busy || !stroke.rests || stroke.pending === null) return;
    const now = stroke.pending;
    stroke.pending = null;
    stroke.busy = true;
    let progress = strokeProgress(stroke.from, now);
    if (progress >= STROKE_END) progress = 1;
    const { writes } = tbarWrites({ mapValue: Math.round(progress * 1000), maxValue: 1000 }, {
      dialect: stroke.dialect,
      selected: rule.target.screens,
      restOf: (id) => stroke.rests.get(id) ?? null,
    });
    try {
      if (writes.length) {
        stroke.lastSent = sentDetail(writes);
        await this.switcher.write(writes);
      }
    } catch (err) {
      this.#note({ rule: rule.key, error: `T-bar: ${err.message}` });
    }
    stroke.busy = false;
    if (progress >= 1) {
      this.#note({ rule: rule.key, note: `T-bar take on ${rule.target.screens.join(' ')}`, sent: stroke.lastSent });
      this.#endStroke(st);
      return;
    }
    if (stroke.pending !== null) void this.#pumpTbar(rule, st);
  }

  #endStroke(st) {
    if (!st.stroke) return;
    clearTimeout(st.stroke.timer);
    st.stroke = null;
  }

  /* ------------------------------------------------------------ reporting */

  #stateFor(key) {
    let st = this.#state.get(key);
    if (!st) this.#state.set(key, (st = { armed: false, lever: null, stroke: null, pending: null, busy: false }));
    return st;
  }

  #hear(r) {
    const key = `${r.object} ${r.fn}`;
    const was = this.heard.get(key);
    this.heard.delete(key);
    this.heard.set(key, {
      object: r.object, fn: r.fn, kind: r.kind, via: viaName(r), value: r.value,
      cue: r.cue ?? was?.cue ?? null, at: Date.now(), count: (was?.count ?? 0) + 1,
    });
    while (this.heard.size > HEARD) this.heard.delete(this.heard.keys().next().value);
    this.emit('activity');
  }

  #note(entry) {
    const e = { at: Date.now(), ...entry };
    this.history.unshift(e);
    this.history.length = Math.min(this.history.length, HISTORY);
    if (entry.error) this.log(`grandma3: ${entry.error}`);
    this.emit('activity', e);
  }

  describe() {
    return {
      drive: this.#drive,
      rules: [...this.#rules.values()].map((r) => ({
        line: r.line, key: r.key,
        target: r.target.type === 'tbar' ? `tbar ${r.target.screens.join(' ')}` : [r.target.address, ...r.target.args].join(' '),
      })),
      errors: this.#errors,
      heard: [...this.heard.values()].reverse().map((h) => ({ ...h, mapped: this.#rules.has(`${h.object} ${h.fn}`) })),
      history: this.history,
    };
  }
}
