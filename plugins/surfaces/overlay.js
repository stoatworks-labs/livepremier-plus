/*
 * Surfaces — the outlines, laid into the vendor's own screen cards.
 *
 * Each surface drawn as a dashed rectangle with its name, over the canvas of
 * every PGM and PRW buffer of its screen, so the operator dragging a layer
 * can see the edge it is going to stop at. A surface with a bound layer
 * standing outside it on that buffer is drawn red and says which layer —
 * on program, where nothing here corrects it, that is the only warning.
 *
 * Where it goes is `src/ui/canvas-overlay.js`'s business: between the layers
 * and the handles, over a Pixel Map if there is one. Like the map it takes no
 * pointer — `pointer-events: none`, `aria-hidden` — and is drawn in
 * percentages of the raster, so the card's zoom and pan carry it. A firmware
 * that restructures the card makes the outlines not appear, quietly, so
 * `describe()` counts what was found and drawn and the panel prints it.
 */

import { presetBlocks } from '../../src/ui/preset-lock.js';
import { OVERLAY, MARKS, rasterOf, slotIn, seat, style, sweeper } from '../../src/ui/canvas-overlay.js';

/** Ours, so a re-render cannot end up with two and so `stop()` can find them. */
export const MARK = MARKS.surfaces;

export const LINE = '#4FC3F7';
export const ALERT = '#FF5252';

const pct = (a, b) => `${Math.round((a / b) * 1e6) / 1e4}%`;

function build(doc, key) {
  const box = doc.createElement('div');
  box.setAttribute(MARK, key);
  box.setAttribute(OVERLAY, 'surfaces');
  box.setAttribute('aria-hidden', 'true');
  box.className = 'wru-surfaces';
  for (const [k, v] of Object.entries({
    position: 'absolute', left: '0px', top: '0px', width: '100%', height: '100%',
    overflow: 'hidden', pointerEvents: 'none', userSelect: 'none'
  })) box.style[k] = v;
  return box;
}

/** One surface's outline and label, rebuilt only when what it shows changes. */
function outline(doc, surface, canvas, alert) {
  const el = doc.createElement('div');
  const colour = alert ? ALERT : LINE;
  for (const [k, v] of Object.entries({
    position: 'absolute',
    left: pct(surface.x, canvas.width),
    top: pct(surface.y, canvas.height),
    width: pct(surface.width, canvas.width),
    height: pct(surface.height, canvas.height),
    boxSizing: 'border-box',
    border: `2px dashed ${colour}`,
    pointerEvents: 'none'
  })) el.style[k] = v;
  const tag = doc.createElement('span');
  tag.textContent = alert ? `${surface.name} · ${alert}` : surface.name;
  for (const [k, v] of Object.entries({
    position: 'absolute', left: '0px', top: '0px', padding: '0 4px',
    font: '600 10px/14px sans-serif', color: '#000', background: colour,
    whiteSpace: 'nowrap', pointerEvents: 'none'
  })) tag.style[k] = v;
  el.append(tag);
  return el;
}

/**
 * @param {object} opts
 * @param {() => Map<string, {canvas, surfaces: object[], outside: {PGM: Map, PRW: Map}}>} opts.plan
 *        destination → its canvas, its surfaces, and per role which surfaces have a layer out
 * @param {() => boolean} [opts.enabled]
 * @param {Document} [opts.doc]
 */
export function installSurfaceOutlines({ plan, enabled = () => true, doc = document } = {}) {
  let last = { cards: 0, blocks: 0, rasters: 0, drawn: 0, between: 0, top: 0 };

  function sweep() {
    const keep = new Set();
    const report = { cards: 0, blocks: 0, rasters: 0, drawn: 0, between: 0, top: 0 };

    if (enabled()) {
      const wanted = plan();
      const blocks = presetBlocks(doc);
      report.blocks = blocks.length;
      report.cards = new Set(blocks.map((b) => b.id)).size;

      for (const { id, role, block } of blocks) {
        const raster = rasterOf(block);
        if (raster) report.rasters += 1;
        const entry = wanted.get(id);
        if (!raster || !entry || !entry.surfaces.length || !entry.canvas) continue;
        const key = `${id}/${role}`;
        let box = block.querySelector(`[${MARK}="${key}"]`);
        if (!box) box = build(doc, key);
        const slot = slotIn(raster, { below: [MARKS.pixelMap] });
        seat(box, slot);

        const out = (entry.outside && entry.outside[role]) || new Map();
        const sig = JSON.stringify([entry.canvas.width, entry.canvas.height,
          entry.surfaces.map((s) => [s.id, s.name, s.x, s.y, s.width, s.height, out.get(s.id) || ''])]);
        if (box.getAttribute('data-sig') !== sig) {
          box.setAttribute('data-sig', sig);
          while (box.firstChild) box.firstChild.remove();
          for (const s of entry.surfaces) box.append(outline(doc, s, entry.canvas, out.get(s.id) || ''));
        }
        style(box, 'display', '');
        keep.add(box);
        report.drawn += 1;
        report[slot.where] += 1;
      }
    }

    for (const node of doc.querySelectorAll(`[${MARK}][${OVERLAY}]`)) if (!keep.has(node)) node.remove();
    last = report;
  }

  const sweeps = sweeper(sweep, doc);
  sweeps.refresh();

  return {
    refresh: sweeps.refresh,
    sweepNow: sweep,
    describe: () => ({ ...last }),
    stop() {
      sweeps.stop();
      for (const node of doc.querySelectorAll(`[${MARK}][${OVERLAY}]`)) node.remove();
    }
  };
}
