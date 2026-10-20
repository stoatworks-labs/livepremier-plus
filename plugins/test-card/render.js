/*
 * Test Card — drawing a card plan (`core.cardPlan`) into pixels, through
 * Test Card's own painters (`src/vendor/test-card/engine.js`).
 *
 * Into any 2D context, so the PNG, the preview and the thumbnails are the
 * same drawing: the preview and a thumbnail are the full-size drawing through
 * a scaled context, which is how Test Card's own preview works. Test Card's
 * painters work in raster pixels (1 unit = 1 pixel), so an output whose
 * footprint is not its raster's size is drawn at raster size and scaled into
 * the footprint, smoothing off.
 */

import { renderOutputTo, renderCompositionTo } from '../../src/vendor/test-card/engine.js';

/** Draw a plan at full size (scale 1) or through `scale`, from the plan's own top-left. */
export function drawPlan(ctx, plan, settings, scale = 1) {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.scale(scale, scale);
  if (plan.kind === 'canvas') {
    if (plan.whole) {
      renderOutputTo(ctx, plan.whole, withRegions(settings), undefined, plan.composition);
    } else {
      renderCompositionTo(ctx, plan.outputs, plan.composition, settings);
    }
  } else {
    /* Transparent wherever no output with its card on is: the picture sits
       over the show, and only the outputs asked for are covered. */
    ctx.clearRect(0, 0, plan.rect.width, plan.rect.height);
    for (const o of plan.outputs) {
      const fp = o.compositionRect;
      ctx.save();
      ctx.translate(fp.x - plan.rect.left, fp.y - plan.rect.top);
      ctx.beginPath();
      ctx.rect(0, 0, fp.width, fp.height);
      ctx.clip();
      ctx.scale(fp.width / o.widthPx, fp.height / o.heightPx);
      renderOutputTo(ctx, o, settings, undefined, plan.composition);
      ctx.restore();
    }
  }
  ctx.restore();
}

/* Across the canvas, the outputs are what the pattern is drawn over: always
   outlined and named, in the colour Test Card uses for regions. */
const withRegions = (settings) => ({
  ...settings,
  regionOverlay: { ...settings.regionOverlay, enabled: true, outlines: true, labels: true }
});

function surface(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** The card as a PNG at its full size. */
export async function renderPng(plan, settings) {
  const canvas = surface(plan.rect.width, plan.rect.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser gave no 2D canvas.');
  drawPlan(ctx, plan, settings, 1);
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The canvas produced no image'))), 'image/png'));
}

/**
 * The plan drawn into an on-page canvas `width` wide, the right shape, over
 * a checkerboard where the card is transparent.
 */
export function drawPreview(el, plan, settings, width) {
  const scale = Math.min(width / plan.rect.width, 1);
  el.width = Math.max(1, Math.round(plan.rect.width * scale));
  el.height = Math.max(1, Math.round(plan.rect.height * scale));
  const ctx = el.getContext ? el.getContext('2d') : null;
  if (!ctx) return;
  if (plan.kind === 'outputs') checker(ctx, el.width, el.height);
  drawPlan(ctx, plan, settings, scale);
}

function checker(ctx, w, h) {
  const s = 8;
  for (let y = 0; y < h; y += s) {
    for (let x = 0; x < w; x += s) {
      ctx.fillStyle = ((x + y) / s) % 2 ? '#2a3238' : '#1d2328';
      ctx.fillRect(x, y, s, s);
    }
  }
}

/**
 * A thumbnail of one pattern, `width × height`. Drawn as a small raster of its
 * own rather than the real one through a scaled context: a 1-pixel
 * checkerboard on a 1080p output is a million rectangles, too many for a tile
 * that is redrawn whenever an option changes. It is an icon of the pattern,
 * not a preview — the preview is the real drawing.
 */
export function thumbnail(settings, kind, width, height) {
  const el = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  if (!el) return null;
  el.width = width;
  el.height = height;
  const ctx = el.getContext ? el.getContext('2d') : null;
  if (!ctx) return el;
  const output = {
    id: 'thumb', name: '', widthPx: width * 2, heightPx: height * 2, rasterSource: 'declared', source: 'manual',
    regions: [], notes: [], enabled: true
  };
  const s = {
    ...settings, kind,
    overlay: { ...settings.overlay, enabled: false },
    /* At thumbnail size a real pitch would draw a dinosaur's toe. */
    scale: { ...settings.scale, pitchMm: 25, span: false },
    grid: { ...settings.grid, spacingPx: Math.max(8, Math.round(width / 6)), labelCells: false },
    led: { ...settings.led, tileWidthPx: Math.round(width / 3), tileHeightPx: Math.round(width / 3), labelTiles: false },
    pixelCheck: { ...settings.pixelCheck, cellPx: Math.max(2, settings.pixelCheck.cellPx) }
  };
  ctx.save();
  ctx.scale(0.5, 0.5);
  try { renderOutputTo(ctx, output, s); } catch { /* an icon that fails to draw is a blank tile */ }
  ctx.restore();
  return el;
}
