/*
 * The programmer: a preset buffer that is not on the device.
 *
 * An operator who wants to try a look has nowhere to build it. Program is on
 * air. Preview is where the next cue is parked, so borrowing it costs the cue
 * and puts the experiment on the PVW monitors. This file is the third place:
 * a buffer that lives in this process, edited with the same panels and the
 * same parameters as a real one, and read by nothing on the switcher.
 *
 * ## Why not buffer C, which really exists
 *
 * A LivePremier screen holds THREE preset buffers — `presetList` carries `A`,
 * `B` and `C`, each a full 129-slot layer tree — and only two of them are
 * program and preview at any moment. C is `presetPrevious`, the step-back
 * buffer. It is tempting, and it is wrong, for two independent reasons
 * measured on a LivePremier Simulator 6.2.73 on 2026-09-22:
 *
 * - **You cannot save a memory from it.** The bank's save and load trees name
 *   only `PROGRAM` and `PREVIEW`:
 *   `presetBank/control/save/screenList/items/S1/presetList/items/` has those
 *   two keys and no others, and an AWJ `get` of the same path spelled with `C`
 *   returns no reply at all — the same answer a deliberately bogus path gives,
 *   while `PROGRAM` and `PREVIEW` answer `false`. So a look built in C could
 *   never become a memory, which is the whole point.
 * - **The device overwrites it.** C is where the outgoing program goes so that
 *   step-back has somewhere to step back to. Every TAKE clobbers it.
 *
 * So the programmer is ours, and `core/preset-file.js` is how what is built
 * here reaches a real memory slot.
 *
 * ## Why this is a small file
 *
 * Two facts about the rest of the app do all the work:
 *
 * 1. **Every panel drives a session through exactly `{store, send}`.** See
 *    `core/session.js`. Nothing reaches past those two.
 * 2. **A layer property is addressed by an opaque buffer key.**
 *    `core/properties.js` hands `bank` straight to `dialect.layerParamPath`,
 *    and `bankLetter()` already passes a literal through untouched — written
 *    for the operator who deliberately edits the buffer that is neither on air
 *    nor cued. It never asked whether the device had heard of that buffer.
 *
 * So a session whose buffer key is `EDIT` and whose store answers `EDIT`
 * itself makes the properties panel, the preview composer and the send-to
 * machinery work against the programmer with no changes to any of them.
 *
 * ## What falls through, and why that matters
 *
 * Only paths inside the programmer's own buffer are answered locally.
 * Everything else — which layers are fitted, canvas sizes, source names and
 * snapshots, the memory bank, which letter is on air — is read from the live
 * mirror. A programmer is therefore never stale about the desk it is
 * programming: stage a layer in the preconfig and it appears here too.
 *
 * ⚠️ **Seeding deep-copies.** A look seeded from a real buffer must not alias
 * the mirror's own objects, or the operator's first edit would write into the
 * device store — the panels would show it as applied, the device would know
 * nothing about it, and the next frame from the switcher would quietly undo
 * it. `structuredClone` on the way in, every time.
 */

import { ROOT } from './paths.js';
import { dialectFor } from './dialect.js';
import { listDestinations, presetBanks } from './screens.js';

/** The buffer key the programmer answers to. Not a letter the device has. */
export const EDIT = 'EDIT';

/**
 * Is this store path inside the programmer's buffer?
 *
 * The test is the `presetList/items/<buffer>` triple rather than a full path
 * match, because the two platforms spell everything around it differently —
 * `layerList` on LivePremier, `liveLayerList` on Midra, and a different
 * collection above — and the one thing they agree on is that the buffer is
 * named by the item key of a `presetList`. See `core/dialect.js`.
 */
function ownsPath(path, buffer) {
  if (!Array.isArray(path)) return false;
  for (let i = 0; i + 2 < path.length; i++) {
    if (path[i] === 'presetList' && path[i + 1] === 'items' && path[i + 2] === buffer) return true;
  }
  return false;
}

/** Read a value out of a plain nested object by store path. */
function getIn(root, path) {
  let node = root;
  for (const seg of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[seg];
  }
  return node;
}

/** Write a value into a plain nested object, making the way as it goes. */
function setIn(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[path[path.length - 1]] = value;
}

/**
 * A store that answers for one buffer and delegates everything else.
 *
 * Deliberately not a `DeviceStore` subclass: a DeviceStore owns a whole tree
 * and is hydrated from a snapshot, and this owns a sliver of one and is never
 * hydrated at all. It satisfies the same three members every panel uses —
 * `ready`, `get`, `subscribe` — and says so here rather than inheriting an
 * `hydrate` that would be a lie.
 */
class ProgrammerStore {
  constructor(base, buffer) {
    this.base = base;
    this.buffer = buffer;
    /* The programmer's own tree, in store shape so `getIn` and the device's
       own paths agree without translation. */
    this.own = {};
    this._subs = [];
  }

  /** The programmer is only as ready as the device it is drawn against. */
  get ready() {
    return this.base.ready;
  }

  get(path) {
    return ownsPath(path, this.buffer) ? getIn(this.own, path) : this.base.get(path);
  }

  set(path, value) {
    /* A write aimed anywhere but the programmer's buffer is a caller mistake,
       and swallowing it silently would make an edit that went nowhere look
       like an edit that worked. */
    if (!ownsPath(path, this.buffer)) return false;
    setIn(this.own, path, value);
    for (const { prefix, fn } of this._subs) {
      if (prefix.length <= path.length && prefix.every((seg, i) => seg === path[i])) {
        try { fn({ path, value }); } catch (err) { console.error('[lpp] programmer subscriber threw', err); }
      }
    }
    return true;
  }

  /**
   * Watch a sub-tree, of this buffer or of the device.
   *
   * Both, because a caller watching `[]` means "anything that could change
   * what I am drawing", and half of what the programmer draws — fitted
   * layers, canvas size, source names — is the device's.
   */
  subscribe(prefix, fn, opts) {
    const entry = { prefix, fn };
    this._subs.push(entry);
    const off = this.base.subscribe ? this.base.subscribe(prefix, fn, opts) : null;
    return () => {
      const at = this._subs.indexOf(entry);
      if (at >= 0) this._subs.splice(at, 1);
      if (typeof off === 'function') off();
    };
  }
}

/**
 * A session-shaped programmer over a live one.
 *
 * @param {{session: {store: object, send: Function}, buffer?: string}} opts
 */
export function createProgrammer({ session, buffer = EDIT } = {}) {
  const store = new ProgrammerStore(session.store, buffer);
  const events = new EventTarget();

  /** Where one destination's programmer buffer lives. */
  function bufferPath(id) {
    const dialect = dialectFor(session.store);
    if (!dialect) return null;
    const dest = destination(id);
    if (!dest) return null;
    return [ROOT, dest.listName, 'items', dest.id, 'presetList', 'items', buffer];
  }

  function destination(id) {
    return listDestinations(session.store, { includeUnused: true }).find((d) => d.id === id) || null;
  }

  /**
   * Write one property.
   *
   * Same signature and same return as `Session.send`, so a panel cannot tell
   * which it is holding — but the write stops here. Nothing in this file has
   * a transport to reach.
   */
  function send(cmd) {
    if (!cmd || !Array.isArray(cmd.path)) return false;
    const ok = store.set(cmd.path, cmd.value);
    events.dispatchEvent(new CustomEvent('sent', { detail: { cmd, ok } }));
    if (ok) events.dispatchEvent(new CustomEvent('frame', { detail: { path: cmd.path, value: cmd.value } }));
    return ok;
  }

  /**
   * Fill a destination's programmer buffer from one of its real ones.
   *
   * `from` is PROGRAM, PREVIEW or a literal letter. Deep-copied — see the
   * warning in the file header.
   *
   * Returns false when the device has not yet said which letter is which,
   * rather than copying from a guess: seeding from the wrong buffer would
   * silently start the operator off from what is on air.
   */
  function seed(id, from = 'PREVIEW') {
    const dest = destination(id);
    const target = bufferPath(id);
    if (!dest || !target) return false;

    const banks = presetBanks(session.store, id);
    const letter = from === 'PROGRAM' ? banks.program : from === 'PREVIEW' ? banks.preview : from;
    if (!letter) return false;
    if ((from === 'PROGRAM' || from === 'PREVIEW') && !banks.reported) return false;

    const source = session.store.get([ROOT, dest.listName, 'items', dest.id, 'presetList', 'items', letter]);
    if (!source || typeof source !== 'object') return false;

    setIn(store.own, target, dropReported(structuredClone(source)));
    changed(id);
    return true;
  }

  /**
   * Take the device's own echoes back out of a seeded buffer.
   *
   * A layer carries a couple of read-only properties the device writes to say
   * what it is *actually* doing — `source/status/pp/inputNum` above all, which
   * the Layer panel shows as "(showing IN5)" when it disagrees with what was
   * asked for. In a real buffer that is useful: during a load the two differ
   * for a moment. In the programmer it is a claim about a device that has
   * never heard of this buffer, frozen at whatever it said when the seed was
   * taken — so the panel would report a look as "showing" a source that is
   * nowhere near it. Absent is the honest value, and the panel already draws
   * nothing for it.
   */
  function dropReported(node) {
    const dialect = dialectFor(session.store);
    const listName = layerListName();
    const items = (node[listName] && node[listName].items) || {};
    const readOnly = (dialect ? dialect.catalogue.layer : []).filter((spec) => spec.readOnly);

    for (const layer of Object.values(items)) {
      for (const spec of readOnly) {
        const parent = spec.path.slice(0, -1).reduce((n, seg) => (n == null ? undefined : n[seg]), layer);
        if (parent && typeof parent === 'object') delete parent[spec.path[spec.path.length - 1]];
      }
    }
    return node;
  }

  /**
   * Empty a destination's programmer buffer.
   *
   * "Empty" is the device's own idea of it: every layer full-canvas, centred,
   * opaque and showing nothing, which is exactly what an untouched preset
   * reads as on a live box.
   *
   * It starts from a copy of a real buffer on purpose. The alternative is a
   * table of defaults for all sixty-six layer properties, invented here and
   * left to drift out of step with the next firmware. Everything this does not
   * name keeps the device's own value, and the three it does name are the ones
   * that mean "nothing on this screen".
   */
  function clear(id, { from = 'PREVIEW' } = {}) {
    if (!seed(id, from)) return false;
    const base = bufferPath(id);
    const canvas = (destination(id) || {}).canvas || { width: 1920, height: 1080 };
    const layers = layerKeys(id);
    const listName = layerListName();

    for (const key of layers) {
      const layer = [...base, listName, 'items', String(key)];
      store.set([...layer, 'source', 'pp', 'inputNum'], 'NONE');
      store.set([...layer, 'opacity', 'pp', 'opacity'], 256);
      store.set([...layer, 'position', 'pp', 'anchor'], 'MIDDLE_CENTER');
      store.set([...layer, 'position', 'pp', 'posH'], Math.round(canvas.width / 2));
      store.set([...layer, 'position', 'pp', 'posV'], Math.round(canvas.height / 2));
      store.set([...layer, 'position', 'pp', 'sizeH'], canvas.width);
      store.set([...layer, 'position', 'pp', 'sizeV'], canvas.height);
    }
    changed(id);
    return true;
  }

  /** `layerList` on LivePremier, `liveLayerList` on Midra. */
  function layerListName() {
    const dialect = dialectFor(session.store);
    return dialect && dialect.id === 'mng' ? 'liveLayerList' : 'layerList';
  }

  /** The layer slots this destination really has, the programmer included. */
  function layerKeys(id) {
    const dialect = dialectFor(session.store);
    if (!dialect) return [];
    return dialect.fittedLayers(session.store, id).map((l) => l.key);
  }

  /** Is there anything programmed for this destination? */
  function has(id) {
    const path = bufferPath(id);
    return !!(path && getIn(store.own, path));
  }

  /** Every destination with something programmed. */
  function programmed() {
    return listDestinations(session.store, { includeUnused: true })
      .map((d) => d.id)
      .filter((id) => has(id));
  }

  /** A detached copy of one destination's buffer, for saving or sending. */
  function look(id) {
    const path = bufferPath(id);
    const node = path && getIn(store.own, path);
    return node ? structuredClone(node) : null;
  }

  /** Install one, from the look library or from a memory read off the device. */
  function setLook(id, node) {
    const path = bufferPath(id);
    if (!path || !node || typeof node !== 'object') return false;
    setIn(store.own, path, structuredClone(node));
    changed(id);
    return true;
  }

  /** Forget one destination's buffer entirely — not the same as emptying it. */
  function discard(id) {
    const path = bufferPath(id);
    if (!path) return false;
    const parent = getIn(store.own, path.slice(0, -1));
    if (!parent) return false;
    delete parent[path[path.length - 1]];
    changed(id);
    return true;
  }

  function changed(id) {
    events.dispatchEvent(new CustomEvent('changed', { detail: { id } }));
    events.dispatchEvent(new CustomEvent('frame', { detail: { path: bufferPath(id) || [], value: null } }));
  }

  return {
    store,
    send,
    buffer,
    /* The live session underneath, for the few callers that must reach the
       real device on purpose — saving a memory, above all. Named rather than
       reached for through `store.base`, so those callers are greppable. */
    device: session,
    seed,
    clear,
    has,
    programmed,
    look,
    setLook,
    discard,
    layerKeys,
    bufferPath,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events)
  };
}
