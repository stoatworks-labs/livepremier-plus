/*
 * Thumbnail relay — which sources this page is editing, and keeping those
 * pictures quick.  Page side; no Node in here.
 *
 * ## What counts as hot
 *
 * A thumbnail **drawn in a destination's canvas and on screen**:
 *
 *   - the vendor's screen and aux cards on Screens / Aux. — `.aw-preset-view`,
 *     both buffers (see `src/ui/preset-lock.js` for that card's anatomy);
 *   - this app's own canvases — the Edit page, the stage, the Console's
 *     preview wall — every `<img>` of which carries `data-lpp-snapshot`.
 *
 * Not the Sources panel's cards, and not a card scrolled out of view. That is
 * the whole of the filter: what somebody is composing gets refreshed quickly;
 * a source waiting in the list gets the vendor's pace or slower. It reads the
 * page, not the store, so it follows whichever screens the operator has open
 * in Edit View without knowing how that choice is kept — React state, like
 * the PGM/PRW padlock, and in no store this app can read.
 *
 * ## Refreshing them
 *
 * The vendor's `<img>` gets its URL from a React hook that the vendor's own
 * clock updates. Setting `src` here, with a newer cache-buster, fetches the
 * newer frame at once; the next time the vendor's clock comes round it sets
 * its own URL, which is simply one more refresh. The two never fight, because
 * neither holds state the other can break — an `<img>` shows whatever it was
 * last pointed at.
 *
 * Every image of one source is pointed at one URL per tick, so a source shown
 * on two screens and in PGM and PRW costs one request, not four.
 */

import { SNAPSHOT_PATH } from './core.js';

/** Where a thumbnail is being composed rather than listed. */
const CANVAS_SEL = '.aw-preset-view';
const OWN_ATTR = 'data-lpp-snapshot';
const SNAP_IMG = 'img[src*="/api/device/snapshots/"]';

/* How often the page is looked at for what is hot. Cheap: one selector. */
const SCAN_MS = 500;
/* How often a page repeats its list when nothing changed — well inside the
   server's five-second lease. */
const RENEW_MS = 2000;

/** The vendor path in an `<img src>`, or null for anything else. */
export function snapshotPath(src) {
  if (!src) return null;
  let path;
  try { path = new URL(src, 'http://page.invalid').pathname; } catch { return null; }
  return SNAPSHOT_PATH.test(path) ? path : null;
}

/** `src` pointed at a newer frame of the same picture. */
export function bump(src, tick) {
  return `${String(src).split('?')[0]}?${tick}`;
}

/** Whether an element has a box that overlaps the window. */
function onScreen(el, win) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
}

/**
 * The hot thumbnails on a page: path → the `<img>`s drawing it.
 *
 * @param {Document} doc
 * @param {Window} win
 * @returns {Map<string, HTMLImageElement[]>}
 */
export function findHot(doc, win) {
  const out = new Map();
  for (const img of doc.querySelectorAll(SNAP_IMG)) {
    const canvas = img.hasAttribute(OWN_ATTR) || img.closest(CANVAS_SEL);
    if (!canvas || !onScreen(img, win)) continue;
    const path = snapshotPath(img.getAttribute('src'));
    if (!path) continue;
    if (!out.has(path)) out.set(path, []);
    out.get(path).push(img);
  }
  return out;
}

/**
 * Follow the page: report what is hot to the relay, and refresh it at
 * `hotHz` while the page is visible.
 *
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {Window} opts.win
 * @param {(paths: string[]) => Promise<unknown>} opts.post   tells the relay
 * @param {() => {hotHz: number}} opts.settings
 * @param {() => number} [opts.now]
 * @param {{setInterval: Function, clearInterval: Function}} [opts.timers]
 *        the page's own, which is what a test replaces
 */
export function createHotTracker({
  doc, win, post, settings, now = Date.now,
  timers = { setInterval: (...a) => setInterval(...a), clearInterval: (id) => clearInterval(id) }
}) {
  let hot = new Map();
  let sentKey = null;
  let sentAt = 0;
  let scanTimer = null;
  let refreshTimer = null;
  let hz = null;

  function scan() {
    hot = findHot(doc, win);
    const paths = [...hot.keys()].sort();
    const key = paths.join('\n');
    const t = now();
    /* Changed, or due to renew. An empty list is sent once — it is what lets
       the other sources stop being idle the moment editing stops — and then
       not repeated: the lease runs out on its own. */
    if (key !== sentKey || (paths.length && t - sentAt >= RENEW_MS)) {
      sentKey = key;
      sentAt = t;
      /* A failed report is tried again on the next scan. */
      try { Promise.resolve(post(paths)).catch(() => { sentKey = null; }); }
      catch { sentKey = null; }
    }
    arm();
  }

  function refresh() {
    if (doc.hidden || !hot.size) return;
    const tick = now();
    for (const imgs of hot.values()) {
      for (const img of imgs) {
        if (img.isConnected) img.setAttribute('src', bump(img.getAttribute('src'), tick));
      }
    }
  }

  /** (Re)start the refresh clock when the rate changed. */
  function arm() {
    const want = settings().hotHz || 0;
    if (want === hz) return;
    hz = want;
    if (refreshTimer) { timers.clearInterval(refreshTimer); refreshTimer = null; }
    if (hz > 0) refreshTimer = timers.setInterval(refresh, Math.round(1000 / hz));
  }

  return {
    start() {
      if (scanTimer) return;
      scanTimer = timers.setInterval(scan, SCAN_MS);
      scan();
    },
    stop() {
      if (scanTimer) timers.clearInterval(scanTimer);
      if (refreshTimer) timers.clearInterval(refreshTimer);
      scanTimer = refreshTimer = null;
      hz = null;
    },
    /** What this page thinks is hot, for the card. */
    hot: () => [...hot.keys()].sort(),
    /* For tests. */
    scan,
    refresh
  };
}
