/*
 * Our own drawings inside the vendor's screen cards: where they go.
 *
 * Pixel Map lays a picture over a screen's canvas, and Surfaces lays the LED
 * elements' outlines there. Both have to find the same raster in the same
 * card and sit at the same depth in its stack, and two copies of those rules
 * is how the two come to disagree — so the finding and the seating live
 * here, and each plugin keeps only what it draws.
 *
 * ## What is matched
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-10-16):
 *
 *   .aw-preset-view > h2 "S1"                           one screen card
 *     [class*="screen-overview-container__c__preset___"] one buffer, labelled PGM / PRW
 *       [class*="preset-overview-container__c__canvas___"]  the canvas box
 *         .react-transform-component                    the card's pan and zoom
 *           … .aw-absolute.aw-background-black          the raster, sized in px
 *               > .aw-relative > .aw-absolute           the stack:
 *                   div                                   the layers
 *                   div                                   the selected layer's handles
 *
 * The card and buffer come from `ui/preset-lock.js`. The raster is found by
 * its utility classes inside the pan-zoom component; the only hashed name
 * used is matched on its stable middle, as everywhere else here.
 *
 * ## Between the layers and the handles
 *
 * Over the layers, because a drawing about them is no use under them; under
 * the handles, because the operator still has to see where to grab a layer.
 * The handles group is only mounted while a layer is selected, and React
 * appends it, so it lands after our drawings on its own.
 *
 * ⚠️ **Two overlays must agree on their order, or they move each other for
 * ever.** Each sweep puts its node "straight after X"; if both said straight
 * after the layers, every sweep would move one, the move would wake the other
 * plugin's observer, and that would move it back. So an overlay names the
 * overlays it sits *above* (`below`), and is seated after the last of those
 * that is already in place. Pixel Map names none and Surfaces names Pixel
 * Map: outlines over the mask, both under the handles.
 *
 * Every node of ours carries `OVERLAY`, so neither plugin mistakes the
 * other's for a piece of the vendor's stack.
 */

/** On every overlay node of ours, whichever plugin drew it. */
export const OVERLAY = 'data-lpp-overlay';

/** Each plugin's own mark, kept here so one can name another's without importing its folder. */
export const MARKS = Object.freeze({ pixelMap: 'data-lpp-pixel-map', surfaces: 'data-lpp-surfaces' });

const CANVAS_BOX = '[class*="preset-overview-container__c__canvas___"]';
const ZOOM = '.react-transform-component';
const RASTER = '.aw-background-black';
/* A build that paints the raster another colour still positions it in px. */
const RASTER_FALLBACK = '.aw-absolute[style*="height"]';

/** The raster `<div>` inside one buffer block, or null. */
export function rasterOf(block) {
  const box = block.querySelector(CANVAS_BOX);
  const zoom = box && box.querySelector(ZOOM);
  if (!zoom) return null;
  return zoom.querySelector(RASTER) || zoom.querySelector(RASTER_FALLBACK);
}

export const vendorChildren = (el) => [...el.children].filter((c) => !c.hasAttribute(OVERLAY));

/**
 * Where an overlay goes in one raster: `{parent, after, where}`.
 *
 * `between` puts it after the layers group — and after any overlay named in
 * `below` that is already there — so handles mounted later are drawn over
 * it; `top` appends it to the raster, over everything.
 *
 * @param {Element} raster
 * @param {{below?: string[]}} [opts]  attributes of the overlays this one sits above
 */
export function slotIn(raster, { below = [] } = {}) {
  const inner = vendorChildren(raster)[0];
  const stack = inner && vendorChildren(inner)[0];
  if (stack && stack.classList.contains('aw-absolute')) {
    const layers = vendorChildren(stack)[0] || null;
    if (layers) return { parent: stack, after: lastBelow(layers, below), where: 'between' };
  }
  const kids = vendorChildren(raster);
  const last = kids[kids.length - 1] || null;
  return { parent: raster, after: last ? lastBelow(last, below) : null, where: 'top' };
}

/** `from`, or the last of the run of overlays named in `below` straight after it. */
function lastBelow(from, below) {
  const kids = [...from.parentNode.children];
  let after = from;
  for (let i = kids.indexOf(from) + 1; i < kids.length && kids[i].hasAttribute(OVERLAY); i++) {
    if (below.some((attr) => kids[i].hasAttribute(attr))) after = kids[i];
  }
  return after;
}

/** Put `node` straight after `after` in `parent`, unless it is there already. */
export function seat(node, { parent, after }) {
  if (after) {
    if (node.parentNode === parent && after.nextSibling === node) return false;
    parent.insertBefore(node, after.nextSibling);
    return true;
  }
  if (node.parentNode === parent && parent.firstChild === node) return false;
  parent.insertBefore(node, parent.firstChild);
  return true;
}

/** Set a style property only when it differs, so a sweep that changes nothing writes nothing. */
export function style(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}

/**
 * Coalesce sweeps to one per animation frame, and wake on the vendor's own
 * mutations. Our insertions cause one more sweep, which finds everything in
 * place and changes nothing — so it settles.
 *
 * @param {() => void} sweep
 * @param {Document} doc
 */
export function sweeper(sweep, doc) {
  let scheduled = false;
  let observer = null;
  const run = () => { scheduled = false; sweep(); };
  function refresh() {
    if (scheduled) return;
    scheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (fn) => setTimeout(fn, 16);
    raf(run);
  }
  if (typeof MutationObserver === 'function' && doc.body) {
    observer = new MutationObserver(refresh);
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  return {
    refresh,
    stop() { if (observer) { observer.disconnect(); observer = null; } }
  };
}
