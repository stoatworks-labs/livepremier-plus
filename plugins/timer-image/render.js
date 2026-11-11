/*
 * Timer Image — drawing a reading (`core.drawSpec`) into pixels.
 *
 * Into any 2D context, so the panel's preview and the PNG are the same
 * drawing and a test can hand it a recorder. The text is sized from a
 * template of the reading with every digit made a 0, so the size holds
 * still from one second to the next instead of breathing with the digits.
 */

export const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';
export const font = (px, weight = 600) => `${weight} ${px}px ${FONT_STACK}`;

/** The largest whole font size at which `text` fits `w`×`h`, by `measure(text, px)`. */
export function fitSize(measure, text, w, h) {
  const template = String(text || '0').replace(/\d/g, '0');
  let px = Math.max(8, Math.floor(h));
  const width = measure(template, px);
  if (width > w) px = Math.max(8, Math.floor(px * (w / width)));
  return px;
}

/** Where each line goes: `{ main: { px, y }, sub, label }`, all in canvas pixels. */
export function layout(spec, measure) {
  const W = spec.width;
  const H = spec.height;
  const pad = Math.round(Math.min(W, H) * 0.08);
  const innerW = W - pad * 2;
  const label = spec.label ? Math.max(8, Math.round(H * 0.16)) : 0;
  const subShare = spec.sub ? 0.26 : 0;
  const avail = H - pad * 2 - (label ? label * 1.15 : 0);
  const mainH = avail * (1 - subShare);
  /* Cap height is about 0.72 of the font size in Helvetica: size from the
     box's height through that, then shrink to the width. */
  const main = fitSize(measure, spec.text, innerW, mainH / 0.74);
  const sub = spec.sub ? fitSize(measure, spec.sub, innerW, (avail * subShare) / 0.74) : 0;
  const top = pad + (label ? label * 1.15 : 0);
  const block = main * 0.74 + (sub ? sub * 0.74 + avail * 0.06 : 0);
  const y0 = top + Math.max(0, (avail - block) / 2);
  return {
    pad,
    label: label ? { px: label, y: pad + label * 0.8 } : null,
    main: { px: main, y: y0 + main * 0.74 },
    sub: sub ? { px: sub, y: y0 + main * 0.74 + avail * 0.06 + sub * 0.74 } : null
  };
}

/** A text measurer off a real context. */
export function measurer(ctx) {
  return (text, px) => {
    ctx.font = font(px);
    return ctx.measureText(String(text)).width;
  };
}

/** Draw the timer: a box (unless transparent), its label, the time and a second line. */
export function draw(ctx, spec) {
  const W = spec.width;
  const H = spec.height;
  ctx.clearRect(0, 0, W, H);
  if (spec.background) {
    ctx.fillStyle = spec.background;
    ctx.fillRect(0, 0, W, H);
  }
  const at = layout(spec, measurer(ctx));
  ctx.fillStyle = spec.colour;
  ctx.textBaseline = 'alphabetic';
  if (at.label) {
    ctx.font = font(at.label.px, 500);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.8;
    ctx.fillText(spec.label, at.pad, at.label.y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = 'center';
  ctx.font = font(at.main.px);
  ctx.fillText(spec.text, W / 2, at.main.y);
  if (at.sub) {
    ctx.font = font(at.sub.px, 500);
    ctx.globalAlpha = 0.85;
    ctx.fillText(spec.sub, W / 2, at.sub.y);
    ctx.globalAlpha = 1;
  }
}

/** A canvas of `w`×`h` in a browser, or null. */
function canvasOf(w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && document.createElement) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

/** The PNG the switcher gets. */
export async function renderPng(spec) {
  const canvas = canvasOf(spec.width, spec.height);
  if (!canvas) throw new Error('this browser cannot draw a picture');
  draw(canvas.getContext('2d'), spec);
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the picture could not be encoded'))), 'image/png'));
}

/** Draw into an on-screen canvas at its own size, for the panel's preview. */
export function drawPreview(canvas, spec) {
  if (canvas.width !== spec.width) canvas.width = spec.width;
  if (canvas.height !== spec.height) canvas.height = spec.height;
  draw(canvas.getContext('2d'), spec);
}
