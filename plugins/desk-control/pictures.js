/*
 * Desk control — thumbnails and preview frames for CITP. ** PREVIEW **
 * No I/O: images in, encoded images out.
 *
 * A desk asks for a format (RGB8, JPEG, PNG; fragmented JPEG or PNG for a
 * stream) and a size, and the switcher's snapshots are PNGs. So a snapshot
 * is decoded, fitted inside the size asked for — never grown — and encoded
 * as asked. An element with no snapshot (a screen, a background, colour,
 * black, an input the switcher has no picture of) gets a plain card instead.
 *
 * A thumbnail or an unfragmented frame goes in a buffer whose size is a
 * uint16, so one that comes out too big is made again smaller.
 */

import { decodePng, encodePng } from '../../server/image/png.js';
import { encodeJpeg } from '../../server/image/jpeg.js';
import { fitWidth } from '../../server/image/resize.js';
import { FORMATS } from '../../src/core/citp.js';

/* Under 64 KiB with room for the message around it. */
export const MAX_BUFFER = 65_000;
const CARD_MAX = { width: 160, height: 90 };
const JPEG_QUALITY = 70;

/** A plain RGBA card of one colour. */
export function card([r, g, b], width, height) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width, height, data };
}

/** A card the size a desk asked for, within reason. */
export function cardFor(rgb, width, height) {
  const w = Math.max(1, Math.min(width || CARD_MAX.width, CARD_MAX.width));
  const h = Math.max(1, Math.min(height || CARD_MAX.height, CARD_MAX.height));
  return card(rgb, w, h);
}

/** An image fitted inside `width` × `height`, aspect kept, never enlarged. */
export function fitBox(img, width, height) {
  if (!width || !height) return img;
  const byHeight = Math.round((img.width * height) / img.height);
  return fitWidth(img, Math.min(width, byHeight));
}

/** RGBA → the format's bytes. RGB8 is composited over black, and BGR for an MSEX 1.0 asker. */
export function encodeAs(img, format, { bgr = false, quality = JPEG_QUALITY } = {}) {
  if (format === FORMATS.RGB8) {
    const { data } = img;
    const out = new Uint8Array(img.width * img.height * 3);
    for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
      const a = data[i + 3];
      const r = (data[i] * a + 127) / 255 | 0;
      const g = (data[i + 1] * a + 127) / 255 | 0;
      const b = (data[i + 2] * a + 127) / 255 | 0;
      out[o] = bgr ? b : r; out[o + 1] = g; out[o + 2] = bgr ? r : b;
    }
    return out;
  }
  if (format === FORMATS.PNG || format === FORMATS.FPNG) return new Uint8Array(encodePng(img.data, img.width, img.height));
  return new Uint8Array(encodeJpeg(img.data, img.width, img.height, quality));
}

/** The formats this can make; anything else asked for is answered in JPEG. */
const KNOWN = new Set(Object.values(FORMATS));

/**
 * An image as a desk asked for it: `{format, width, height, data}`.
 *
 * @param {{width: number, height: number, data: Uint8Array}} img   RGBA
 * @param {object} want
 * @param {string} want.format
 * @param {number} want.width
 * @param {number} want.height
 * @param {boolean} [want.bgr]       RGB8 for an MSEX 1.0 asker
 * @param {number} [want.limit]      the buffer must be under this; Infinity for a fragmented stream
 */
export function picture(img, { format, width, height, bgr = false, limit = MAX_BUFFER }) {
  const as = KNOWN.has(format) ? format : FORMATS.JPEG;
  let fitted = fitBox(img, width, height);
  for (let tries = 0; ; tries++) {
    const data = encodeAs(fitted, as, { bgr, quality: Math.max(30, JPEG_QUALITY - tries * 10) });
    if (data.length < limit || tries >= 6 || fitted.width <= 8) return { format: as, width: fitted.width, height: fitted.height, data };
    fitted = fitWidth(fitted, Math.max(8, Math.floor(fitted.width * 0.7)));
  }
}

/** A switcher snapshot's bytes decoded, or null when they are not a picture this can read. */
export function decodeSnapshot(bytes) {
  try {
    const img = decodePng(Buffer.from(bytes));
    return { width: img.width, height: img.height, data: img.data };
  } catch {
    return null;
  }
}
