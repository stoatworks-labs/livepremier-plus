/*
 * Key labels for the EC panel's 64 × 32, 1-bit LCD cells.  ** PREVIEW **
 *
 * The glyphs are qubered/ec50-panel's `font.py` (MIT, Jayden Nawotka, 2026 —
 * ATTRIBUTIONS.md): 5 columns wide, 8 rows tall so descenders sit below the
 * baseline, one column byte each with bit 0 the top row. The layout is the
 * same idea in fewer lines: the largest of three sizes that fits, wrapped at
 * spaces, each line centred and the block centred in the cell. A 64 × 32 cell
 * holds one line at 3×, two at 2×, four at 1×.
 *
 * Labels here are switcher names — screens, inputs, memories — so accents are
 * folded (`CAMÉRA` → `CAMERA`) and anything else with no glyph is a small
 * square. The emoji folding ec50-panel does for Companion's buttons is left
 * out: nothing this app draws on a key is an emoji.
 */

import { CELL_W, CELL_H, CELL_STRIDE, CELL_SIZE } from './ec-panel.js';

export const GLYPH_H = 8;
const GAP = 1;

const GLYPHS = new Map([
  [" ", [0x00, 0x00, 0x00, 0x00, 0x00]],
  ["!", [0x00, 0x00, 0x5F, 0x00, 0x00]],
  ["\"", [0x00, 0x07, 0x00, 0x07, 0x00]],
  ["#", [0x14, 0x7F, 0x14, 0x7F, 0x14]],
  ["$", [0x24, 0x2A, 0x7F, 0x2A, 0x12]],
  ["%", [0x23, 0x13, 0x08, 0x64, 0x62]],
  ["&", [0x36, 0x49, 0x55, 0x22, 0x50]],
  ["'", [0x00, 0x05, 0x03, 0x00, 0x00]],
  ["(", [0x00, 0x1C, 0x22, 0x41, 0x00]],
  [")", [0x00, 0x41, 0x22, 0x1C, 0x00]],
  ["*", [0x14, 0x08, 0x3E, 0x08, 0x14]],
  ["+", [0x08, 0x08, 0x3E, 0x08, 0x08]],
  [",", [0x00, 0x50, 0x30, 0x00, 0x00]],
  ["-", [0x08, 0x08, 0x08, 0x08, 0x08]],
  [".", [0x00, 0x60, 0x60, 0x00, 0x00]],
  ["/", [0x20, 0x10, 0x08, 0x04, 0x02]],
  ["0", [0x3E, 0x51, 0x49, 0x45, 0x3E]],
  ["1", [0x00, 0x42, 0x7F, 0x40, 0x00]],
  ["2", [0x42, 0x61, 0x51, 0x49, 0x46]],
  ["3", [0x21, 0x41, 0x45, 0x4B, 0x31]],
  ["4", [0x18, 0x14, 0x12, 0x7F, 0x10]],
  ["5", [0x27, 0x45, 0x45, 0x45, 0x39]],
  ["6", [0x3C, 0x4A, 0x49, 0x49, 0x30]],
  ["7", [0x01, 0x71, 0x09, 0x05, 0x03]],
  ["8", [0x36, 0x49, 0x49, 0x49, 0x36]],
  ["9", [0x06, 0x49, 0x49, 0x29, 0x1E]],
  [":", [0x00, 0x36, 0x36, 0x00, 0x00]],
  [";", [0x00, 0x56, 0x36, 0x00, 0x00]],
  ["<", [0x00, 0x08, 0x14, 0x22, 0x41]],
  ["=", [0x14, 0x14, 0x14, 0x14, 0x14]],
  [">", [0x41, 0x22, 0x14, 0x08, 0x00]],
  ["?", [0x02, 0x01, 0x51, 0x09, 0x06]],
  ["@", [0x32, 0x49, 0x79, 0x41, 0x3E]],
  ["A", [0x7E, 0x11, 0x11, 0x11, 0x7E]],
  ["B", [0x7F, 0x49, 0x49, 0x49, 0x36]],
  ["C", [0x3E, 0x41, 0x41, 0x41, 0x22]],
  ["D", [0x7F, 0x41, 0x41, 0x22, 0x1C]],
  ["E", [0x7F, 0x49, 0x49, 0x49, 0x41]],
  ["F", [0x7F, 0x09, 0x09, 0x09, 0x01]],
  ["G", [0x3E, 0x41, 0x49, 0x49, 0x7A]],
  ["H", [0x7F, 0x08, 0x08, 0x08, 0x7F]],
  ["I", [0x00, 0x41, 0x7F, 0x41, 0x00]],
  ["J", [0x20, 0x40, 0x41, 0x3F, 0x01]],
  ["K", [0x7F, 0x08, 0x14, 0x22, 0x41]],
  ["L", [0x7F, 0x40, 0x40, 0x40, 0x40]],
  ["M", [0x7F, 0x02, 0x0C, 0x02, 0x7F]],
  ["N", [0x7F, 0x04, 0x08, 0x10, 0x7F]],
  ["O", [0x3E, 0x41, 0x41, 0x41, 0x3E]],
  ["P", [0x7F, 0x09, 0x09, 0x09, 0x06]],
  ["Q", [0x3E, 0x41, 0x51, 0x21, 0x5E]],
  ["R", [0x7F, 0x09, 0x19, 0x29, 0x46]],
  ["S", [0x46, 0x49, 0x49, 0x49, 0x31]],
  ["T", [0x01, 0x01, 0x7F, 0x01, 0x01]],
  ["U", [0x3F, 0x40, 0x40, 0x40, 0x3F]],
  ["V", [0x1F, 0x20, 0x40, 0x20, 0x1F]],
  ["W", [0x3F, 0x40, 0x38, 0x40, 0x3F]],
  ["X", [0x63, 0x14, 0x08, 0x14, 0x63]],
  ["Y", [0x07, 0x08, 0x70, 0x08, 0x07]],
  ["Z", [0x61, 0x51, 0x49, 0x45, 0x43]],
  ["[", [0x00, 0x7F, 0x41, 0x41, 0x00]],
  ["]", [0x00, 0x41, 0x41, 0x7F, 0x00]],
  ["^", [0x04, 0x02, 0x01, 0x02, 0x04]],
  ["_", [0x40, 0x40, 0x40, 0x40, 0x40]],
  ["`", [0x00, 0x01, 0x02, 0x04, 0x00]],
  ["a", [0x20, 0x54, 0x54, 0x54, 0x78]],
  ["b", [0x7F, 0x48, 0x44, 0x44, 0x38]],
  ["c", [0x38, 0x44, 0x44, 0x44, 0x20]],
  ["d", [0x38, 0x44, 0x44, 0x48, 0x7F]],
  ["e", [0x38, 0x54, 0x54, 0x54, 0x18]],
  ["f", [0x08, 0x7E, 0x09, 0x01, 0x02]],
  ["g", [0x18, 0xA4, 0xA4, 0xA4, 0x7C]],
  ["h", [0x7F, 0x08, 0x04, 0x04, 0x78]],
  ["i", [0x00, 0x44, 0x7D, 0x40, 0x00]],
  ["j", [0x40, 0x80, 0x84, 0x7D, 0x00]],
  ["k", [0x7F, 0x10, 0x28, 0x44, 0x00]],
  ["l", [0x00, 0x41, 0x7F, 0x40, 0x00]],
  ["m", [0x7C, 0x04, 0x18, 0x04, 0x78]],
  ["n", [0x7C, 0x08, 0x04, 0x04, 0x78]],
  ["o", [0x38, 0x44, 0x44, 0x44, 0x38]],
  ["p", [0xFC, 0x24, 0x24, 0x24, 0x18]],
  ["q", [0x18, 0x24, 0x24, 0x24, 0xFC]],
  ["r", [0x7C, 0x08, 0x04, 0x04, 0x08]],
  ["s", [0x48, 0x54, 0x54, 0x54, 0x20]],
  ["t", [0x04, 0x3F, 0x44, 0x40, 0x20]],
  ["u", [0x3C, 0x40, 0x40, 0x20, 0x7C]],
  ["v", [0x1C, 0x20, 0x40, 0x20, 0x1C]],
  ["w", [0x3C, 0x40, 0x30, 0x40, 0x3C]],
  ["x", [0x44, 0x28, 0x10, 0x28, 0x44]],
  ["y", [0x1C, 0xA0, 0xA0, 0xA0, 0x7C]],
  ["z", [0x44, 0x64, 0x54, 0x4C, 0x44]],
  ["{", [0x00, 0x08, 0x36, 0x41, 0x00]],
  ["|", [0x00, 0x00, 0x7F, 0x00, 0x00]],
  ["}", [0x00, 0x41, 0x36, 0x08, 0x00]],
  ["~", [0x08, 0x04, 0x08, 0x10, 0x08]],
  ["°", [0x00, 0x07, 0x05, 0x07, 0x00]],
  ["·", [0x00, 0x00, 0x18, 0x00, 0x00]],
  ["•", [0x00, 0x1C, 0x1C, 0x1C, 0x00]],
  ["£", [0x48, 0x7E, 0x49, 0x41, 0x42]],
  ["€", [0x14, 0x3E, 0x55, 0x41, 0x22]],
  ["¢", [0x18, 0x24, 0x7E, 0x24, 0x12]],
  ["¥", [0x15, 0x16, 0x7C, 0x16, 0x15]],
  ["±", [0x48, 0x48, 0x5E, 0x48, 0x48]],
  ["←", [0x08, 0x1C, 0x2A, 0x08, 0x08]],
  ["→", [0x08, 0x08, 0x2A, 0x1C, 0x08]],
  ["↑", [0x04, 0x02, 0x7F, 0x02, 0x04]],
  ["↓", [0x10, 0x20, 0x7F, 0x20, 0x10]],
  ["\\", [0x02, 0x04, 0x08, 0x10, 0x20]],
  ["▪", [0x00, 0x3E, 0x3E, 0x3E, 0x00]],
]);

const FALLBACK = '▪';
const ALIASES = new Map([
  ['‘', "'"], ['’', "'"], ['“', '"'], ['”', '"'], ['–', '-'], ['—', '-'], ['…', '.'], [' ', ' '],
  ['×', 'x'], ['÷', '/'], ['−', '-'], ['▲', '↑'], ['▼', '↓'], ['◀', '←'], ['▶', '→'],
]);

/** Fold text down to characters the font can draw. */
export function normalise(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (GLYPHS.has(ch)) { out += ch; continue; }
    if (ALIASES.has(ch)) { out += ALIASES.get(ch); continue; }
    const stripped = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    out += stripped && [...stripped].every((c) => GLYPHS.has(c)) ? stripped : FALLBACK;
  }
  return out;
}

const glyph = (ch) => GLYPHS.get(ch) || GLYPHS.get(FALLBACK);

export function textWidth(text, scale) {
  const chars = [...text];
  if (!chars.length) return 0;
  return (chars.reduce((w, ch) => w + glyph(ch).length + GAP, 0) - GAP) * scale;
}

/**
 * Greedy word wrap, breaking a word only when it cannot fit a line alone.
 * `broke` says it had to, so `layout` can try a smaller size first.
 */
function wrap(line, width, scale, broke = { any: false }) {
  if (textWidth(line, scale) <= width) return [line];
  const lines = [];
  let cur = '';
  for (let word of line.split(' ')) {
    const trial = cur ? `${cur} ${word}` : word;
    if (textWidth(trial, scale) <= width) { cur = trial; continue; }
    if (cur) { lines.push(cur); cur = ''; }
    while (word && textWidth(word, scale) > width) {
      broke.any = true;
      let n = [...word].length;
      while (n > 1 && textWidth([...word].slice(0, n).join(''), scale) > width) n--;
      lines.push([...word].slice(0, n).join(''));
      word = [...word].slice(n).join('');
    }
    cur = word;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

/* The sizes an EC cell tries, largest first. */
export const SCALES = Object.freeze([3, 2, 1]);

/**
 * The lines, scale and leading a label is drawn at. Explicit newlines split;
 * leading is tried at the scale and then at none, because two lines at 2×
 * need all 32 rows. A label too long for four lines at 1× is cut. `scales`
 * are the sizes to try, largest first; one need not be whole — a 72-pixel key
 * fits five characters a line at 2× and seven at 1.5×.
 */
export function layout(text, width = CELL_W, height = CELL_H, scales = SCALES) {
  const raw = normalise(text).split(/\r\n|\r|\n|\\n/);
  const smallest = scales[scales.length - 1];
  let last = null;
  for (const s of scales) {
    const broke = { any: false };
    const lines = raw.flatMap((l) => wrap(l, width, s, broke));
    if (broke.any && s > smallest) { last = { lines, scale: s }; continue; }
    for (const lead of [s, 0]) {
      if (lines.length * GLYPH_H * s + lead * (lines.length - 1) <= height) return { lines, scale: s, lead };
    }
    last = { lines, scale: s };
  }
  return { lines: last.lines.slice(0, Math.max(1, Math.floor(height / (GLYPH_H * last.scale)))), scale: last.scale, lead: 0 };
}

/**
 * Draw a label into any box, `set(x, y)` once per lit pixel with (0, 0) the
 * box's top left: laid out as `layout` says, each line centred and the block
 * centred. The EC cell below is one box; a U5 mini's 72 × 72 key
 * (`plugins/pixelhue/grid.js`) is another.
 */
export function paintText(text, width, height, set, scales = SCALES) {
  const { lines, scale, lead } = layout(text, width, height, scales);
  const step = GLYPH_H * scale + lead;
  const block = lines.length * GLYPH_H * scale + lead * (lines.length - 1);
  const top = Math.floor((height - block) / 2);
  /* A glyph pixel covers [floor(at), floor(at + scale)) each way: exactly the
     old square at a whole scale, nearest-neighbour at a fractional one. */
  const fill = (x0, y0) => {
    for (let x = Math.floor(x0); x < Math.floor(x0 + scale); x++) {
      for (let y = Math.floor(y0); y < Math.floor(y0 + scale); y++) set(x, y);
    }
  };
  lines.forEach((line, n) => {
    let x = Math.floor((width - textWidth(line, scale)) / 2);
    const base = top + n * step;
    for (const ch of line) {
      const cols = glyph(ch);
      cols.forEach((bits, c) => {
        for (let r = 0; r < GLYPH_H; r++) if (bits & (1 << r)) fill(x + c * scale, base + r * scale);
      });
      x += (cols.length + GAP) * scale;
    }
  });
}

/**
 * A label as a cell image: 256 bytes, 64 × 32, 1 bpp, bit 0 the leftmost
 * pixel, NOT skewed (`ec-panel.js`'s `placeCell` does that). `invert` draws it light
 * on dark the other way round, for a key that is lit as selected.
 */
export function render(text, { invert = false } = {}) {
  const img = new Uint8Array(CELL_SIZE);
  paintText(text, CELL_W, CELL_H, (x, y) => {
    if (x < 0 || x >= CELL_W || y < 0 || y >= CELL_H) return;
    img[y * CELL_STRIDE + (x >> 3)] |= 1 << (x & 7);
  });
  if (invert) for (let i = 0; i < img.length; i++) img[i] ^= 0xff;
  return img;
}

/** A cell image as text, `#` for a lit pixel — for tests and for eyeballing a label. */
export function ascii(img) {
  const rows = [];
  for (let y = 0; y < CELL_H; y++) {
    let row = '';
    for (let x = 0; x < CELL_W; x++) row += img[y * CELL_STRIDE + (x >> 3)] & (1 << (x & 7)) ? '#' : '.';
    rows.push(row);
  }
  return rows;
}

/*
 * Ported from qubered/ec50-panel (https://github.com/qubered/ec50-panel), which
 * carries this notice:
 *
 * MIT License
 *
 * Copyright (c) 2026 Jayden Nawotka
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
