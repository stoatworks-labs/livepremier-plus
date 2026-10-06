/*
 * Preview lock during takes — the rules, with no DOM and no I/O.
 *
 * ## The failure this exists for
 *
 * Press TAKE, then recall the next memory into preview straight away. On
 * either platform the switcher resolves `PREVIEW` against the transition
 * state, and while a take is in flight (`EFFECT_FROM_*`, `COPY_FROM_*`) the
 * buffer it calls preview is the one **arriving on program** — the same
 * suffix rule `core/dialect.js` documents for `buffers()`. So the recall lands
 * in the picture that is fading up, and rides the take onto the output. No
 * error anywhere; the wrong look is simply on air.
 *
 * ## The guard rail that already exists
 *
 * Web RCS draws a PRW padlock on every screen card, and its own Redux
 * middleware (`presetLockMiddleware` in the 6.2.73 bundle) refuses any of the
 * vendor UI's recalls — screen, aux, layer and master memories — into a
 * buffer whose role is locked, with its own "memory load" warning. The lock is
 * keyed by ROLE per screen, not by letter. So the whole fix is: shut that
 * padlock the moment a take starts, open it again when the take lands. The
 * operator sees the vendor's own padlock close and the vendor's own warning if
 * they recall too early; nothing here invents a second lock.
 *
 * This file decides WHEN. It is fed frames and reads the store mirror; the
 * page half (`client.js`) owns the padlock and is handed `lock(id)` /
 * `unlock(id)`.
 *
 * ## When a destination is guarded
 *
 * - **A take leaves this page** — `xTake`, `xTakeUp`, `xTakeDown` going out,
 *   the vendor's own button included. This is the earliest moment there is,
 *   ahead of the switcher's first status echo, and it is the case the
 *   operator asked about: TAKE, then a recall a fraction of a second later.
 *   `xCut` is not a reason: a cut has no window to recall into.
 * - **The switcher reports a transition in flight** from anywhere — the front
 *   panel, a T-bar, Companion, OSC, another browser. Later than the first
 *   case by the echo, but it covers every take this page did not send.
 *
 * ## When it is released
 *
 * When the destination is at rest again (`AT_UP` / `AT_DOWN`) and the take
 * actually happened: it was seen in flight, or it now rests at the other end.
 * A take this page sent that never starts — refused, or nothing to take — is
 * let go after `START_GRACE_MS` at the end it began from, so a padlock is
 * never left shut by a take that did not happen. There is deliberately no cap
 * on a transition that stays in flight: a T-bar parked half way has preview
 * half on air, which is exactly when the lock should hold.
 *
 * ## Our own recalls wait instead
 *
 * The padlock stops the vendor's UI, not the switcher, so a recall this app
 * sends over the socket would go straight through it. The Timeline's cue
 * engine, the Memories panel and the Console therefore ask first, through the
 * `preview-lock` service: `previewRecallTargets()` says which destinations a
 * write would load into preview, and `whenSettled()` is a promise that those
 * destinations' takes have landed. A recall made mid-take is not refused —
 * it **waits**, and goes into the new preview the moment the take lands.
 *
 * It does not wait for ever. A take ends when its take time says it will;
 * past that plus `HOLD_GRACE_MS` (a T-bar parked half way, a status that
 * never arrived) the wait gives up and the caller does NOT send, and says so.
 * Sending late into the arriving buffer is the one outcome this exists to
 * prevent, so "gave up" means "did not send", never "sent anyway".
 *
 * ## ⚠️ What it still cannot reach
 *
 * Companion, OSC (`server/osc.js` writes from the server, which has no take
 * state), the front panel and another browser. `lockedFor()` in
 * `src/ui/preset-lock.js` reads the padlock itself for a panel that wants it.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { presetBanks } from '../../src/core/screens.js';
import { takeTarget } from '../../src/core/layer-lock.js';
import { startsWith } from '../../src/core/paths.js';

/** A take this page sent that has not started by now did not happen. */
export const START_GRACE_MS = 1500;

/** How long past its take time a held recall waits before it gives up. */
export const HOLD_GRACE_MS = 3000;

/** The lists a recall names its destination in: nlc's two, mng's aux list. */
const DEST_LISTS = { screenList: 'S', auxiliaryList: 'A', auxiliaryScreenList: 'A' };

/**
 * Which destinations a write would load a memory into PREVIEW on.
 *
 * Read off the shape every recall has on both platforms and every bank —
 * `…/control/load/slotList/items/<n>/…/presetList/items/PREVIEW/…/xRequest
 * = true`, with the destination named by the list before it (`screenList` /
 * `auxiliaryList` keyed `S1` / `A1` on LivePremier, `screenList` /
 * `auxiliaryScreenList` keyed `1` on Midra). A master memory names no
 * destination and covers whichever screens it was saved with, so it answers
 * `['*']`: every destination mid-take. A recall into PROGRAM, a save, or
 * anything else answers null.
 *
 * @returns {string[]|null}
 */
export function previewRecallTargets(path, value) {
  if (value !== true || !Array.isArray(path) || path[path.length - 1] !== 'xRequest') return null;
  const load = path.indexOf('load');
  if (load < 1 || path[load - 1] !== 'control') return null;
  const preset = path.indexOf('presetList', load);
  if (preset < 0 || path[preset + 1] !== 'items' || path[preset + 2] !== 'PREVIEW') return null;
  for (let i = load; i < preset; i++) {
    const kind = DEST_LISTS[path[i]];
    if (!kind || path[i + 1] !== 'items') continue;
    const key = String(path[i + 2]);
    if (isDest(key)) return [key];
    if (/^\d+$/.test(key)) return [kind + key];
    return null;
  }
  return ['*'];
}

/** Every destination a batch of writes would load into preview, or null. */
export function previewTargetsOf(cmds) {
  const out = new Set();
  for (const c of cmds || []) {
    const t = c ? previewRecallTargets(c.path, c.value) : null;
    if (t) for (const id of t) out.add(id);
  }
  return out.size ? [...out] : null;
}

/** The props on the take control that start a transition. `xCut` does not. */
export const TAKE_STARTS = Object.freeze(['xTake', 'xTakeUp', 'xTakeDown']);

const isDest = (v) => typeof v === 'string' && /^[SA]\d+$/.test(v);

/** Which destinations may be guarded: every one, less the operator's list. */
export function normalise(raw = {}) {
  const skip = Array.isArray(raw.skip) ? raw.skip : [];
  return { skip: [...new Set(skip.map((s) => String(s).trim().toUpperCase()).filter(isDest))].sort(byDest) };
}

function byDest(a, b) {
  return a[0] === b[0] ? Number(a.slice(1)) - Number(b.slice(1)) : (a[0] === 'S' ? -1 : 1);
}

/**
 * The destination a frame's path says something about the take state of,
 * or null. Matched against the dialect's own status node, in either
 * direction — a frame may carry the leaf (`…/pp/transition`) or the whole
 * `pp` object, and both have to count.
 */
export function statusDestination(dialect, path) {
  if (!dialect || !Array.isArray(path)) return null;
  let id = null;
  if (path[1] === 'screenAuxGroupList') id = path[3];
  else if (path[1] === 'transition') {
    const n = path[4];
    if (n != null) id = (path[2] === 'auxiliaryScreenList' ? 'A' : 'S') + n;
  }
  if (!isDest(id)) return null;
  const node = dialect.takeStatus(id, 'transition');
  return startsWith(node, path) || startsWith(path, node) ? id : null;
}

/**
 * The guard.
 *
 * @param {object} o
 * @param {{get: Function}} o.store                the page's mirror
 * @param {(id: string, why: string) => void} o.lock
 * @param {(id: string, why: string) => void} o.unlock
 * @param {() => {skip: string[]}} [o.settings]    read per use
 * @param {object} [o.clock]                        `{ now, setTimeout, clearTimeout }`, for tests
 */
export function createPreviewGuard({ store, lock, unlock, settings = () => ({ skip: [] }), clock = globalThis }) {
  const now = () => (clock.now ? clock.now() : Date.now());
  /** id -> { from, since, moving, cause, timer } */
  const guarded = new Map();
  /** Callers waiting for takes to land: { ids, asked, started, resolve, timer } */
  const waiters = new Set();

  const skipped = (id) => (settings().skip || []).includes(id);

  /** A destination's take time, in ms — the longer direction on LivePremier. */
  function takeMs(id) {
    const d = dialectFor(store);
    if (!d) return 0;
    const times = [store.get(d.fadeTimePath(id))];
    if (d.id === 'nlc') times.push(store.get(d.takeControl(id, 'takeDownTime')));
    const tenths = Math.max(0, ...times.filter(Number.isFinite));
    return tenths * 100;
  }

  function finish(w, result) {
    if (!waiters.delete(w)) return;
    if (w.timer) clock.clearTimeout(w.timer);
    w.resolve({ ...result, ids: w.asked, waitedMs: now() - w.started });
  }

  function settleWaiters() {
    for (const w of [...waiters]) {
      if ([...w.ids].every((id) => !guarded.has(id))) finish(w, { ok: true });
    }
  }

  function arm(id, cause) {
    if (guarded.has(id) || skipped(id)) return;
    const banks = presetBanks(store, id);
    const g = { from: banks.transition, since: now(), moving: !banks.settled, cause, timer: null };
    guarded.set(id, g);
    if (cause === 'take') {
      g.timer = clock.setTimeout(() => { g.timer = null; look(id); }, START_GRACE_MS);
    }
    lock(id, cause);
  }

  function release(id, why) {
    const g = guarded.get(id);
    if (!g) return;
    if (g.timer) clock.clearTimeout(g.timer);
    guarded.delete(id);
    unlock(id, why);
    settleWaiters();
  }

  /** Read the destination's take state off the mirror and act on it. */
  function look(id) {
    const banks = presetBanks(store, id);
    const g = guarded.get(id);
    if (!banks.reported) {
      /* A take sent to a destination that has never said where its T-bar
         is: nothing will ever say it landed, so the grace is all there is. */
      if (g && g.cause === 'take' && now() - g.since >= START_GRACE_MS) release(id, 'never started');
      return;
    }
    if (!banks.settled) {
      if (g) g.moving = true;
      else arm(id, 'moving');
      return;
    }
    if (!g) return;
    if (g.moving || banks.transition !== g.from) return release(id, 'landed');
    /* At rest where it started and never seen moving: still waiting for a
       take this page sent to show up — until the grace runs out. */
    if (g.cause === 'take' && now() - g.since >= START_GRACE_MS) release(id, 'never started');
  }

  return {
    /** Feed every frame the session sees, both directions. */
    onFrame(frame) {
      if (!frame || !Array.isArray(frame.path)) return;
      const d = dialectFor(store);
      if (!d) return;
      if (frame.dir === 'out') {
        const t = takeTarget(d, frame.path, frame.value);
        if (t && TAKE_STARTS.includes(t.prop)) arm(t.id, 'take');
        return;
      }
      const id = statusDestination(d, frame.path);
      if (id) look(id);
    },
    /** What is guarded now: `[{id, cause, since}]`. */
    guarded() {
      return [...guarded.entries()].map(([id, g]) => ({ id, cause: g.cause, since: g.since }));
    },
    isGuarded: (id) => guarded.has(id),
    /**
     * A promise that these destinations' takes have landed, or null when
     * none of them is mid-take — the caller then sends at once, exactly as
     * it would have without this plugin. `['*']` means every destination
     * mid-take (a master memory). Resolves `{ok: true}` when the last one
     * lands, or `{ok: false, message}` once the longest take time plus
     * `HOLD_GRACE_MS` has passed with one still in flight; the caller must
     * then not send.
     */
    whenSettled(ids) {
      const asked = Array.isArray(ids) ? ids : [];
      const want = asked.includes('*') ? [...guarded.keys()] : asked.filter((id) => guarded.has(id));
      if (!want.length) return null;
      const started = now();
      const deadline = Math.max(...want.map((id) => guarded.get(id).since + takeMs(id) + HOLD_GRACE_MS));
      return new Promise((resolve) => {
        const w = { ids: new Set(want), asked, started, resolve, timer: null };
        w.timer = clock.setTimeout(() => {
          const still = [...w.ids].filter((id) => guarded.has(id));
          finish(w, {
            ok: false,
            message: `${still.join(', ')} still mid-take after ${((now() - started) / 1000).toFixed(1)} s`
          });
        }, Math.max(deadline - started, HOLD_GRACE_MS));
        waiters.add(w);
      });
    },
    /** Let everything go — the plugin is stopping, or a destination was skipped mid-take. */
    releaseAll(why = 'stopped') {
      for (const id of [...guarded.keys()]) release(id, why);
    },
    release
  };
}
