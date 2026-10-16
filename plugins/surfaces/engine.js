/*
 * Surfaces — the engine: the shaper, the toolbar's intent, and the follower.
 *
 * `core.js` has the rule. This is the part with a socket and timers, kept out
 * of the panel so a test can drive it with a fake store and a fake clock.
 *
 * ## Three ways a bound layer is kept in, because no one of them is enough
 *
 * - **The shaper**, in the socket hook (`src/hook/ws-hook.js`). Every
 *   geometry write for a bound layer that leaves THIS page — the vendor's
 *   drag, nudge, fields and toolbar, our Layer tab, the Console, a cue — is
 *   rewritten before it goes, so the switcher never sees the layer outside
 *   its surface, not even for one frame, program included. The vendor's drag
 *   sends four writes per step in one task; the hook hands the shaper all
 *   four, which is what lets a keep-ratio corner drag stop with its shape.
 * - **The toolbar's intent.** The vendor's full screen and align buttons are
 *   worked out in the browser against the whole screen and sent as plain
 *   positions; by the time they reach the wire, "centre" is just a number.
 *   So a click on one of those buttons (by its icon, `OPS`) is noted on the
 *   way down, and the writes it causes in the same task are redone against
 *   the surface. Without it, full screen still fills the surface (the canvas
 *   is recognised) and edge alignments still land on the surface's edges;
 *   only "centre" would come out at the nearest edge instead.
 * - **The follower.** Anything that does not leave this page — Companion's
 *   own AWJ connection, OSC, the front panel, another browser, a memory
 *   recall — is seen as it lands. A bound layer pushed outside its surface
 *   on the PREVIEW buffer is written back in. It inherits the gang's rules:
 *   nothing mid-take, nothing on state merely found when the page opened,
 *   never program, convergent (it writes only what differs, and what it
 *   writes is inside, so a second look finds nothing). And it has a fight
 *   limit: a layer something else keeps moving back out is let go and named,
 *   not looped on.
 *
 * ## Layer Lock wins
 *
 * A locked layer is kept equal to its program copy. If program has it
 * outside its surface, the lock writes that into preview, the shaper would
 * pull it in, the lock would write it back — for ever. So a locked layer is
 * left to the lock, by every one of the three, and the panel says so.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, presetBanks } from '../../src/core/screens.js';
import { key as pathKey, startsWith } from '../../src/core/paths.js';
import {
  anyBound, parseGeometry, boundSurface, boundLayers, shapeWrites, standing, constrain, wireFromRect
} from './core.js';

/** How long a value this page sent stands in for the mirror, while its echo is on the way. */
export const SENT_MS = 500;
/** How long the follower lets a burst of frames finish before it looks. */
export const FOLLOW_DEBOUNCE_MS = 40;
/** A layer corrected this often inside the window is let go. */
export const FIGHT_LIMIT = 3;
export const FIGHT_WINDOW_MS = 5000;
/** An intent outlives its task only by this much, in case the vendor sends from a promise. */
export const INTENT_MS = 250;
/**
 * When a rewritten value is told back to the page. The vendor's store
 * applies its own write about 4 ms AFTER sending it (6.2.73 simulator,
 * 2026-10-16), so an echo told at once is overwritten by the very value it
 * corrects; told later, it lands on top. Twice, for a busy machine.
 */
export const TELL_MS = Object.freeze([60, 300]);

const RECENT = 6;

/**
 * @param {object} o
 * @param {{get: Function, ready?: boolean}} o.store   the live mirror
 * @param {(cmd: {path: string[], value: unknown}) => boolean} o.send
 * @param {() => object} o.doc                         the normalised document
 * @param {(id: string, layer: string) => boolean} [o.exempt]  Layer Lock's
 * @param {(entry: object) => void} [o.onActivity]
 * @param {(raw: string) => boolean} [o.tellPage]       the hook's: a frame handed to the page as an echo
 * @param {object} [o.clock]                            `{ now, setTimeout, clearTimeout }`
 */
export function createSurfaceEngine({
  store, send, doc, exempt = () => false, onActivity = () => {}, tellPage = null, clock = globalThis
}) {
  const now = () => (clock.now ? clock.now() : Date.now());
  const sent = new Map();        // path key -> {value, at}: what this page last sent
  const timers = new Map();      // `${id}/${layer}` -> follow debounce
  const fights = new Map();      // `${id}/${layer}` -> correction times
  const letGo = new Set();       // `${id}/${layer}` the follower has given up on
  const telling = new Map();     // path key -> timers telling the page a rewritten value
  const recent = [];
  let intent = null;             // {op, at}

  const nlc = () => {
    const d = dialectFor(store);
    return d && d.id === 'nlc' ? d : null;
  };

  function note(entry) {
    recent.unshift({ at: now(), ...entry });
    recent.length = Math.min(recent.length, RECENT);
    try { onActivity(entry); } catch (_) { /* a panel's bug is not the engine's */ }
  }

  /** What a buffer holds, as far as this page knows: its own recent writes, then the mirror. */
  function read(path) {
    const hit = sent.get(pathKey(path));
    if (hit && now() - hit.at <= SENT_MS) return hit.value;
    return store.get(path);
  }

  function canvasOf(id) {
    const dest = listDestinations(store, { includeUnused: true }).find((d) => d.id === id);
    return dest && dest.canvas && dest.canvas.reported !== false ? dest.canvas : null;
  }

  /* ---------------------------------------------------------------- intent */

  /** A toolbar button that is a statement about the screen was pressed. */
  function setIntent(op) {
    intent = op ? { op, at: now() } : null;
    /* Cleared after this task: the vendor's handler dispatches inside the
       click, and the writes it causes are shaped before the task ends. */
    if (op) clock.setTimeout(() => { if (intent && intent.op === op) intent = null; }, 0);
  }

  const currentOp = () => (intent && now() - intent.at <= INTENT_MS ? intent.op : null);

  /* ---------------------------------------------------------------- shaper */

  function parse(raw) {
    try {
      const msg = JSON.parse(raw);
      return msg && msg.channel === 'DEVICE' && msg.data && Array.isArray(msg.data.path) ? msg.data : null;
    } catch (_) { return null; }
  }

  /** The hook's half of the contract: is this a frame to shape? */
  function wants(raw) {
    if (typeof raw !== 'string' || raw.indexOf('"position"') < 0 || raw.indexOf('"presetList"') < 0) return false;
    const d = doc();
    if (!nlc() || !anyBound(d)) return false;
    const data = parse(raw);
    const g = data && parseGeometry(data.path);
    return Boolean(g && boundSurface(d, g.id, g.layer) && !exempt(g.id, g.layer));
  }

  /** Shape a run of writes against a reader. The programmer uses this with its own. */
  function shapeCmds(cmds, reader = read) {
    return shapeWrites(cmds, { doc: doc(), read: reader, canvasOf, op: currentOp(), exempt });
  }

  /**
   * The hook's other half: the run, made safe, as frames. A frame left as it
   * was goes out byte for byte; only a changed or added write is re-encoded.
   * The hook only hands over frames `wants` took, so all of them parse — and
   * if one somehow does not, the run goes as it came.
   */
  function shape(raws) {
    const cmds = raws.map(parse);
    if (cmds.some((c) => !c)) return raws;
    const shaped = shapeCmds(cmds);
    const back = new Map(cmds.map((cmd, i) => [cmd, raws[i]]));
    let first = null;
    const out = shaped.map((cmd) => {
      if (parseGeometry(cmd.path)) sent.set(pathKey(cmd.path), { value: cmd.value, at: now() });
      if (cmd.shaped && !first) first = cmd;
      const raw = back.has(cmd) ? back.get(cmd) : JSON.stringify({ channel: 'DEVICE', data: { path: cmd.path, value: cmd.value } });
      if (cmd.shaped) tell(cmd, raw);
      return raw;
    });
    if (first) {
      const g = parseGeometry(first.path);
      const surface = boundSurface(doc(), g.id, g.layer);
      note({ kind: 'kept', id: g.id, layer: g.layer, buffer: g.buffer, surface: surface && surface.name, op: Boolean(currentOp()) });
    }
    return out;
  }

  /**
   * Tell the page a value it did not ask for, once its own optimistic write
   * has landed — and only while the mirror still says the switcher holds it,
   * so a newer value from anywhere is never talked over. A newer rewrite of
   * the same property replaces the pending tells.
   */
  function tell(cmd, raw) {
    if (!tellPage) return;
    const k = pathKey(cmd.path);
    for (const t of telling.get(k) || []) clock.clearTimeout(t);
    telling.set(k, TELL_MS.map((ms) => clock.setTimeout(() => {
      if (store.get(cmd.path) === cmd.value) tellPage(raw);
    }, ms)));
  }

  /* -------------------------------------------------------------- follower */

  function onFrame(frame) {
    if (!frame || !Array.isArray(frame.path)) return;
    const d = nlc();
    if (!d) return;
    const g = parseGeometry(frame.path);
    if (g && frame.dir !== 'out') {
      const k = pathKey(frame.path);
      const hit = sent.get(k);
      if (hit && hit.value === frame.value) sent.delete(k);
    }
    if (frame.dir === 'out' || !anyBound(doc())) return;
    if (g) {
      /* Only a change to preview is the follower's: a change to program says
         nothing about preview, and correcting a preview it merely found
         would be acting on found state. */
      const banks = presetBanks(store, g.id);
      if (boundSurface(doc(), g.id, g.layer) && banks.reported && g.buffer === banks.preview) schedule(g.id, g.layer);
      return;
    }
    /* A take swaps which letter is preview: look again at every bound layer
       on that destination once it lands. */
    for (const id of Object.keys(doc().bindings || {})) {
      if (startsWith(frame.path, d.takeStatus(id, 'transition').slice(0, -1))) {
        for (const { layer } of boundLayers(doc(), id)) schedule(id, layer);
      }
    }
  }

  function schedule(id, layer) {
    const k = `${id}/${layer}`;
    clock.clearTimeout(timers.get(k));
    timers.set(k, clock.setTimeout(() => { timers.delete(k); follow(id, layer); }, FOLLOW_DEBOUNCE_MS));
  }

  /** Look at one bound layer on preview, and bring it in if it is out. */
  function follow(id, layer) {
    const d = nlc();
    const k = `${id}/${layer}`;
    if (!d || !store.ready || letGo.has(k) || exempt(id, layer)) return;
    const banks = presetBanks(store, id);
    if (!banks.reported || !banks.settled) return;
    const base = [...d.bufferPath(id, banks.preview), 'layerList', 'items', String(layer), 'position', 'pp'];
    const st = standing(doc(), (p) => store.get(p), base, id, layer);
    if (!st || st.inside) return;

    const times = (fights.get(k) || []).filter((t) => now() - t < FIGHT_WINDOW_MS);
    if (times.length >= FIGHT_LIMIT) {
      letGo.add(k);
      fights.delete(k);
      note({ kind: 'let-go', id, layer, surface: st.surface.name });
      return;
    }
    times.push(now());
    fights.set(k, times);

    const anchor = st.wire.anchor || 'MIDDLE_CENTER';
    const wire = wireFromRect(constrain(st.rect, st.surface, { canvas: canvasOf(id) }), anchor);
    let n = 0;
    for (const prop of ['sizeH', 'sizeV', 'posH', 'posV']) {
      if (wire[prop] !== st.wire[prop] && send({ path: [...base, prop], value: wire[prop] })) n++;
    }
    if (n) note({ kind: 'pulled', id, layer, buffer: banks.preview, surface: st.surface.name });
  }

  /* ----------------------------------------------------------------- views */

  /**
   * Every bound layer standing outside its surface on program or preview,
   * for the panel and the outlines. Program is reported, never corrected.
   */
  function outside() {
    const d = nlc();
    if (!d || !store.ready) return [];
    const out = [];
    const dc = doc();
    for (const id of Object.keys(dc.bindings || {})) {
      const banks = presetBanks(store, id);
      if (!banks.reported) continue;
      for (const { layer } of boundLayers(dc, id)) {
        for (const [role, letter] of [['PGM', banks.program], ['PRW', banks.preview]]) {
          const base = [...d.bufferPath(id, letter), 'layerList', 'items', layer, 'position', 'pp'];
          const st = standing(dc, (p) => store.get(p), base, id, layer);
          if (st && !st.inside) out.push({ id, layer, role, surface: st.surface });
        }
      }
    }
    return out;
  }

  /** The bindings changed: forgive every layer the follower gave up on. */
  function reset() {
    letGo.clear();
    fights.clear();
  }

  return {
    wants,
    shape,
    shapeCmds,
    setIntent,
    onFrame,
    outside,
    reset,
    canvasOf,
    letGo: () => [...letGo],
    recent: () => recent.slice(),
    /** For tests: run the follower's look now. */
    followNow: follow
  };
}
