/*
 * Slow-link thumbnails — a source thumbnail keeps its picture until the next
 * one has arrived. Page side; no Node in here.
 *
 * ## The cliff, at the browser's end
 *
 * The Web RCS's `SnapshotManager` (6.2.73) moves every source on to a new URL
 * about once a second (`/api/device/snapshots/inputs/3?<epoch-ms>`), and
 * React writes it into the card's `<img>` with `setAttribute('src', …)`. A
 * browser handed a new `src` drops the load still on its way. So when the
 * page is a thin link away from this app — a tablet over Remote access — a
 * picture that takes more than a second to cross is never drawn, and once a
 * page's thumbnails together need more than the link carries, none is.
 * `server/snapshot-keeper.js` fixes the app→switcher leg; this is the
 * browser→app one.
 *
 * ## What this does about it
 *
 * A new URL for a picture whose last URL is still loading is not handed to
 * the browser. It is kept on the side, the last drawn picture stays, and when
 * the load in flight ends (`load` or `error`) the newest URL kept goes in. So
 * every image has at most one load on its way, each one lands, and a slow
 * link shows each source as often as it can carry instead of never.
 *
 * On a LAN a load ends in a round trip, long before the vendor's next URL,
 * so nothing is ever kept and every URL goes in the moment it is set.
 *
 * Only a newer frame of the **same** picture waits: inputs, outputs,
 * multiviewers and timers (the keeper's `KEPT_SNAPSHOT`), with the same path
 * as the URL loading. A card pointed at another source, a still or a library
 * image (`images`, `images_library`, drawn once per version), a `blob:` from
 * Multiviewer thumbnails, anything else: straight through, and a URL kept
 * for that image is dropped, so it can never land on top of what replaced it.
 *
 * ## Why the setter, not a MutationObserver
 *
 * An observer sees the attribute after the browser does: Chrome has queued
 * the new load, WebKit (an iPad) asks for it as the attribute changes.
 * Putting the old URL back then leans on how each engine's image cache treats
 * a picture served `max-age=0`. Holding the write back before it reaches the
 * element leaves the browser nothing to undo. React 17 sets `src` with `setAttribute` and keeps no reading of the
 * DOM, so a write held back is invisible to it; `img.src = …` is held the
 * same way for anyone who uses the property.
 *
 * ## What it will not do
 *
 * Keep a picture behind a load that has stopped. A load older than
 * `giveUpMs` is given up on at the next URL, which goes in as the vendor
 * meant: one connection that never answers must not freeze a card for good.
 * A failed load ends the wait like a finished one, and the next URL is asked
 * for, so a dead link breaks the image as it always did.
 */

/** The snapshots the vendor's poller refreshes — the keeper's `KEPT_SNAPSHOT`, which a test holds this to. */
export const HELD_SNAPSHOT = /^\/api\/device\/snapshots\/(?:inputs|outputs|multiviewers|timers)\/\d{1,4}$/;

/* As long as the keeper offers a kept frame: past this nothing about the load
   in flight is worth waiting for. Thirty sources at 148 KB over 400 KB/s come
   round every eleven seconds. */
export const GIVE_UP_MS = 30_000;

/** The path of a polled thumbnail URL, or null for anything else. */
export function heldPath(src) {
  if (!src) return null;
  let path;
  try { path = new URL(String(src), 'http://page.invalid').pathname; } catch { return null; }
  return HELD_SNAPSHOT.test(path) ? path : null;
}

/** The nearest `src` accessor on a prototype chain. */
function srcAccessor(proto) {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, 'src');
    if (d && d.set) return d;
  }
  return null;
}

/**
 * Hold back every `<img>`'s new thumbnail URL while its last one is loading.
 *
 * @param {object} opts
 * @param {object} opts.proto   `HTMLImageElement.prototype` — what a test replaces
 * @param {Document} opts.doc   where `load` and `error` are heard, at capture
 * @param {() => number} [opts.now]
 * @param {number} [opts.giveUpMs]
 * @returns {{stop(): void, stats(): object, pending(img: object): string|null}}
 */
export function installThumbnailHold({ proto, doc, now = Date.now, giveUpMs = GIVE_UP_MS }) {
  /* Whatever `proto` holds of its own is put back by `stop()`; what it
     inherits is what the wrappers call. */
  const ownSet = Object.getOwnPropertyDescriptor(proto, 'setAttribute');
  const ownSrc = Object.getOwnPropertyDescriptor(proto, 'src');
  const nativeSet = proto.setAttribute;
  const nativeGet = proto.getAttribute;
  const src = srcAccessor(proto);

  /** img → { next: the newest URL held back, since: when the load in flight began } */
  const state = new WeakMap();
  const stats = { held: 0, superseded: 0, released: 0, gaveUp: 0 };

  function stateOf(img) {
    let st = state.get(img);
    if (!st) {
      st = { next: null, since: now() };
      state.set(img, st);
    }
    return st;
  }

  /** Whether this write waits; if it does, it is kept as the newest. */
  function holds(img, value) {
    const url = String(value);
    const path = heldPath(url);
    if (!path || heldPath(nativeGet.call(img, 'src')) !== path || img.complete) return false;
    const st = stateOf(img);
    if (now() - st.since >= giveUpMs) {
      stats.gaveUp += 1;
      return false;
    }
    if (st.next) stats.superseded += 1;
    else stats.held += 1;
    st.next = url;
    return true;
  }

  /** A write that went to the element: a new load began, and nothing kept outranks it. */
  function wrote(img, value) {
    const st = state.get(img);
    if (st) {
      st.next = null;
      st.since = now();
    } else if (heldPath(value)) {
      state.set(img, { next: null, since: now() });
    }
  }

  function setAttribute(name, value) {
    if (typeof name === 'string' && name.toLowerCase() === 'src') {
      if (holds(this, value)) return;
      nativeSet.call(this, name, value);
      wrote(this, value);
      return;
    }
    return nativeSet.call(this, name, value);
  }

  function onDone(ev) {
    const img = ev.target;
    const st = img && state.get(img);
    if (!st || !st.next) return;
    const url = st.next;
    nativeSet.call(img, 'src', url);
    wrote(img, url);
    stats.released += 1;
  }

  Object.defineProperty(proto, 'setAttribute', { value: setAttribute, writable: true, configurable: true, enumerable: ownSet ? ownSet.enumerable : true });
  if (src) {
    Object.defineProperty(proto, 'src', {
      configurable: true,
      enumerable: src.enumerable,
      get: src.get,
      set(value) {
        if (holds(this, value)) return;
        src.set.call(this, value);
        wrote(this, value);
      }
    });
  }
  doc.addEventListener('load', onDone, true);
  doc.addEventListener('error', onDone, true);

  return {
    /** Put the browser's own setters back. Anything still held is forgotten; the vendor's next URL goes in. */
    stop() {
      doc.removeEventListener('load', onDone, true);
      doc.removeEventListener('error', onDone, true);
      if (ownSet) Object.defineProperty(proto, 'setAttribute', ownSet);
      else delete proto.setAttribute;
      if (src) {
        if (ownSrc) Object.defineProperty(proto, 'src', ownSrc);
        else delete proto.src;
      }
    },
    /** What it has done, for `window.__WRU.shared('thumbnail-hold')` on a day with a slow link. */
    stats: () => ({ ...stats }),
    /** The URL an image is waiting to be given, or null. */
    pending: (img) => (state.get(img) || {}).next || null
  };
}
