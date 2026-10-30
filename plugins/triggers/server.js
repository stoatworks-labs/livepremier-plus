/*
 * Triggers — the plugin's server half: the destinations and triggers, the
 * sending, and the holds.
 *
 * ## Why the holds live here and not in the page
 *
 * A cue fires in a page, because the cue stack runs there. But what it sends
 * — OSC, Art-Net, sACN, MIDI over TCP — can only go from a process (there is
 * no UDP in a browser), and the moment to send it back is a deck's clip
 * ending, which the HyperDecks plugin's server half hears on its own link. So
 * the server keeps the hold and sends the back lines itself: the house
 * lights come back up and the desk mutes again **even if the tab that fired
 * the cue was closed or reloaded mid-VT**. Only the switcher half of a
 * restore — `then go`, `then cue 13` — needs a page, the page that fired it,
 * because its cue stack is that page's. That is the Timeline's own price, and
 * the panel says when no page took it.
 *
 * ## Journal before the change
 *
 * A hold is made, and saved, before the cue's go lines are sent, and it
 * records each DMX channel's level as the go lines change it — the `before`
 * that a back line asks for. A hold found at startup was waiting when the app
 * stopped: it is offered, Restore now or Discard, and never fired by itself.
 *
 * The deck list comes from the HyperDecks plugin's `decks` service, asked for
 * again every second, so either plugin can be switched off and on in any
 * order without leaving a dead subscription behind.
 */

import { randomUUID } from 'node:crypto';

import { Outputs } from './outputs.js';
import {
  normaliseSetup, normaliseHolds, parseLine, lineProblems, cueName, formatRestore, formatDuration,
} from './core.js';

const LOG = 60;
const THEN_WAIT_MS = 3000;
const DECK_WATCH_MS = 1000;

export default async function activate(ctx) {
  const outputs = new Outputs({ log: ctx.log });
  ctx.onDispose(() => outputs.stop());

  let setup = normaliseSetup(ctx.storage ? await ctx.storage.load('triggers') : null);
  /* Whatever was waiting when the app last stopped is offered, not armed. */
  let holds = normaliseHolds(ctx.storage ? await ctx.storage.load('trigger-holds') : null).map((h) => ({ ...h, stale: true }));
  const log = [];
  const timers = new Map();
  const awaitingThen = new Map();
  /* The level a channel had before the last go that set it, for a test of back with no hold. */
  const lastBefore = new Map();

  /* ------------------------------------------------------------ state out */

  let deckService = null;
  let unsubscribe = null;
  const deckList = () => {
    try { return deckService ? deckService.list() : []; } catch { return []; }
  };

  const publicHold = (h) => ({ ...h, deadline: h.restore.after ? h.at + h.restore.after * 1000 : null });
  const snapshot = () => ({
    ...setup,
    problems: lineProblems(setup),
    holds: holds.map(publicHold),
    decks: deckList(),
    universes: outputs.describe(),
    log,
  });

  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('state', snapshot()) });
  let pending = null;
  function changed() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; stream.send('state', snapshot()); }, 50);
    pending.unref?.();
  }
  outputs.onChange = changed;
  ctx.onDispose(() => { if (pending) clearTimeout(pending); });

  function note(text, warn = false) {
    log.unshift({ at: Date.now(), text, warn });
    log.length = Math.min(log.length, LOG);
    if (warn) ctx.log(`triggers: ${text}`);
    changed();
  }

  const persistHolds = () => (ctx.storage ? ctx.storage.save('trigger-holds', { holds }) : Promise.resolve());

  async function save(next) {
    setup = normaliseSetup(next);
    if (ctx.storage) await ctx.storage.save('triggers', setup);
    outputs.apply(setup.destinations);
    changed();
  }

  /* ------------------------------------------------------------ sending */

  const triggerNamed = (id) => setup.triggers.find((t) => t.id === id) || null;

  /** One line, now. A DMX level of `before` is read from the hold, else from the last go. */
  async function sendLine(text, side, hold) {
    const msg = parseLine(text, setup.destinations);
    const dest = setup.destinations.find((d) => d.id === msg.dest);
    if (msg.type === 'dmx' && !msg.release) {
      const levels = [];
      for (const ch of msg.channels) {
        const key = `${dest.id}:${ch}`;
        if (side === 'go') {
          /* Record what the channel was before this go — once per hold, so a
             re-fired cue still puts back the look from before the first. */
          const was = outputs.level(dest.id, ch) ?? 0;
          if (hold) {
            hold.before[dest.id] = hold.before[dest.id] || {};
            if (!(ch in hold.before[dest.id])) hold.before[dest.id][ch] = was;
          }
          lastBefore.set(key, was);
        }
        const before = hold?.before?.[dest.id]?.[ch] ?? lastBefore.get(key) ?? 0;
        levels.push([ch, msg.before ? before : msg.level]);
      }
      msg.levels = levels;
    }
    await outputs.send(dest, msg);
  }

  /** A trigger's go or back lines, in order, each one whatever the one before did. */
  async function sendTrigger(trigger, side, hold) {
    const results = [];
    for (const line of trigger[side]) {
      try {
        await sendLine(line, side, hold);
        results.push({ line, ok: true });
      } catch (err) {
        results.push({ line, ok: false, error: err.message });
      }
    }
    return results;
  }

  const failures = (results) => results.filter((r) => !r.ok).map((r) => `${r.line}: ${r.error}`);

  /* ------------------------------------------------------------ holds */

  function arm(hold) {
    if (hold.stale) return;
    if (timers.has(hold.id)) clearTimeout(timers.get(hold.id));
    timers.delete(hold.id);
    if (hold.restore.after) {
      const left = Math.max(0, hold.at + hold.restore.after * 1000 - Date.now());
      const t = setTimeout(() => { void restoreHold(hold.id, `${formatDuration(hold.restore.after)} passed`, { then: true }); }, left);
      t.unref?.();
      timers.set(hold.id, t);
    }
  }

  /**
   * Send a hold's back lines — its triggers in reverse order, as an undo is —
   * and hand its `then` to the page that fired it. Only an end the show
   * reached by itself, a deck's clip or the time, does the `then`: at the next
   * cue, or by hand, the operator has already moved the stack.
   */
  async function restoreHold(id, why, { then = false } = {}) {
    const hold = holds.find((h) => h.id === id);
    if (!hold) return { ok: false, error: 'no such hold' };
    /* Out of the list first, so a deck end and a timer arriving together restore once. */
    holds = holds.filter((h) => h !== hold);
    if (timers.has(id)) { clearTimeout(timers.get(id)); timers.delete(id); }
    void persistHolds();

    const results = [];
    for (const tid of [...hold.fire].reverse()) {
      const trigger = triggerNamed(tid);
      if (!trigger) { results.push({ line: tid, ok: false, error: 'that trigger has been deleted' }); continue; }
      results.push(...await sendTrigger(trigger, 'back', hold));
    }
    const bad = failures(results);
    note(`${cueName(hold.cue)} restored — ${why}${bad.length ? `; ${bad.join('; ')}` : ''}`, bad.length > 0);

    if (hold.restore.then && !then) {
      note(`${cueName(hold.cue)}: its “then” was left — restored ${why}, not by the show`);
    } else if (hold.restore.then) {
      if (hold.stale) {
        note(`${cueName(hold.cue)}: its “then” was not done — it was waiting from before the app restarted`, true);
      } else {
        stream.send('restored', { hold: publicHold(hold), then: hold.restore.then });
        const t = setTimeout(() => {
          awaitingThen.delete(id);
          note(`${cueName(hold.cue)}: no page did its “then” — the page that fired it has closed or reloaded`, true);
        }, THEN_WAIT_MS);
        t.unref?.();
        awaitingThen.set(id, t);
      }
    }
    changed();
    return { ok: bad.length === 0, results };
  }

  async function fire({ page, cue, fire: ids, restore }) {
    const fireIds = Array.isArray(ids) ? ids.map(String) : [];
    const results = [];
    let hold = null;
    if (restore) {
      const [norm] = normaliseHolds([{ id: 'x', restore }]);
      hold = holds.find((h) => !h.stale && h.page === page && h.cue.id === cue.id) || null;
      if (hold) {
        hold.restore = norm.restore;
        hold.at = Date.now();
        for (const id of fireIds) if (!hold.fire.includes(id)) hold.fire.push(id);
      } else {
        hold = { id: randomUUID(), page, cue, fire: fireIds, restore: norm.restore, before: {}, at: Date.now(), stale: false };
        holds.push(hold);
      }
      await persistHolds();
    }
    for (const id of fireIds) {
      const trigger = triggerNamed(id);
      if (!trigger) { results.push({ line: id, ok: false, error: 'no such trigger' }); continue; }
      results.push(...await sendTrigger(trigger, 'go', hold));
    }
    if (hold) {
      /* The levels recorded while the lines went out. */
      await persistHolds();
      arm(hold);
    }
    const bad = failures(results);
    const names = fireIds.map((id) => triggerNamed(id)?.name ?? id);
    note(`${cueName(cue)}: ${names.length ? names.join(', ') : 'no triggers'}${hold ? ` — ${formatRestore(hold.restore, deckList())}` : ''}${bad.length ? `; ${bad.join('; ')}` : ''}`, bad.length > 0);
    changed();
    return { ok: bad.length === 0, results, hold: hold ? hold.id : null };
  }

  /* ------------------------------------------------------------ the decks */

  function onDeckEnded(e) {
    const name = deckList().find((d) => d.id === e.deck)?.name ?? e.deck;
    for (const h of holds.filter((x) => !x.stale && x.restore.deck === e.deck)) {
      void restoreHold(h.id, e.clip != null ? `${name} clip ${e.clip} ended` : `${name}’s clip ended`, { then: true });
    }
  }

  function watchDecks() {
    const svc = typeof ctx.use === 'function' ? ctx.use('decks') : null;
    if (svc === deckService) return;
    try { unsubscribe?.(); } catch { /* its plugin has gone */ }
    unsubscribe = null;
    deckService = svc;
    if (svc && typeof svc.onEnded === 'function') unsubscribe = svc.onEnded(onDeckEnded);
    changed();
  }
  watchDecks();
  const deckTimer = setInterval(watchDecks, DECK_WATCH_MS);
  deckTimer.unref?.();
  ctx.onDispose(() => {
    clearInterval(deckTimer);
    try { unsubscribe?.(); } catch { /* gone */ }
    for (const t of timers.values()) clearTimeout(t);
    for (const t of awaitingThen.values()) clearTimeout(t);
  });

  /* ------------------------------------------------------------ routes */

  ctx.route('GET', '/', (req, res, h) => h.json(200, snapshot()));
  const put = async (req, res, h) => {
    const body = await h.readJson(512 * 1024);
    await save(body);
    h.json(200, { ok: true, ...snapshot() });
  };
  ctx.route('PUT', '/', put);
  ctx.route('POST', '/', put);

  /* A cue firing: `{ page, cue: { id, number, label }, fire: [trigger ids], restore }`. */
  ctx.route('POST', '/fire', async (req, res, h) => {
    const body = await h.readJson(64 * 1024);
    const cue = { id: String(body.cue?.id ?? ''), number: String(body.cue?.number ?? ''), label: String(body.cue?.label ?? '') };
    const r = await fire({ page: String(body.page ?? ''), cue, fire: body.fire, restore: body.restore || null });
    h.json(r.ok ? 200 : 207, r);
  });

  /* Another cue fired in a page: its holds that end at the next cue end now. */
  ctx.route('POST', '/next', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const page = String(body.page ?? '');
    const cueId = String(body.cue ?? '');
    const due = holds.filter((x) => !x.stale && x.restore.next && x.page === page && x.cue.id !== cueId);
    for (const hold of due) await restoreHold(hold.id, 'at the next cue');
    h.json(200, { ok: true, restored: due.length });
  });

  /* `{ id }` restores one hold now; `{ all: true }` every one, newest first. */
  ctx.route('POST', '/restore', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const ids = body.all ? holds.map((x) => x.id).reverse() : [String(body.id ?? '')];
    const out = [];
    for (const id of ids) out.push(await restoreHold(id, body.all ? 'Restore all' : 'by hand'));
    const ok = out.every((r) => r.ok);
    h.json(ok ? 200 : 207, { ok, results: out });
  });

  ctx.route('POST', '/discard', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const hold = holds.find((x) => x.id === String(body.id ?? ''));
    if (!hold) throw new ctx.HttpError(404, 'no such hold');
    holds = holds.filter((x) => x !== hold);
    if (timers.has(hold.id)) { clearTimeout(timers.get(hold.id)); timers.delete(hold.id); }
    await persistHolds();
    note(`${cueName(hold.cue)}: discarded, nothing sent`);
    h.json(200, { ok: true });
  });

  /* The page that fired a hold did its `then`, or could not. */
  ctx.route('POST', '/then', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const id = String(body.hold ?? '');
    if (awaitingThen.has(id)) { clearTimeout(awaitingThen.get(id)); awaitingThen.delete(id); }
    note(body.ok ? `then: ${body.text}` : `then failed: ${body.text}`, !body.ok);
    h.json(200, { ok: true });
  });

  /* A trigger's go or back lines now, from the panel's Test buttons. */
  ctx.route('POST', '/test', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const trigger = triggerNamed(String(body.trigger ?? ''));
    if (!trigger) throw new ctx.HttpError(404, 'no such trigger');
    const side = body.side === 'back' ? 'back' : 'go';
    const results = await sendTrigger(trigger, side, null);
    const bad = failures(results);
    note(`test ${trigger.name} ${side}${bad.length ? `: ${bad.join('; ')}` : ''}`, bad.length > 0);
    h.json(bad.length ? 207 : 200, { ok: bad.length === 0, results });
  });

  /* Stop sending a universe: the panel's Release. */
  ctx.route('POST', '/release', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const dest = setup.destinations.find((d) => d.id === String(body.dest ?? ''));
    if (!dest) throw new ctx.HttpError(404, 'no such destination');
    await outputs.release(dest.id);
    note(`${dest.name} released`);
    h.json(200, { ok: true });
  });

  /* For another plugin: desk control fires triggers when the switcher takes
     (its `feedback.js`). Go lines only, and no hold: a take is not a cue with
     a VT to wait for. */
  ctx.provide('triggers', {
    list: () => setup.triggers.map((t) => ({ id: t.id, name: t.name })),
    async fire(ids, why) {
      const results = [];
      const names = [];
      for (const id of [].concat(ids).map(String)) {
        const trigger = triggerNamed(id);
        if (!trigger) { results.push({ line: id, ok: false, error: 'no such trigger' }); continue; }
        names.push(trigger.name);
        results.push(...await sendTrigger(trigger, 'go', null));
      }
      const bad = failures(results);
      note(`${why}: ${names.length ? names.join(', ') : 'no triggers'}${bad.length ? `; ${bad.join('; ')}` : ''}`, bad.length > 0);
      return { ok: bad.length === 0, results, names };
    },
  });

  ctx.contribute('configSection', {
    key: 'triggers',
    group: 'installation',
    label: 'Triggers',
    export: () => (setup.destinations.length || setup.triggers.length ? setup : undefined),
    import: (data) => save(data),
  });

  outputs.apply(setup.destinations);
  if (holds.length) note(`${holds.length} restore${holds.length === 1 ? ' was' : 's were'} waiting when the app stopped — Restore now, or Discard`, true);
}
