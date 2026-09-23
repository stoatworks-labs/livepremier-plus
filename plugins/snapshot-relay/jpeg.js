/*
 * A baseline JPEG encoder, in plain JavaScript.
 *
 * Written here rather than depended on because this app ships no
 * dependencies, and one with a native half (sharp, anything on libjpeg) would
 * be the first thing to break the universal macOS build. The job is small:
 * a 512×288 thumbnail, a few dozen times a second at most, in a worker.
 *
 * It is the textbook encoder — JFIF, baseline sequential, 4:2:0 chroma, the
 * Annex K quantisation and Huffman tables, the AAN floating-point DCT — and
 * the tests check its output against an independent decoder. Nothing clever,
 * on purpose: an image the browser shows wrong is a thumbnail an operator
 * trusts wrong.
 *
 * Alpha is composited over black, which is what an `<img>` on the Web RCS's
 * dark cards would have shown anyway.
 */

/* Natural order → zigzag position. */
const ZIGZAG = [
  0, 1, 5, 6, 14, 15, 27, 28,
  2, 4, 7, 13, 16, 26, 29, 42,
  3, 8, 12, 17, 25, 30, 41, 43,
  9, 11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54,
  20, 22, 33, 38, 46, 51, 55, 60,
  21, 34, 37, 47, 50, 56, 59, 61,
  35, 36, 48, 49, 57, 58, 62, 63
];

/* Annex K.1 and K.2, natural order. */
const LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99
];
const CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99
];

/* Annex K.3: code counts by length 1–16, then the symbols. */
const DC_LUMA = { counts: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const DC_CHROMA = { counts: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], symbols: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const AC_LUMA = {
  counts: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  symbols: [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};
const AC_CHROMA = {
  counts: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  symbols: [
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa
  ]
};

/** Canonical codes for a table: `codes[symbol] = [code, length]`. */
function buildCodes({ counts, symbols }) {
  const codes = new Array(256);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) codes[symbols[k++]] = [code++, len];
    code <<= 1;
  }
  return codes;
}

const CODES = {
  dcY: buildCodes(DC_LUMA), acY: buildCodes(AC_LUMA),
  dcC: buildCodes(DC_CHROMA), acC: buildCodes(AC_CHROMA)
};

/* AAN scale factors, folded into the quantiser so the DCT needs no multiply
   of its own at the end. */
const AAN = [1.0, 1.387039845, 1.306562965, 1.175875602, 1.0, 0.785694958, 0.5411961, 0.275899379];

/** IJG quality scaling: 50 is the Annex K tables, 100 all ones. */
function quantTables(quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - q * 2;
  const build = (base) => {
    const zz = new Uint8Array(64);      /* in zigzag order, for the DQT segment */
    const divisors = new Float64Array(64); /* natural order, for the DCT */
    for (let i = 0; i < 64; i++) {
      const v = Math.min(255, Math.max(1, Math.floor((base[i] * scale + 50) / 100)));
      zz[ZIGZAG[i]] = v;
    }
    for (let row = 0, i = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++, i++) {
        divisors[i] = 1 / (zz[ZIGZAG[i]] * AAN[row] * AAN[col] * 8);
      }
    }
    return { zz, divisors };
  };
  return { luma: build(LUMA_Q), chroma: build(CHROMA_Q) };
}

/** A byte sink with JPEG's entropy-coded stuffing: every 0xFF is followed by 0x00. */
class BitWriter {
  constructor(size) {
    this.buf = new Uint8Array(size);
    this.len = 0;
    this.acc = 0;
    this.bits = 0;
  }

  grow(n) {
    if (this.len + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  byte(b) { this.grow(1); this.buf[this.len++] = b; }

  word(w) { this.byte(w >> 8); this.byte(w & 0xff); }

  bytes(list) { for (const b of list) this.byte(b); }

  write(code, length) {
    this.acc = (this.acc << length) | code;
    this.bits += length;
    while (this.bits >= 8) {
      const b = (this.acc >>> (this.bits - 8)) & 0xff;
      this.byte(b);
      if (b === 0xff) this.byte(0);
      this.bits -= 8;
    }
    this.acc &= (1 << this.bits) - 1;
  }

  /** Pad the last byte with ones, as the spec asks. */
  flush() {
    if (this.bits > 0) this.write((1 << (8 - this.bits)) - 1, 8 - this.bits);
  }

  result() { return Buffer.from(this.buf.buffer, this.buf.byteOffset, this.len); }
}

/** Forward DCT and quantise one 8×8 block, in place, answering the zigzagged coefficients. */
function fdctQuant(block, divisors, out) {
  for (let i = 0; i < 64; i += 8) dct1d(block, i, 1);
  for (let i = 0; i < 8; i++) dct1d(block, i, 8);
  for (let i = 0; i < 64; i++) {
    const v = block[i] * divisors[i];
    out[ZIGZAG[i]] = v > 0 ? (v + 0.5) | 0 : (v - 0.5) | 0;
  }
}

/* AAN, one row or one column: `o` the first element, `s` the step. */
function dct1d(d, o, s) {
  const d0 = d[o]; const d1 = d[o + s]; const d2 = d[o + 2 * s]; const d3 = d[o + 3 * s];
  const d4 = d[o + 4 * s]; const d5 = d[o + 5 * s]; const d6 = d[o + 6 * s]; const d7 = d[o + 7 * s];
  const t0 = d0 + d7; const t7 = d0 - d7;
  const t1 = d1 + d6; const t6 = d1 - d6;
  const t2 = d2 + d5; const t5 = d2 - d5;
  const t3 = d3 + d4; const t4 = d3 - d4;

  let t10 = t0 + t3; const t13 = t0 - t3;
  let t11 = t1 + t2; let t12 = t1 - t2;
  d[o] = t10 + t11;
  d[o + 4 * s] = t10 - t11;
  const z1 = (t12 + t13) * 0.707106781;
  d[o + 2 * s] = t13 + z1;
  d[o + 6 * s] = t13 - z1;

  t10 = t4 + t5; t11 = t5 + t6; t12 = t6 + t7;
  const z5 = (t10 - t12) * 0.382683433;
  const z2 = 0.5411961 * t10 + z5;
  const z4 = 1.306562965 * t12 + z5;
  const z3 = t11 * 0.707106781;
  const z11 = t7 + z3;
  const z13 = t7 - z3;
  d[o + 5 * s] = z13 + z2;
  d[o + 3 * s] = z13 - z2;
  d[o + s] = z11 + z4;
  d[o + 7 * s] = z11 - z4;
}

/** The size category of a coefficient, and its bits in JPEG's one's-complement spelling. */
function magnitude(v) {
  const a = v < 0 ? -v : v;
  let cat = 0;
  for (let x = a; x; x >>= 1) cat++;
  return [cat, v < 0 ? (v - 1) & ((1 << cat) - 1) : v];
}

function encodeBlock(w, coeffs, prevDc, dc, ac) {
  const diff = coeffs[0] - prevDc;
  const [cat, bits] = magnitude(diff);
  w.write(dc[cat][0], dc[cat][1]);
  if (cat) w.write(bits, cat);

  let last = 63;
  while (last > 0 && coeffs[last] === 0) last--;
  let run = 0;
  for (let i = 1; i <= last; i++) {
    const v = coeffs[i];
    if (v === 0) { run++; continue; }
    while (run >= 16) { w.write(ac[0xf0][0], ac[0xf0][1]); run -= 16; }
    const [c, b] = magnitude(v);
    const sym = ac[(run << 4) | c];
    w.write(sym[0], sym[1]);
    w.write(b, c);
    run = 0;
  }
  if (last < 63) w.write(ac[0][0], ac[0][1]);
  return coeffs[0];
}

function writeTable(w, cls, id, { counts, symbols }) {
  w.word(0xffc4);
  w.word(2 + 1 + 16 + symbols.length);
  w.byte((cls << 4) | id);
  w.bytes(counts);
  w.bytes(symbols);
}

/**
 * Encode RGBA8 as a baseline JPEG.
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {number} height
 * @param {number} [quality]  1–100, IJG scaling
 * @returns {Buffer}
 */
export function encodeJpeg(rgba, width, height, quality = 75) {
  if (!width || !height || width > 65535 || height > 65535) throw new Error(`size ${width}×${height}`);
  const { luma, chroma } = quantTables(quality);
  const w = new BitWriter(Math.max(4096, width * height));

  /* SOI, then JFIF APP0: version 1.1, no density, no thumbnail. */
  w.word(0xffd8);
  w.word(0xffe0); w.word(16);
  w.bytes([0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

  w.word(0xffdb); w.word(2 + 2 * 65);
  w.byte(0); w.bytes(luma.zz);
  w.byte(1); w.bytes(chroma.zz);

  /* SOF0: three components, luma sampled 2×2, chroma 1×1. */
  w.word(0xffc0); w.word(17);
  w.byte(8); w.word(height); w.word(width); w.byte(3);
  w.bytes([1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

  writeTable(w, 0, 0, DC_LUMA);
  writeTable(w, 1, 0, AC_LUMA);
  writeTable(w, 0, 1, DC_CHROMA);
  writeTable(w, 1, 1, AC_CHROMA);

  w.word(0xffda); w.word(12);
  w.byte(3);
  w.bytes([1, 0x00, 2, 0x11, 3, 0x11]);
  w.bytes([0, 63, 0]);

  const Y = new Float64Array(256);
  const Cb = new Float64Array(64);
  const Cr = new Float64Array(64);
  const block = new Float64Array(64);
  const coeffs = new Int32Array(64);
  let dcY = 0; let dcCb = 0; let dcCr = 0;

  for (let my = 0; my < height; my += 16) {
    for (let mx = 0; mx < width; mx += 16) {
      Cb.fill(0); Cr.fill(0);
      for (let y = 0; y < 16; y++) {
        /* Past the edge, repeat the last row and column: padding with black
           would bleed a dark fringe into the edge blocks. */
        const sy = Math.min(height - 1, my + y);
        for (let x = 0; x < 16; x++) {
          const sx = Math.min(width - 1, mx + x);
          const p = (sy * width + sx) * 4;
          const a = rgba[p + 3] / 255;
          const r = rgba[p] * a; const g = rgba[p + 1] * a; const b = rgba[p + 2] * a;
          Y[y * 16 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          const c = (y >> 1) * 8 + (x >> 1);
          Cb[c] += (-0.168736 * r - 0.331264 * g + 0.5 * b) / 4;
          Cr[c] += (0.5 * r - 0.418688 * g - 0.081312 * b) / 4;
        }
      }
      for (const [ox, oy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) {
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) block[y * 8 + x] = Y[(oy + y) * 16 + ox + x];
        fdctQuant(block, luma.divisors, coeffs);
        dcY = encodeBlock(w, coeffs, dcY, CODES.dcY, CODES.acY);
      }
      block.set(Cb);
      fdctQuant(block, chroma.divisors, coeffs);
      dcCb = encodeBlock(w, coeffs, dcCb, CODES.dcC, CODES.acC);
      block.set(Cr);
      fdctQuant(block, chroma.divisors, coeffs);
      dcCr = encodeBlock(w, coeffs, dcCr, CODES.dcC, CODES.acC);
    }
  }

  w.flush();
  w.word(0xffd9);
  return w.result();
}
