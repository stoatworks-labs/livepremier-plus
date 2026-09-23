/*
 * Layer Lock — the engine: the follower, the take gate and the partial take.
 *
 * `src/core/layer-lock.js` has the rules and the one fact they stand on — a
 * layer identical in program and preview has nothing to transition. This is
 * the part with timers and a socket, kept out of the panel so a test can
 * drive it with a fake session and a fake clock.
 *
 * ## Three mechanisms, because no one of them is enough
 *
 * - **The follower.** While a layer is locked, any change seen to its program
 *   or preview copy — the vendor's properties, a memory recall into preview,
 *   our own Layer tab — is answered by writing preview back into line with
 *   program, property by property, only where they differ. Like the layer
 *   groups' gang it writes without being asked for that write specifically,
 *   so it inherits the gang's rules: nothing mid-take, nothing on state it
 *   merely found when the page opened, and convergent by construction (a
 *   second pass builds nothing).
 * - **The take gate.** A recall into preview followed at once by a TAKE — a
 *   cue does exactly this, 150 ms apart — can beat the follower. So every
 *   TAKE or CUT leaving this page, the vendor's own button included, passes
 *   `gate()` in `src/hook/ws-hook.js` first. A take on a destination whose
 *   locked layers already agree goes straight out, untouched. One whose
 *   layers do not is held while they are written, until the switcher has
 *   echoed every write or `ECHO_WAIT_MS` has passed, and then released. The
 *   hook sends a held frame itself after 750 ms whatever happens here.
 * - **The partial take.** Hold every layer but the chosen ones, take, wait for
 *   the take to land, and write the held layers' preview looks back into what
 *   is now preview.
 *
 * ## ⚠️ What none of them can reach
 *
 * Only a take that leaves THIS page is gated. The front panel, a T-bar, an
 * OSC take (`server/osc.js` writes over AWJ from the server), Companion's own
 * AWJ connection and another operator's browser all go straight to the
 * switcher. The follower narrows that — a locked layer is usually already in
 * line before anyone presses anything — but a recall and a take from outside
 * inside the same few milliseconds will move a locked layer, and nothing here
 * can stop it. The panel says so in as many words.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { presetBanks } from '../../src/core/screens.js';
import { commandsFor } from '../../src/core/commands.js';
import { startsWith, key as pathKey } from '../../src/core/paths.js';
import {
  lockedOn, lockedDestinations, syncWrites, takeTarget, snapshot, restoreWrites, partialPlan
} from '../../src/core/layer-lock.js';

/** How long a held take waits for the switcher to echo the writes ahead of it. */
export const ECHO_WAIT_MS = 300;

/** How long the follower lets a burst of frames finish before it looks. */
export const FOLLOW_DEBOUNCE_MS = 40;

const echoKey = (cmd) => `${pathKey(cmd.path)}=${JSON.stringify(cmd.value)}`;

/** Above the configured fade, how long a partial take may take to land. */
const TAKE_GRACE_MS = 3000;
const POLL_MS = 40;

/**
 * @param {object} o
 * @param {{get: Function}} o.store
 * @param {(cmd: {path: string[], value: unknown}) => boolean} o.send
 * @param {() => string[]} o.locks           the lock list, read per use
 * @param {(report: object) => void} [o.onActivity]
 * @param {object} [o.clock]                  `{ now, setTimeout, clearTimeout }`, for tests
 */
export function createLockEngine({ store, send, locks, onActivity = () => {}, clock = globalThis }) {
  const now = () => (clock.now ? clock.now() : Date.now());
  const timers = new Map();          // id -> follow debounce
  const holding = new Map();         // id -> layer keys a partial take is holding
  const waiters = new Set();         // echo waiters: { keys:Set, done }
  const queue = new Map();           // id -> promise a held take is waiting on

  const dialect = () => dialectFor(store);
  const lockedLayers = (id) => {
    const extra = holding.get(id) || [];
    return [...new Set([...lockedOn(locks(), id), ...extra])];
  };

  /* --------------------------------------------------------------- echoes */

  /**
   * Resolve once every write has come back inbound, or after `ms`.
   *
   * ⚠️ Matched on path AND value. Found on the simulator 2026-09-23: a recall
   * writes preview's layer, the lock writes the same path straight back, and
   * the recall's own echo arrives first — matched on path alone it released
   * the TAKE before the lock's write had been acknowledged. A value the
   * switcher clamps never matches and costs the full wait, never a take.
   */
  function waitForEchoes(writes, ms = ECHO_WAIT_MS) {
    if (!writes.length) return Promise.resolve({ missing: 0 });
    return new Promise((resolve) => {
      const w = { keys: new Set(writes.map(echoKey)), done: null };
      const finish = () => {
        waiters.delete(w);
        clock.clearTimeout(w.timer);
        resolve({ missing: w.keys.size });
      };
      w.done = finish;
      w.timer = clock.setTimeout(finish, ms);
      waiters.add(w);
    });
  }

  function sendAll(writes) {
    let sent = 0;
    for (const cmd of writes) if (send(cmd)) sent++;
    return sent;
  }

  /* ------------------------------------------------------------- follower */

  /**
   * Look at one frame. Inbound frames settle echo waiters; any frame that
   * touches a locked layer's program or preview copy, or the destination's
   * transition state, schedules a look at that destination.
   */
  function onFrame(frame) {
    if (!frame || !Array.isArray(frame.path)) return;
    if (frame.dir === 'in' && waiters.size) {
      const k = echoKey(frame);
      for (const w of [...waiters]) {
        if (w.keys.delete(k) && w.keys.size === 0) w.done();
      }
    }
    const d = dialect();
    if (!d) return;
    for (const id of lockedDestinations(locks())) {
      if (touches(d, id, frame.path)) { schedule(id); }
    }
  }

  function touches(d, id, path) {
    if (startsWith(path, d.takeStatus(id, 'transition').slice(0, -1))) return true;
    const banks = presetBanks(store, id);
    for (const layer of lockedOn(locks(), id)) {
      for (const letter of [banks.program, banks.preview]) {
        const prefix = d.layerParamPath(id, letter, layer, []);
        if (prefix && startsWith(path, prefix)) return true;
      }
    }
    return false;
  }

  function schedule(id) {
    if (timers.has(id)) return;
    timers.set(id, clock.setTimeout(() => { timers.delete(id); follow(id); }, FOLLOW_DEBOUNCE_MS));
  }

  /**
   * Bring one destination's locked layers into line. Returns what it did;
   * a refusal (mid-take, nothing reported) is not an error, and the next
   * frame after the take lands looks again.
   */
  function follow(id, why = 'followed') {
    const layers = lockedOn(locks(), id);
    if (!layers.length) return { id, sent: 0 };
    const { writes, refused } = syncWrites(store, id, layers);
    if (refused) return { id, sent: 0, refused };
    if (!writes.length) return { id, sent: 0 };
    const sent = sendAll(writes);
    onActivity({ kind: why, id, sent, layers });
    return { id, sent };
  }

  /* ------------------------------------------------------------------ gate */

  /**
   * The hook's outbound gate. `true` means "held, and `release` will be
   * called"; anything else lets the frame go.
   */
  function gate(raw, release) {
    if (typeof raw !== 'string' || raw.indexOf('"x') < 0) return false;
    let msg;
    try { msg = JSON.parse(raw); } catch { return false; }
    const data = msg && msg.channel === 'DEVICE' ? msg.data : null;
    if (!data) return false;
    const t = takeTarget(dialect(), data.path, data.value);
    if (!t) return false;

    const ahead = queue.get(t.id);
    const layers = lockedLayers(t.id);
    if (!layers.length && !ahead) return false;

    const { writes, refused } = layers.length ? syncWrites(store, t.id, layers) : { writes: [] };
    /* Mid-take there is nothing honest to write; let the take do what it
       would have done without us rather than hold it for nothing. */
    if (refused && !ahead) return false;
    if (!writes.length && !ahead) return false;

    /* A second TAKE pressed while the first is held must not overtake it:
       with the writes already mirrored it would find nothing to fix and go
       out first, and the held one would then take a second time. */
    const run = (ahead || Promise.resolve()).then(async () => {
      const sent = sendAll(writes);
      const { missing } = await waitForEchoes(writes);
      if (sent) onActivity({ kind: 'held', id: t.id, sent, missing, prop: t.prop, layers });
      release();
    });
    queue.set(t.id, run);
    run.finally(() => { if (queue.get(t.id) === run) queue.delete(t.id); });
    return true;
  }

  /* --------------------------------------------------------- partial take */

  /**
   * Take only `targets` — `[{id, layer}]`, on one destination or several.
   *
   * Refuses before writing anything if any destination involved is mid-take
   * or has not reported its buffers: half a partial take is worse than none.
   */
  async function takeOnly(targets, { restore = true } = {}) {
    const d = dialect();
    if (!d) return { ok: false, message: 'the device store has not arrived' };
    const { plans, refused } = partialPlan(store, targets, locks());
    if (!plans.length) return { ok: false, message: refused.join(' · ') || 'nothing to take' };
    for (const p of plans) {
      const banks = presetBanks(store, p.id);
      if (!banks.reported) return { ok: false, message: `${p.id}: the device has not said which buffer is preview` };
      if (!banks.settled) return { ok: false, message: `${p.id}: a take is in flight` };
      if (holding.has(p.id)) return { ok: false, message: `${p.id}: a partial take is already running` };
    }

    const cmds = commandsFor(d);
    const runs = plans.map((p) => {
      const before = presetBanks(store, p.id);
      return {
        ...p,
        before,
        kept: restore ? snapshot(store, p.id, before.preview, p.restore) : null,
        fadeMs: fadeMs(d, p.id)
      };
    });

    const allWrites = [];
    for (const r of runs) {
      holding.set(r.id, r.hold);
      const { writes } = syncWrites(store, r.id, r.hold);
      sendAll(writes);
      allWrites.push(...writes);
    }
    try {
      const { missing } = await waitForEchoes(allWrites);
      for (const r of runs) send(cmds.take(r.id));
      await Promise.all(runs.map((r) => landed(r.id, r.before.transition, r.fadeMs + TAKE_GRACE_MS)));
    } finally {
      for (const r of runs) holding.delete(r.id);
    }

    let restored = 0;
    const notes = [...refused];
    for (const r of runs) {
      const after = presetBanks(store, r.id);
      if (!after.settled || after.transition === r.before.transition) {
        notes.push(`${r.id}: the take did not land — preview left as it is`);
        continue;
      }
      if (r.kept) restored += sendAll(restoreWrites(store, r.id, after.preview, r.kept));
    }
    const what = runs.map((r) => `${r.id} ${r.go.map((k) => (k === 'NATIVE' ? 'NATIVE' : 'L' + k)).join('+')}`).join(', ');
    onActivity({ kind: 'partial', what, restored });
    return {
      ok: notes.length === refused.length,
      message: [`took ${what}${restored ? `, preview put back (${restored} propert${restored === 1 ? 'y' : 'ies'})` : ''}`, ...notes].join(' · ')
    };
  }

  function fadeMs(d, id) {
    const path = d.fadeTimePath ? d.fadeTimePath(id) : null;
    const tenths = path ? store.get(path) : null;
    return Number.isFinite(tenths) ? tenths * 100 : 1000;
  }

  /** Wait until the destination rests at the other end from where it began. */
  function landed(id, from, ms) {
    const until = now() + ms;
    return new Promise((resolve) => {
      const look = () => {
        const b = presetBanks(store, id);
        if ((b.settled && b.transition !== from) || now() >= until) return resolve(b);
        clock.setTimeout(look, POLL_MS);
      };
      clock.setTimeout(look, POLL_MS);
    });
  }

  return {
    onFrame,
    gate,
    follow,
    takeOnly,
    /** Bring every locked layer into line now — called when a lock is set. */
    syncAll(why = 'locked') {
      return lockedDestinations(locks()).map((id) => follow(id, why));
    },
    dispose() {
      for (const t of timers.values()) clock.clearTimeout(t);
      timers.clear();
      for (const w of [...waiters]) w.done();
    }
  };
}
