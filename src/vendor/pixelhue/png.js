// Minimal PNG encoder: RGB or RGBA pixels → PNG bytes. Enough to turn Companion's
// raw 72×72 RGB bitmaps into the PNG the U5 mini's key displays take.

import { deflateSync } from 'node:zlib';

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * @param {Uint8Array} pixels  packed rows, `channels` bytes per pixel, no padding
 * @param {number} width
 * @param {number} height
 * @param {3|4} [channels]
 */
export function encodePng(pixels, width, height, channels = 3) {
  if (pixels.length !== width * height * channels) {
    throw new Error(`pixel buffer is ${pixels.length} bytes, expected ${width * height * channels}`);
  }
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(pixels.buffer, pixels.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 4 ? 6 : 2; // colour type: RGBA / RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A flat-colour square, handy for tests and blanking. */
export function solidPng(size, [r, g, b]) {
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) { px[i * 3] = r; px[i * 3 + 1] = g; px[i * 3 + 2] = b; }
  return encodePng(px, size, size, 3);
}
