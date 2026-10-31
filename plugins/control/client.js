/*
 * Control API — the plugin's page half: where Companion's presses are run.
 *
 * Every open page claims the lease by holding `/stream` open and beating on
 * `/runner`; the one that holds it runs the commands that arrive on the
 * stream, through the same services the panels
 * use — the Timeline's `stack`, Layer Lock's `locks`, Layer Groups, the
 * Console, the user's variables — and reports what the show looks like on
 * `/report`, so a Stream Deck key can say which cue is standing by.
 *
 * Nothing here has a panel. The plugin's whole face is the routes, and
 * docs/CONTROL.md describes them.
 */

import { findCue, onOff, parseTarget, resolveSource } from './core.js';
import { dialectFor } from '../../src/core/dialect.js';
import { sourceCommands } from '../../src/core/groups.js';
import { lockedFor, ROLE_LABEL } from '../../src/ui/preset-lock.js';
import { formatTimecode } from '../../src/core/timecode.js';

const BEAT_MS = 4000;
/* Most changes announce themselves; this catches the ones that don't (a lock
   set from another tab, a group renamed) without a listener on everything. */
const LOOK_MS = 1000;
/* A report is sent again unchanged now and then, so a restarted server has
   one without waiting for the show to move. */
const RESEND_MS = 10000;

/** Which screen a built command writes to, read back out of its path. */
function screenOf(path) {
  for (let i = 0; i < path.length - 1; i++) {
    if (['screenList', 'auxiliaryList', 'auxiliaryScreenList'].includes(path[i]) && path[i + 1] === 'items') {
      const key = path[i + 2];
      if (/^[SA]\d+$/.test(key)) return key;
      return (path.includes('auxiliaryScreenList') ? 'A' : 'S') + key;
    }
  }
  return null;
}

const cueFace = (c, i) => (c ? { id: c.id, number: String(c.number || i + 1), label: c.label || '', enabled: c.enabled !== false } : null);

export default function activate(ctx) {
  const pageId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`;
  let runner = null;
  let line = null;
  let lastFired = null;
  let lastSent = '';
  let lastSentAt = 0;
  let soon = null;

  const holding = () => runner === pageId;

  /* ------------------------------------------------------------ the lease */

  function heard(next) {
    const was = holding();
    runner = next;
    /* Taking over: say what the show looks like at once. */
    if (!was && holding()) { lastSent = ''; report(); }
  }

  async function beat(release = false) {
    try {
      const res = await fetch(ctx.url('/runner'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pageId, release }), keepalive: release
      });
      if (res.ok) heard((await res.json()).runner);
    } catch { /* the next beat tries again */ }
  }

  /* ----------------------------------------------------------- the actions */

  const need = (name, what) => {
    const s = ctx.use(name);
    if (!s) throw new Error(`${what} is switched off`);
    return s;
  };

  function cueIn(stack, wanted) {
    const cue = findCue(stack.cues(), wanted);
    if (!cue) throw new Error(`there is no cue ${wanted}`);
    return cue;
  }

  function standbyIndex(stack) {
    const s = stack.standby;
    return s ? stack.cues().findIndex((c) => c.id === s.id) : -1;
  }

  async function lineOutcome(text) {
    const svc = need('console', 'the Console');
    if (!line) line = svc.line({ stickyScope: false });
    const before = line.state.log[0];
    line.runCommand(text);
    /* A plugin's address goes to the server and is logged when it answers;
       a few frames is plenty, and an answer we never saw is still sent. */
    for (let i = 0; i < 20 && line.state.log[0] === before; i++) await new Promise((r) => setTimeout(r, 25));
    const entry = line.state.log[0];
    if (!entry || entry === before) return { detail: 'sent' };
    if (entry.kind === 'error') throw new Error(entry.detail || 'the Console refused it');
    return { kind: entry.kind, detail: entry.detail || '' };
  }

  function lockKeysOf(target) {
    return target.members.map((m) => `${m.id}/${m.layer}`);
  }

  function targetOf(raw) {
    const groups = ctx.use('groups');
    const t = parseTarget(raw, groups ? groups.list() : []);
    if (!t) throw new Error(`“${raw}” is neither a layer (S1/2) nor a layer group`);
    return t;
  }

  function send({ source, target: raw, mode }) {
    const store = ctx.session.store;
    if (!store || !store.ready) throw new Error('the switcher has not sent its state yet');
    const dialect = dialectFor(store);
    if (!dialect || !dialect.sources) throw new Error('no platform yet');
    const value = resolveSource(source, dialect.sources(store), (v) => dialect.sourceLabel(v));
    if (!value) throw new Error(`“${source}” is not a source this switcher offers`);
    const target = targetOf(raw);
    const plan = sourceCommands(store, target.members, value, mode);
    const touched = [...new Set(plan.cmds.map((c) => screenOf(c.path)).filter(Boolean))];
    /* The `…` menu asks before writing past a padlock. There is nobody to
       ask here, so a padlock is a no. */
    const lock = lockedFor(touched, mode, document);
    if (plan.cmds.length && lock.locked.length) {
      const role = ROLE_LABEL[mode] || mode.toLowerCase();
      throw new Error(lock.reason === 'unknown'
        ? `${lock.locked.join(', ')} not on the page, so the ${role} padlock cannot be read`
        : `${role} is locked on ${lock.locked.join(', ')}`);
    }
    const sent = plan.cmds.filter((cmd) => ctx.session.send(cmd));
    const groups = ctx.use('groups');
    if (groups && target.kind === 'group') { groups.expect(sent); groups.remember(target); }
    const bits = [];
    const label = dialect.sourceLabel(value) || value;
    if (sent.length) bits.push(`${label} → ${sent.length} layer${sent.length === 1 ? '' : 's'}`);
    if (plan.unchanged.length) bits.push(`${plan.unchanged.length} already ${label}`);
    for (const r of plan.refused) bits.push(r.why);
    if (!sent.length && plan.refused.length) throw new Error(bits.join(' · '));
    return { detail: bits.join(' · ') || 'nothing to send', sent: sent.length };
  }

  const RUN = {
    'timeline.go': () => { need('stack', 'the Timeline').go(); },
    'timeline.back': () => { need('stack', 'the Timeline').back(); },
    'timeline.stop': () => { need('stack', 'the Timeline').stop(); },
    'timeline.first': () => {
      const stack = need('stack', 'the Timeline');
      const first = stack.cues()[0];
      if (!first) throw new Error('the cue stack is empty');
      stack.gotoId(first.id);
    },
    'timeline.next': () => {
      const stack = need('stack', 'the Timeline');
      const next = stack.cues()[standbyIndex(stack) + 1];
      if (!next) throw new Error('the standby is the last cue');
      stack.gotoId(next.id);
    },
    'timeline.goto': ({ cue }) => {
      const stack = need('stack', 'the Timeline');
      stack.gotoId(cueIn(stack, cue).id);
    },
    'timeline.fire': ({ cue }) => {
      const stack = need('stack', 'the Timeline');
      stack.fire(cueIn(stack, cue).id);
    },
    'timecode.chase': ({ on }) => {
      const { chase } = need('timecode', 'Timecode');
      const arm = on === 'toggle' ? !chase.enabled : on === 'on';
      if (arm) chase.arm(); else chase.disarm();
      return { armed: chase.enabled };
    },
    'console.run': ({ line: text }) => lineOutcome(text),
    'locks.set': ({ target, on }) => {
      const locks = need('locks', 'Layer Lock');
      const t = targetOf(target);
      const keys = lockKeysOf(t);
      const all = keys.every((k) => locks.list().includes(k));
      const lock = on === 'toggle' ? !all : on === 'on';
      locks.set(keys, lock);
      return { locked: lock, keys };
    },
    'locks.take': async ({ target }) => {
      const locks = need('locks', 'Layer Lock');
      const r = await locks.takeOnly(targetOf(target).members, {});
      if (!r || !r.ok) throw new Error((r && r.message) || 'nothing was taken');
      return { detail: r.message };
    },
    'groups.send': (args) => send(args),
    'variables.set': ({ name, value }) => {
      const variables = need('variables', 'Variables');
      const problem = variables.define(name, value);
      if (problem) throw new Error(problem);
      /* Kept as typed, as the panel keeps it, but say what it now comes to:
         a definition that does not evaluate is otherwise silent from outside. */
      const row = variables.list().find((v) => v.kind === 'user' && v.bare.toLowerCase() === String(name).toLowerCase());
      if (!row) return null;
      return { name: row.bare, value: row.answer && row.answer.ok ? row.answer.value : null, error: row.answer && !row.answer.ok ? row.answer.error : null };
    }
  };

  async function run(msg) {
    let answer;
    try {
      if (!RUN[msg.action]) throw new Error(`this page does not know “${msg.action}”`);
      const result = await RUN[msg.action](msg.args || {});
      answer = { id: msg.id, ok: true, result: result ?? null };
    } catch (err) {
      answer = { id: msg.id, ok: false, error: err.message };
    }
    try {
      await fetch(ctx.url('/result'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(answer) });
    } catch (err) {
      ctx.log.warn('control: could not answer a command', err);
    }
    report();
  }

  /* ------------------------------------------------------------ the report */

  function state() {
    const out = { at: Date.now() };

    const stack = ctx.use('stack');
    if (stack) {
      const cues = stack.cues();
      const i = standbyIndex(stack);
      out.timeline = {
        name: stack.name || '',
        count: cues.length,
        running: Boolean(stack.running),
        standby: cueFace(cues[i], i),
        next: cueFace(cues[i + 1], i + 1),
        previous: i > 0 ? cueFace(cues[i - 1], i - 1) : null,
        last: lastFired,
        waiting: typeof stack.waiting === 'function' ? stack.waiting().map((w) => w.cueId) : [],
        cues: cues.slice(0, 200).map((c, n) => cueFace(c, n))
      };
    }

    const tc = ctx.use('timecode');
    if (tc) {
      const clock = tc.source && tc.source.clock;
      const position = clock && clock.running && typeof clock.position === 'function' ? clock.position() : null;
      out.timecode = {
        armed: Boolean(tc.chase && tc.chase.enabled),
        source: (tc.source && tc.source.state && tc.source.state.kind) || 'none',
        running: Boolean(clock && clock.running),
        /* Seconds, not frames: a report is not a timecode feed. */
        value: position ? formatTimecode({ ...position, frames: 0 }).replace(/[:;]\d\d$/, '') : null
      };
    }

    const locks = ctx.use('locks');
    if (locks) out.locks = [...locks.list()];

    const groups = ctx.use('groups');
    if (groups) {
      out.groups = groups.list().map((g) => ({ name: g.name, gang: g.gang !== false, members: (g.members || []).map((m) => `${m.id}/${m.layer}`) }));
    }

    const variables = ctx.use('variables');
    if (variables) {
      out.variables = variables.list().filter((v) => v.kind === 'user').map((v) => ({
        name: v.bare,
        value: v.answer && v.answer.ok ? v.answer.value : null,
        error: v.answer && !v.answer.ok ? v.answer.error : null
      }));
    }

    return out;
  }

  async function report() {
    clearTimeout(soon);
    soon = null;
    if (!holding()) return;
    const s = state();
    const { at, ...rest } = s;
    const key = JSON.stringify(rest);
    if (key === lastSent && Date.now() - lastSentAt < RESEND_MS) return;
    lastSent = key;
    lastSentAt = Date.now();
    try {
      const res = await fetch(ctx.url('/report'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: pageId, state: s })
      });
      if (res.status === 409) { lastSent = ''; void beat(); }
    } catch { lastSent = ''; }
  }
  /* Changes come in bursts — a GO is a fired, a changed and an armed — so they
     are gathered into one report. */
  const reportSoon = () => { if (!soon) soon = setTimeout(report, 100); };

  /* ------------------------------------------------------------ wiring up */

  let stream = null;
  function listen() {
    if (stream) return;
    /* The open stream is what holds the lease; the beat is the fallback. */
    stream = new EventSource(`${ctx.url('/stream')}?page=${encodeURIComponent(pageId)}`);
    stream.addEventListener('lease', (ev) => {
      try { heard(JSON.parse(ev.data).runner); } catch { /* the next beat says */ }
    });
    stream.addEventListener('command', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      /* Every page hears every command; only the holder named on it acts. */
      if (msg && msg.runner === pageId) void run(msg);
    });
  }

  /* The stack is built by the Timeline when it starts, which may be after this
     does; hook its events the first time it is there, and again if it is
     rebuilt (switched off and on). */
  let hooked = null;
  const onFired = (ev) => {
    const d = ev.detail || {};
    lastFired = { id: d.cueId, number: String(d.number || ''), label: d.label || '', at: d.at || Date.now() };
    if (!lastFired.number) {
      const stack = ctx.use('stack');
      const i = stack ? stack.cues().findIndex((c) => c.id === d.cueId) : -1;
      if (i >= 0) lastFired.number = String(i + 1);
    }
    reportSoon();
  };
  function hook() {
    const stack = ctx.use('stack');
    if (stack === hooked) return;
    if (hooked) { hooked.removeEventListener('fired', onFired); for (const t of ['changed', 'armed', 'stopped', 'end', 'waiting', 'cancelled']) hooked.removeEventListener(t, reportSoon); }
    hooked = stack;
    if (stack) { stack.addEventListener('fired', onFired); for (const t of ['changed', 'armed', 'stopped', 'end', 'waiting', 'cancelled']) stack.addEventListener(t, reportSoon); }
  }
  let chased = null;
  function hookChase() {
    const tc = ctx.use('timecode');
    const chase = tc ? tc.chase : null;
    if (chase === chased) return;
    if (chased) { chased.removeEventListener('armed', reportSoon); chased.removeEventListener('disarmed', reportSoon); }
    chased = chase;
    if (chase) { chase.addEventListener('armed', reportSoon); chase.addEventListener('disarmed', reportSoon); }
  }

  listen();
  void beat();
  const beating = setInterval(beat, BEAT_MS);
  const looking = setInterval(() => { hook(); hookChase(); void report(); }, LOOK_MS);
  hook();
  hookChase();
  const release = () => { if (holding()) void beat(true); };
  globalThis.addEventListener?.('pagehide', release);
  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(() => {
      clearInterval(beating);
      clearInterval(looking);
      clearTimeout(soon);
      if (stream) stream.close();
      if (hooked) hooked.removeEventListener('fired', onFired);
      release();
    });
  }
}

/* Exposed for tests, which drive the parts with no page around them. */
export { screenOf, onOff };
