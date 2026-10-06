/*
 * Background Slicer — the cuts, drawn. Browser only; nothing runs at import.
 *
 * Each output's image is a canvas the size of its raster, filled with the
 * background colour, with every blit of the plan drawn through the
 * transform `core.blitTransform` gives it. Two things make a 1:1 cut a copy
 * of pixels rather than a resampling, and both are deliberate:
 *
 *   - **Smoothing is off for an exact blit** (`core.isExact`): whole-pixel
 *     source and destination of the same size, under an integer transform,
 *     with nearest sampling, is a copy. A scaled blit (Fit, a pitch ratio)
 *     turns smoothing on at high quality instead.
 *   - **The picture is decoded with no colour conversion**
 *     (`createImageBitmap(file, { colorSpaceConversion: 'none',
 *     premultiplyAlpha: 'none' })`): a PNG or JPEG carrying an ICC profile
 *     would otherwise be converted to the display's space on the way in, and
 *     every "copied" pixel would differ from the file by the conversion.
 *
 * `core.renderRGBA` is the reference both are held to, in the tests.
 */

import { blitTransform, isExact } from './core.js';

/** Decode a picture file to an ImageBitmap with its pixel values untouched. */
export async function decodePicture(file) {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  return { bitmap, width: bitmap.width, height: bitmap.height };
}

function makeCanvas(width, height, doc = globalThis.document) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const c = doc.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

async function toPng(canvas) {
  if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the PNG'))), 'image/png'));
}

/**
 * One output's background as a PNG blob: `width × height`, `fill` behind,
 * each blit of `source` (an ImageBitmap or image element) drawn into place.
 * A null source draws the blits' outlines only — the live mode's preview
 * when no picture was chosen.
 */
export async function renderOutput({ source, blits, width, height, fill = '#000000' }) {
  const canvas = makeCanvas(width, height);
  const g = canvas.getContext('2d', { alpha: false });
  g.fillStyle = fill;
  g.fillRect(0, 0, width, height);
  for (const b of blits) {
    g.save();
    g.setTransform(...blitTransform(b));
    const exact = isExact(b);
    g.imageSmoothingEnabled = !exact;
    if (!exact) g.imageSmoothingQuality = 'high';
    if (source) g.drawImage(source, b.src.x, b.src.y, b.src.w, b.src.h, 0, 0, b.lw, b.lh);
    else { g.strokeStyle = '#2185D0'; g.lineWidth = 4; g.strokeRect(2, 2, b.lw - 4, b.lh - 4); }
    g.restore();
  }
  return toPng(canvas);
}

/**
 * A template (`exports.templateShapes`) painted as a PNG — the same
 * rectangles and labels `templateSvg` writes, so the two cannot differ.
 */
export async function renderTemplate(shapes) {
  const { width, height } = shapes;
  const canvas = makeCanvas(width, height);
  const g = canvas.getContext('2d');
  const font = Math.max(12, Math.round(Math.min(width, height) / 40));
  g.fillStyle = '#101418';
  g.fillRect(0, 0, width, height);
  g.fillStyle = '#7f8a93';
  g.font = `${font}px Helvetica, Arial, sans-serif`;
  g.textAlign = 'left';
  g.fillText(shapes.title, font / 2, height - font / 2);
  for (const r of shapes.rects) {
    const f = Math.max(10, Math.min(font, Math.round(Math.min(r.w, r.h) / 8)));
    g.globalAlpha = 0.18;
    g.fillStyle = r.color;
    g.fillRect(r.x, r.y, r.w, r.h);
    g.globalAlpha = 1;
    g.strokeStyle = r.color;
    g.lineWidth = 2;
    g.strokeRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2);
    g.textAlign = 'center';
    g.fillStyle = '#ffffff';
    g.font = `bold ${f}px Helvetica, Arial, sans-serif`;
    g.fillText(r.label, r.x + r.w / 2, r.y + r.h / 2);
    g.fillStyle = '#d0d6db';
    g.font = `${Math.round(f * 0.75)}px Helvetica, Arial, sans-serif`;
    g.fillText(r.sub, r.x + r.w / 2, r.y + r.h / 2 + f * 1.3);
  }
  return toPng(canvas);
}

/** Hand the operator a file. */
export function download(data, name, type = 'application/octet-stream', doc = globalThis.document) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = name;
  a.style.display = 'none';
  doc.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
