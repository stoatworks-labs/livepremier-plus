/*
 * Multiviewer slicer — putting the crops into the page's thumbnails. Page side.
 *
 * ## How a thumbnail is replaced
 *
 * Every source thumbnail on the page is an `<img>` pointed at
 * `/api/device/snapshots/inputs/<n>?<cache-buster>` — the vendor's cards,
 * the screen and aux canvases, this app's own. That address is the only
 * thing that says which source a card is (see `web-rcs-ui-facts`), so it is
 * what this reads.
 *
 * On each tick, for every source that has a crop and at least one image on
 * screen, the crop is drawn from the capture into a canvas, encoded as a
 * JPEG, and every image of that source is pointed at the one blob URL. The
 * source's address is kept on the image as `data-lpp-mv-path`.
 *
 * The vendor's clock goes on setting its own URL about once a second. A
 * mutation observer sees that and points the image back at the newest crop
 * before the browser paints. So the vendor's image stays in the vendor's
 * DOM, in its place, with its clipping and z-order — nothing is laid over the
 * page.
 *
 * ## Handing back
 *
 * `setLive(false)` — the capture stalled, the plugin stopped, the layout lost
 * the source — points every image back at its switcher address, and from then
 * on the vendor's own clock is in charge again. A dead capture must never
 * leave frozen pictures that look live.
 */

import { pathOfSrc } from './core.js';

export const PATH_ATTR = 'data-lpp-mv-path';
/* How long a superseded frame's URL is kept. Every image of a source moves
   to the new URL in the same tick, so this only covers a decode in flight. */
const REVOKE_MS = 2000;

/** Whether an element has a box that overlaps the window. */
function onScreen(el, win) {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  return r.bottom > 0 && r.right > 0 && r.top < win.innerHeight && r.left < win.innerWidth;
}

/**
 * The source an image is showing. A switcher address in `src` is the truth —
 * the vendor may have re-pointed a card at another input since we last
 * touched it — and our note only speaks for an image showing one of our crops.
 */
export function sourcePathOf(img) {
  return pathOfSrc(img.getAttribute('src')) || img.getAttribute(PATH_ATTR);
}

/**
 * The on-screen images of each source that has a crop: path → images.
 *
 * @param {Document} doc
 * @param {Window} win
 * @param {Map<string, unknown>} crops
 */
export function findTargets(doc, win, crops) {
  const out = new Map();
  if (!crops.size) return out;
  for (const img of doc.querySelectorAll('img')) {
    const path = sourcePathOf(img);
    if (!path || !crops.has(path) || !onScreen(img, win)) continue;
    if (!out.has(path)) out.set(path, []);
    out.get(path).push(img);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {Document} opts.doc
 * @param {Window} opts.win
 * @param {() => {video: HTMLVideoElement|null, crops: Map<string, {crop:{x:number,y:number,w:number,h:number}, width:number, height:number}>}} opts.frame
 * @param {() => {fps: number, quality: number}} opts.settings
 */
export function createSwapper({ doc, win, frame, settings }) {
  let live = false;
  let timer = null;
  let busy = false;
  let observer = null;
  /** path → the newest blob URL of that source's crop. */
  const urls = new Map();
  const stats = { frames: 0, encodeMs: 0, sources: 0, images: 0 };

  function point(img, path, url) {
    if (img.getAttribute(PATH_ATTR) !== path) img.setAttribute(PATH_ATTR, path);
    if (img.getAttribute('src') !== url) img.setAttribute('src', url);
  }

  function release() {
    const tick = Date.now();
    for (const img of doc.querySelectorAll(`img[${PATH_ATTR}]`)) {
      const path = img.getAttribute(PATH_ATTR);
      img.removeAttribute(PATH_ATTR);
      img.setAttribute('src', `${path}?${tick}`);
    }
    for (const url of urls.values()) setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
    urls.clear();
  }

  /* One canvas, reused: the encodes are done one after another. Made on the
     first tick, not here — a page that never goes live never needs one. */
  let canvas = null;
  let g = null;
  const encode = () => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', settings().quality));

  async function tick() {
    if (!live || busy || doc.hidden) return;
    const { video, crops } = frame();
    if (!video || !video.videoWidth) return;
    /* A source the layout no longer carries goes back to its switcher picture
       rather than stopping on its last crop. Its URL goes first: while one is
       kept, the observer would take the image straight back. */
    for (const [path, url] of urls) {
      if (crops.has(path)) continue;
      urls.delete(path);
      setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
    }
    for (const img of doc.querySelectorAll(`img[${PATH_ATTR}]`)) {
      const path = img.getAttribute(PATH_ATTR);
      if (crops.has(path)) continue;
      img.removeAttribute(PATH_ATTR);
      img.setAttribute('src', `${path}?${Date.now()}`);
    }
    const targets = findTargets(doc, win, crops);
    stats.sources = targets.size;
    stats.images = [...targets.values()].reduce((n, l) => n + l.length, 0);
    if (!targets.size) return;
    if (!canvas) {
      canvas = doc.createElement('canvas');
      g = canvas.getContext('2d');
    }
    busy = true;
    const t0 = performance.now();
    try {
      for (const [path, imgs] of targets) {
        const c = crops.get(path);
        if (canvas.width !== c.width) canvas.width = c.width;
        if (canvas.height !== c.height) canvas.height = c.height;
        g.drawImage(video, c.crop.x, c.crop.y, c.crop.w, c.crop.h, 0, 0, c.width, c.height);
        const blob = await encode();
        if (!live) return;
        if (!blob) continue;
        const url = URL.createObjectURL(blob);
        const old = urls.get(path);
        urls.set(path, url);
        for (const img of imgs) if (img.isConnected) point(img, path, url);
        if (old) setTimeout(() => URL.revokeObjectURL(old), REVOKE_MS);
      }
      stats.frames += 1;
      stats.encodeMs += performance.now() - t0;
    } finally {
      busy = false;
    }
  }

  /** The vendor re-pointed an image, or drew a new one: take it back. */
  function onMutations(records) {
    if (!live) return;
    for (const r of records) {
      if (r.type === 'attributes') claim(r.target);
      else for (const n of r.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') claim(n);
        else for (const img of n.querySelectorAll('img')) claim(img);
      }
    }
  }

  function claim(img) {
    if (!img || img.tagName !== 'IMG') return;
    const src = img.getAttribute('src');
    if (src && src.startsWith('blob:')) return;
    const path = pathOfSrc(src);
    if (!path) {
      /* Pointed somewhere that is not a thumbnail at all — a card reused for
         something else. It is not ours any more. */
      if (img.hasAttribute(PATH_ATTR)) img.removeAttribute(PATH_ATTR);
      return;
    }
    const url = urls.get(path);
    if (url) point(img, path, url);
    else if (img.getAttribute(PATH_ATTR) !== path) img.removeAttribute(PATH_ATTR);
  }

  function arm() {
    if (timer) clearInterval(timer);
    timer = setInterval(tick, Math.round(1000 / Math.max(1, settings().fps)));
  }

  return {
    /** Start or stop replacing. Stopping hands every image back. */
    setLive(on) {
      if (on === live) return;
      live = on;
      if (on) {
        observer = new MutationObserver(onMutations);
        observer.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
        arm();
      } else {
        if (observer) observer.disconnect();
        observer = null;
        if (timer) clearInterval(timer);
        timer = null;
        release();
      }
    },
    /** The rate changed. */
    retime() { if (live) arm(); },
    get live() { return live; },
    stats: () => ({ ...stats }),
    stop() { this.setLive(false); }
  };
}
