/*
 * Pixel Map — the picture, laid into the vendor's own screen cards.
 *
 * ## ⚠️ This writes into the middle of Web RCS's markup
 *
 * Like the layer names (`plugins/layer-names/labels.js`), and for the same
 * reason: the only place the map is any use is where the operator is already
 * looking, which is the vendor's canvas. A firmware that restructures the
 * card makes the map not appear, quietly — so `describe()` counts what was
 * found and what was drawn, and the panel prints it.
 *
 * ## Where, and what is matched
 *
 * `src/ui/canvas-overlay.js` finds the raster in each card and seats the map
 * between the layers and the handles: over the layers, because a mask is no
 * use under what it masks; under the handles, because the operator still has
 * to see where to grab a layer that the map has just blacked out. A stack
 * that is not shaped like that gets the map on top of everything instead,
 * and `describe()` says so. Surfaces' outlines sit over the map.
 *
 * ## Never in the way
 *
 * `pointer-events: none` on the map and its picture, so every press, drag,
 * drop and wheel lands on whatever is under it, exactly as if it were not
 * there. Nothing in it takes focus, it is `aria-hidden`, and the picture
 * cannot be dragged out. The map is drawn in percentages of the raster, so
 * the card's own zoom, pan and resizing carry it with no measuring.
 */

import { presetBlocks } from '../../src/ui/preset-lock.js';
import { OVERLAY, MARKS, rasterOf, slotIn, seat, style, sweeper } from '../../src/ui/canvas-overlay.js';

/** Ours, so a re-render cannot end up with two and so `stop()` can find them. */
export const MARK = MARKS.pixelMap;

/** Build one overlay: a clipping box and the picture in it. */
function build(doc, key) {
  const box = doc.createElement('div');
  box.setAttribute(MARK, key);
  box.setAttribute(OVERLAY, 'pixel-map');
  box.setAttribute('aria-hidden', 'true');
  box.className = 'wru-pixel-map';
  const img = doc.createElement('img');
  img.setAttribute('alt', '');
  img.setAttribute('draggable', 'false');
  img.setAttribute('decoding', 'async');
  /* The original file failed to draw — a TIFF, which a browser cannot show —
     so fall back to the switcher's own thumbnail of it, which it can. */
  img.addEventListener('error', () => {
    const thumb = img.getAttribute('data-thumb');
    if (thumb && img.getAttribute('src') !== thumb) img.setAttribute('src', thumb);
  });
  box.append(img);
  for (const [k, v] of Object.entries({
    position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%',
    overflow: 'hidden', pointerEvents: 'none', userSelect: 'none'
  })) box.style[k] = v;
  for (const [k, v] of Object.entries({
    position: 'absolute', maxWidth: 'none', maxHeight: 'none', pointerEvents: 'none', userSelect: 'none'
  })) img.style[k] = v;
  return box;
}

/** Bring one overlay up to date with its entry in the plan. */
function paint(box, entry) {
  style(box, 'mixBlendMode', entry.blend);
  style(box, 'opacity', String(entry.opacity));
  const img = box.firstElementChild;
  const { place } = entry;
  style(img, 'left', `${place.left}%`);
  style(img, 'top', `${place.top}%`);
  style(img, 'width', `${place.width}%`);
  style(img, 'height', `${place.height}%`);
  if (img.getAttribute('data-file') !== entry.image.file) {
    img.setAttribute('data-file', entry.image.file);
    img.setAttribute('data-thumb', entry.image.thumb);
    img.setAttribute('src', entry.image.file);
  }
}

/**
 * @param {object} opts
 * @param {() => Map} opts.plan     `core.plan(...)` for now: destination → what to draw
 * @param {() => string[]} opts.roles  which buffers, `['PRW']`, `['PGM', 'PRW']`
 * @param {() => boolean} [opts.enabled]
 * @param {Document} [opts.doc]
 */
export function installPixelMaps({ plan, roles, enabled = () => true, doc = document } = {}) {
  let last = { cards: 0, blocks: 0, rasters: 0, drawn: 0, between: 0, top: 0, notDrawn: [] };

  function sweep() {
    const keep = new Set();
    const report = { cards: 0, blocks: 0, rasters: 0, drawn: 0, between: 0, top: 0, notDrawn: [] };

    if (enabled()) {
      const wanted = plan();
      const want = new Set(roles());
      const seen = new Set();
      const blocks = presetBlocks(doc);
      report.blocks = blocks.length;
      report.cards = new Set(blocks.map((b) => b.id)).size;

      for (const { id, role, block } of blocks) {
        const raster = rasterOf(block);
        if (raster) report.rasters += 1;
        const entry = wanted.get(id);
        if (!raster || !entry || !entry.image || !want.has(role)) continue;
        const key = `${id}/${role}`;
        let box = block.querySelector(`[${MARK}="${key}"]`);
        if (!box) box = build(doc, key);
        const slot = slotIn(raster);
        seat(box, slot);
        paint(box, entry);
        keep.add(box);
        seen.add(id);
        report.drawn += 1;
        report[slot.where] += 1;
      }
      for (const [id, entry] of wanted) if (entry.image && !seen.has(id)) report.notDrawn.push(id);
    }

    for (const node of doc.querySelectorAll(`[${MARK}]`)) if (!keep.has(node)) node.remove();
    last = report;
  }

  /* Coalesced: the vendor page mutates constantly, and one sweep per frame
     is plenty. */
  const sweeps = sweeper(sweep, doc);
  const refresh = sweeps.refresh;
  refresh();

  return {
    refresh,
    /** Run a sweep now — for tests, and for a panel that has just changed the plan. */
    sweepNow: sweep,
    /** What the last sweep found and drew. A count of zero is how a moved card shows up. */
    describe: () => ({ ...last, notDrawn: [...last.notDrawn] }),
    stop() {
      sweeps.stop();
      for (const node of doc.querySelectorAll(`[${MARK}]`)) node.remove();
    }
  };
}
