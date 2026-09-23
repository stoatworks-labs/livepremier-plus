/*
 * PNG, both ways, with nothing but `node:zlib`.
 *
 * Decoding is what the relay needs: the switcher's thumbnails arrive as PNG
 * and leave as JPEG. Encoding is here for the tests and the measuring tool,
 * which need a device-shaped PNG to hand to the relay — and for the relay's
 * own fallback, which never needs it but costs nothing to have.
 *
 * ## What the switcher sends
 *
 * Every thumbnail seen from real hardware has been **8-bit RGBA with the
 * pixel data effectively uncompressed**: 147,925 bytes for a 256×144 image on
 * an Aquilon C, 591,155 for 512×288 on a Pulse 4K — each within a few hundred
 * bytes of width × height × 4 plus one filter byte a row. That is why the relay
 * exists: the firmware saves its CPU and spends the network instead.
 *
 * The decoder still reads every colour type and bit depth the spec allows,
 * bar interlacing. The simulators' placeholders are palette images (411 bytes
 * each on the LivePremier simulator), and a future firmware may compress. An
 * image this cannot read throws, and the relay passes the original through.
 */

import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* Channels per pixel, by colour type. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** True when the buffer starts like a PNG. Cheap enough to ask of every response. */
export function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length > 8 && buf.subarray(0, 8).equals(SIGNATURE);
}

/**
 * The header alone: `{ width, height, bitDepth, colorType, interlace }`, or null.
 * Read without inflating anything, so a caller can size an image for free.
 */
export function readHeader(buf) {
  if (!isPng(buf) || buf.length < 33 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28]
  };
}

/**
 * Decode a PNG to straight RGBA, 8 bits a channel.
 *
 * @param {Buffer} buf
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodePng(buf) {
  if (!isPng(buf)) throw new Error('not a PNG');
  let pos = 8;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (body.length !== len) throw new Error(`truncated ${type} chunk`);
    if (type === 'IHDR') header = readHeader(buf);
    else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!header) throw new Error('no IHDR');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace) throw new Error('interlaced PNG');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`colour type ${colorType}`);
  if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`bit depth ${bitDepth}`);
  if (colorType === 3 && !palette) throw new Error('palette image with no PLTE');
  if (!width || !height || width * height > 64e6) throw new Error(`size ${width}×${height}`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * bitDepth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  /* Filters work on whole bytes, a pixel's worth back — at least one. */
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < height * (stride + 1)) throw new Error('image data is short');

  const lines = unfilter(raw, height, stride, bpp);
  return { width, height, data: expand(lines, width, height, stride, bitDepth, colorType, palette, trns) };
}

/** Undo the per-row filters in place. Returns the rows packed back to back, filter bytes gone. */
function unfilter(raw, height, stride, bpp) {
  const out = new Uint8Array(height * stride);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    switch (filter) {
      case 0:
        cur.set(src);
        break;
      case 1:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + (i >= bpp ? cur[i - bpp] : 0);
        break;
      case 2:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + prev[i];
        break;
      case 3:
        for (let i = 0; i < stride; i++) cur[i] = src[i] + (((i >= bpp ? cur[i - bpp] : 0) + prev[i]) >> 1);
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? cur[i - bpp] : 0;
          const b = prev[i];
          const c = i >= bpp ? prev[i - bpp] : 0;
          cur[i] = src[i] + paeth(a, b, c);
        }
        break;
      default:
        throw new Error(`filter ${filter} on row ${y}`);
    }
    prev = cur;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Packed samples of any depth and colour type to RGBA8. */
function expand(lines, width, height, stride, bitDepth, colorType, palette, trns) {
  const out = new Uint8Array(width * height * 4);
  const channels = CHANNELS[colorType];
  /* One sample, as 0–255, whatever depth it was stored at. Palette indices are
     returned raw: they are looked up, not scaled. */
  const max = (1 << bitDepth) - 1;
  const sample = (row, index) => {
    if (bitDepth === 8) return lines[row + index];
    if (bitDepth === 16) return lines[row + index * 2];
    const bit = index * bitDepth;
    const v = (lines[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & max;
    return colorType === 3 ? v : Math.round((v * 255) / max);
  };
  /* A tRNS on a grey or RGB image names one colour as transparent, in the
     image's own depth. */
  const key = trns && (colorType === 0 || colorType === 2)
    ? Array.from({ length: colorType === 0 ? 1 : 3 }, (_, i) => trns.readUInt16BE(i * 2))
    : null;
  const rawSample = (row, index) => {
    if (bitDepth === 16) return (lines[row + index * 2] << 8) | lines[row + index * 2 + 1];
    if (bitDepth === 8) return lines[row + index];
    const bit = index * bitDepth;
    return (lines[row + (bit >> 3)] >> (8 - bitDepth - (bit & 7))) & max;
  };

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      let r; let g; let b; let a = 255;
      switch (colorType) {
        case 0:
          r = g = b = sample(row, s);
          if (key && rawSample(row, s) === key[0]) a = 0;
          break;
        case 2:
          r = sample(row, s); g = sample(row, s + 1); b = sample(row, s + 2);
          if (key && rawSample(row, s) === key[0] && rawSample(row, s + 1) === key[1]
            && rawSample(row, s + 2) === key[2]) a = 0;
          break;
        case 3: {
          const i = sample(row, s);
          r = palette[i * 3] ?? 0; g = palette[i * 3 + 1] ?? 0; b = palette[i * 3 + 2] ?? 0;
          if (trns && i < trns.length) a = trns[i];
          break;
        }
        case 4:
          r = g = b = sample(row, s); a = sample(row, s + 1);
          break;
        default:
          r = sample(row, s); g = sample(row, s + 1); b = sample(row, s + 2); a = sample(row, s + 3);
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ encode */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode RGBA8 as a PNG.
 *
 * `level: 0` stores the pixels uncompressed, which is what the switcher's
 * firmware sends and what the tests want to imitate. `filter` picks one row
 * filter for every row (0–4), so the decoder's five paths can each be driven.
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {{level?: number, filter?: number}} [opts]
 */
export function encodePng(rgba, width, height, { level = 6, filter = 0 } = {}) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  const zero = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y ? rgba.subarray((y - 1) * stride, y * stride) : zero;
    const o = y * (stride + 1);
    raw[o] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? cur[i - 4] : 0;
      const b = prev[i];
      const c = i >= 4 ? prev[i - 4] : 0;
      let predicted = 0;
      if (filter === 1) predicted = a;
      else if (filter === 2) predicted = b;
      else if (filter === 3) predicted = (a + b) >> 1;
      else if (filter === 4) predicted = paeth(a, b, c);
      raw[o + 1 + i] = (cur[i] - predicted) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}
