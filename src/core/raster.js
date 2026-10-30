/*
 * A few RGBA drawing operations, in plain JavaScript.
 *
 * For pictures made away from a browser — desk control's NDI feeds, drawn in
 * the media host (`devices/media/`) — where there is no canvas to ask. A
 * picture is `{width, height, data}`, `data` RGBA, 8 bits a channel, and
 * every operation clips to it, so a rectangle half off the screen draws its
 * other half and nothing else.
 *
 * Text is the EC panel's 5 × 8 pixel font (`ec-font.js`), scaled whole:
 * labels a desk operator reads across a room, not typography.
 */

import { paintText } from './ec-font.js';

/** A picture of one colour. */
export function blank(width, height, [r, g, b] = [0, 0, 0]) {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width: w, height: h, data };
}

/** `rect` as whole pixels inside the picture: `{x0, y0, x1, y1}`, empty when x1 <= x0 or y1 <= y0. */
function clip(pic, { x, y, w, h }) {
  return {
    x0: Math.max(0, Math.round(x)),
    y0: Math.max(0, Math.round(y)),
    x1: Math.min(pic.width, Math.round(x + w)),
    y1: Math.min(pic.height, Math.round(y + h)),
  };
}

/** Blend one pixel: `a` from 0 (leave it) to 1 (replace it). */
function put(d, i, r, g, b, a) {
  if (a >= 1) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; return; }
  const k = 1 - a;
  d[i] = d[i] * k + r * a;
  d[i + 1] = d[i + 1] * k + g * a;
  d[i + 2] = d[i + 2] * k + b * a;
}

/** A filled rectangle, `opacity` 0..1. */
export function fill(pic, rect, [r, g, b], opacity = 1) {
  const { x0, y0, x1, y1 } = clip(pic, rect);
  if (opacity <= 0) return;
  for (let y = y0; y < y1; y++) {
    for (let x = x0, i = (y * pic.width + x0) * 4; x < x1; x++, i += 4) put(pic.data, i, r, g, b, opacity);
  }
}

/** A rectangle's outline, `width` pixels thick, drawn inside it. */
export function stroke(pic, { x, y, w, h }, rgb, width = 2) {
  const t = Math.max(1, Math.min(width, w / 2, h / 2));
  fill(pic, { x, y, w, h: t }, rgb);
  fill(pic, { x, y: y + h - t, w, h: t }, rgb);
  fill(pic, { x, y: y + t, w: t, h: h - 2 * t }, rgb);
  fill(pic, { x: x + w - t, y: y + t, w: t, h: h - 2 * t }, rgb);
}

/**
 * `img` stretched to fill `rect`, sampled bilinearly, its own alpha and
 * `opacity` (0..1) together saying how much of it covers what is there.
 * Stretched rather than fitted: that is what a switcher does with a source
 * on a layer.
 */
export function draw(pic, img, rect, opacity = 1) {
  if (!img || !img.width || !img.height || opacity <= 0 || rect.w <= 0 || rect.h <= 0) return;
  const { x0, y0, x1, y1 } = clip(pic, rect);
  const sx = img.width / rect.w;
  const sy = img.height / rect.h;
  const s = img.data;
  const d = pic.data;
  const maxX = img.width - 1;
  const maxY = img.height - 1;
  for (let y = y0; y < y1; y++) {
    const fy = Math.min(maxY, Math.max(0, (y + 0.5 - rect.y) * sy - 0.5));
    const ya = Math.floor(fy);
    const yb = Math.min(maxY, ya + 1);
    const wy = fy - ya;
    for (let x = x0, i = (y * pic.width + x0) * 4; x < x1; x++, i += 4) {
      const fx = Math.min(maxX, Math.max(0, (x + 0.5 - rect.x) * sx - 0.5));
      const xa = Math.floor(fx);
      const xb = Math.min(maxX, xa + 1);
      const wx = fx - xa;
      const p00 = (ya * img.width + xa) * 4;
      const p01 = (ya * img.width + xb) * 4;
      const p10 = (yb * img.width + xa) * 4;
      const p11 = (yb * img.width + xb) * 4;
      const mix = (c) => (s[p00 + c] * (1 - wx) + s[p01 + c] * wx) * (1 - wy) + (s[p10 + c] * (1 - wx) + s[p11 + c] * wx) * wy;
      const a = (mix(3) / 255) * opacity;
      if (a > 0) put(d, i, mix(0), mix(1), mix(2), a);
    }
  }
}

/**
 * A label in `rect`, centred, at the largest of `scales` it fits — wrapped at
 * spaces, as the EC panel's keys are (`ec-font.js`'s `layout`).
 */
export function text(pic, label, rect, [r, g, b], scales = [4, 3, 2, 1]) {
  const ox = Math.round(rect.x);
  const oy = Math.round(rect.y);
  const w = Math.round(rect.w);
  const h = Math.round(rect.h);
  if (w <= 0 || h <= 0 || !String(label ?? '').trim()) return;
  paintText(label, w, h, (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const px = ox + x;
    const py = oy + y;
    if (px < 0 || py < 0 || px >= pic.width || py >= pic.height) return;
    put(pic.data, (py * pic.width + px) * 4, r, g, b, 1);
  }, scales);
}

/**
 * A picture from a list of operations, in order — what the media host is
 * sent for each frame, so the drawing is done where the frame is sent and
 * the app's own process stays free for the desk:
 *
 *     { op: 'fill',   rect, rgb, opacity? }
 *     { op: 'stroke', rect, rgb, width? }
 *     { op: 'image',  rect, image, opacity? }   image: a key into `images`
 *     { op: 'text',   rect, text, rgb, scales? }
 *
 * `rect` is `{x, y, w, h}` in the picture's pixels. An operation this does
 * not know, or an image key with no image, is passed over.
 */
export function render({ width, height, background = [0, 0, 0], ops = [] }, images = {}) {
  const pic = blank(width, height, background);
  for (const o of ops) {
    if (!o || !o.rect) continue;
    if (o.op === 'fill') fill(pic, o.rect, o.rgb || [0, 0, 0], o.opacity ?? 1);
    else if (o.op === 'stroke') stroke(pic, o.rect, o.rgb || [255, 255, 255], o.width ?? 2);
    else if (o.op === 'image') draw(pic, images[o.image], o.rect, o.opacity ?? 1);
    else if (o.op === 'text') text(pic, o.text, o.rect, o.rgb || [255, 255, 255], o.scales);
  }
  return pic;
}
