/*
 * The Barco EC-30 / EC-40 / EC-50 control surface, as bytes.  ** PREVIEW **
 *
 * No I/O, so it lives in `core/`: the device host's driver
 * (`devices/modules/barco-ec/driver.js`) moves these bytes through an FTDI chip
 * (`devices/transports/ftdi.js`), the plugin (`plugins/barco-ec/`) reads the
 * key table to give the keys a meaning, and the tests run both against a
 * pretend panel (`test/helpers/fake-ec-panel.js`).
 *
 * ## What the panel is
 *
 * The EC-30, EC-40 and EC-50 have no computer in them. Each is a USB device,
 * `0600:0336` "Show Console Board" (vendor 0x0600 is Barco Display Systems), for
 * whatever machine runs Barco's Event Master Toolset: an FT232H in MPSSE mode
 * clocking SPI at 15 MHz into a CPLD. The CPLD does nothing on its own. The host
 * reads one register for the key queue and the T-bar, and writes every key
 * label, backlight and lamp.
 *
 * ## Where this came from
 *
 * The protocol is qubered/ec50-panel's (MIT, Jayden Nawotka, 2026 — see
 * ATTRIBUTIONS.md), reverse engineered from USB captures of the Toolset and
 * proved on a real EC-50 under Windows; this is a port of its `protocol.py` and
 * the low-level half of `panel.py`. The button table below was generated from
 * the Toolset's own `showConsoleMap.csv`, which is identical in Event Master
 * 9.2.68800 and 10.0.3.3021 on this Mac and agrees with ec50-panel's entry for
 * entry; `test/barco-ec.test.js` compares the two whenever a Toolset is
 * installed.
 *
 * ⚠️ Nothing here has met a panel. The EC-30 and EC-40 are inferred to speak
 * the same protocol because the Toolset drives all three with one USB id, one
 * button map and one firmware image; nobody has said so from a desk.
 */

export const VENDOR_ID = 0x0600;
export const PRODUCT_ID = 0x0336;
/** What D2XX reports for the board: the EEPROM string, or the Windows PnP name. */
export const PRODUCT_STRINGS = Object.freeze(['ec show board', 'show console']);

/* ------------------------------------------------------------------ MPSSE */

/* Taken verbatim from captures of the Toolset (ec50-panel `panel.py`):
   div-by-5 off, adaptive clocking off, 3-phase off, divisor 1 (15 MHz),
   loopback off; ADBUS 0x18 out 0x1B; open-drain and ACBUS setup. */
export const MPSSE_SETUP = Object.freeze([0x8a, 0x97, 0x8d, 0x86, 0x01, 0x00, 0x85]);
export const PINS_IDLE = Object.freeze([0x80, 0x18, 0x1b]);
export const PINS_EXTRA = Object.freeze([0x9e, 0x00, 0x04, 0x82, 0x04, 0x04]);
/* Chip select is ADBUS3, active low, each edge repeated five times as a setup delay. */
const CS_LOW = [0x80, 0x90, 0x1b];
const CS_HIGH = [0x80, 0x98, 0x1b];
export const CS_ASSERT = Object.freeze([].concat(CS_LOW, CS_LOW, CS_LOW, CS_LOW, CS_LOW));
export const CS_RELEASE = Object.freeze([].concat(CS_HIGH, CS_HIGH, CS_HIGH, CS_HIGH, CS_HIGH));
export const SEND_IMMEDIATE = 0x87;

/** MPSSE opcodes this uses: clock bytes out, out-and-in, in (MSB first, -ve edge out). */
export const OP = Object.freeze({ OUT: 0x11, INOUT: 0x31, IN: 0x20 });

/** Everything sent once after the chip is in MPSSE mode. */
export const SETUP_BYTES = Object.freeze([...MPSSE_SETUP, ...PINS_IDLE, ...PINS_EXTRA]);

/** One SPI write transaction, wrapped: CS low, clock the payload out, CS high. */
export function frame(payload) {
  const n = payload.length - 1;
  const out = new Uint8Array(CS_ASSERT.length + 3 + payload.length + CS_RELEASE.length);
  let at = 0;
  out.set(CS_ASSERT, at); at += CS_ASSERT.length;
  out.set([OP.OUT, n & 0xff, (n >> 8) & 0xff], at); at += 3;
  out.set(payload, at); at += payload.length;
  out.set(CS_RELEASE, at);
  return out;
}

/* ------------------------------------------------------------ registers */

/**
 * A register transaction on the SPI side:
 *
 *     <addr_hi> <addr_lo> <flags> <len-1> [data …] 0xAA 0xBB
 *
 * `flags` bit 7 is read. Data is little-endian.
 */
const TAIL = [0xaa, 0xbb];
const READ = 0x80;

export const REG = Object.freeze({
  FRAMEBUFFER: 0x0000,
  /** Byte 6 of the reply is the key queue, bytes 5:4 the T-bar. */
  KEYS: 0x3810,
  /**
   * The latch, a mask: 1 latches the lamp registers, 2 the framebuffer.
   * ⚠️ Nothing written takes effect until it is latched, and a write that is
   * not is accepted and silently ignored — the easiest mistake with this panel.
   */
  COMMIT: 0x3828,
});
export const COMMIT = Object.freeze({ LEDS: 1, LCD: 2 });
export const LED_REGS = Object.freeze([0x3950, 0x3954, 0x3958, 0x395c, 0x3960, 0x3964]);

/* The LCD controllers' setup, issued once by the Toolset at startup. The panel
   keeps it across a host disconnect, so it only matters after a power cycle,
   and sending it on every open costs seven short writes. */
export const INIT_REGS = Object.freeze([
  [0x3938, 0x0000003f],
  [0x3920, 0x00760131],
  [0x3924, 0x00760131],
  [0x3928, 0x00760131],
  [0x392c, 0x00180131],
  [0x3930, 0x00af0131],
  [0x3934, 0x00af0131],
]);

/** A 32-bit register write, framed for MPSSE. */
export function writeReg(addr, value) {
  const v = value >>> 0;
  return frame([
    (addr >> 8) & 0xff, addr & 0xff, 0x00, 0x03,
    v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff,
    ...TAIL,
  ]);
}

/**
 * A register read, framed for MPSSE: the request is clocked out while the
 * reply's head is clocked in, then `count` more bytes are clocked in, and
 * SEND IMMEDIATE flushes them back. Answers the bytes and how many to read.
 *
 * ⚠️ **Replies lag one transaction.** The first read after switching address
 * answers with the previous register's data, so the driver polls one address
 * and throws its first reply away.
 */
export function readReg(addr, count = 4) {
  const payload = [(addr >> 8) & 0xff, addr & 0xff, READ, count - 1, ...TAIL];
  const bytes = Uint8Array.from([
    ...CS_ASSERT,
    OP.INOUT, payload.length - 1, 0x00, ...payload,
    OP.IN, count - 1, 0x00,
    ...CS_RELEASE,
    SEND_IMMEDIATE,
  ]);
  return { bytes, replyLength: payload.length + count };
}

/* -------------------------------------------------------------- input */

export const KEY_BYTE = 6;
/** The queue is empty. Otherwise `0x80 | index` is a press and `index` a release. */
export const KEY_IDLE = 0xff;
export const TBAR_LO = 4;
export const TBAR_HI = 5;
/* Measured across full-travel runs on ec50-panel's EC-50. */
export const TBAR_MIN = 0x0040;
export const TBAR_MAX = 0xfc10;

/** One reply from `REG.KEYS`: the key event in it, if any, and the T-bar. */
export function parseKeys(reply) {
  if (!reply || reply.length <= KEY_BYTE) return null;
  const code = reply[KEY_BYTE];
  const tbar = (reply[TBAR_HI] << 8) | reply[TBAR_LO];
  const key = code === KEY_IDLE ? null : { index: code & 0x7f, pressed: (code & 0x80) !== 0 };
  return { key, tbar };
}

/** A raw T-bar reading as 0…1, on a fixed scale that needs no calibration. */
export function tbarFraction(raw) {
  const f = (raw - TBAR_MIN) / (TBAR_MAX - TBAR_MIN);
  return Math.max(0, Math.min(1, f));
}

/* ------------------------------------------------------ reports, to the app */

/**
 * What the driver sends the app as a `report`, a few bytes each, so the device
 * host's channel carries this panel exactly as it carries the Speed Editor's:
 *
 *     [0x01, index, 1|0]       a key pressed or released
 *     [0x02, lo, hi]           the T-bar moved; raw 16-bit position
 */
export const REPORT = Object.freeze({ KEY: 0x01, TBAR: 0x02 });

export function readReport(bytes) {
  if (!bytes || !bytes.length) return null;
  if (bytes[0] === REPORT.KEY && bytes.length >= 3) return { type: 'key', index: bytes[1], pressed: bytes[2] === 1 };
  if (bytes[0] === REPORT.TBAR && bytes.length >= 3) return { type: 'tbar', raw: bytes[1] | (bytes[2] << 8) };
  return null;
}

/* --------------------------------------------------------- framebuffer */

export const CELL_W = 64;
export const CELL_H = 32;
/** 8 bytes a scanline. ⚠️ Bit 0 of each byte is the LEFTMOST pixel, not bit 7. */
export const CELL_STRIDE = CELL_W / 8;
export const CELL_SIZE = CELL_STRIDE * CELL_H;
export const NUM_CELLS = 45;

/* The right half is driven one row lower than the buffer says — two 32 px
   driver chips with a one-row addressing skew. The Toolset stores content at
   x ≥ 32 one row higher; without that, text across x = 32 shows a 1 px step. */
export const SKEW_X = 32;
export const SKEW_ROWS = 1;

/**
 * The framebuffer is one transaction of 11,962 bytes at address 0, and its
 * 4-byte header **overlays cell 0's first scanline**: zeroing it makes the
 * panel discard the whole write. `00 00 6E B3` is the captured header — a
 * 14-bit length (0x2EB3 = 11,955, the data less one) under flag 0x40.
 */
export const FB_HEADER = Object.freeze([0x00, 0x00, 0x6e, 0xb3]);
export const HEADER_LEN = FB_HEADER.length;
export const COLOUR_BASE = 11524;   // 45 × 4; only byte 3 of each entry is read
export const COLOUR2_BASE = 11780;  // 45 × 4; uniformly 0xFF, purpose unknown
export const PAYLOAD_LEN = 11962;

/* -------------------------------------------------------------- colour */

/**
 * r, g, b each 0–3, as the byte selecting that backlight. `RRGGBBII`: the low
 * two bits must both be set or the panel ignores the colour and shows white.
 */
export const colour = (r, g, b) => ((r & 3) << 6) | ((g & 3) << 4) | ((b & 3) << 2) | 3;

export const COLOUR = Object.freeze({
  OFF: colour(0, 0, 0),       // 0x03
  DIM: colour(1, 1, 1),       // 0x57 — the Toolset's blank key
  WHITE: colour(3, 3, 3),     // 0xFF — its labelled key
  RED: colour(3, 0, 0),
  GREEN: colour(0, 3, 0),
  BLUE: colour(0, 0, 3),
  YELLOW: colour(3, 3, 0),
  CYAN: colour(0, 3, 3),
  MAGENTA: colour(3, 0, 3),
  ORANGE: colour(3, 1, 0),
  AMBER: colour(3, 2, 0),
});

/** The framebuffer as the Toolset leaves it blank: header, dim backlights, terminator. */
export function newBuffer() {
  const buf = new Uint8Array(PAYLOAD_LEN);
  buf.set(FB_HEADER, 0);
  for (let cell = 0; cell < NUM_CELLS; cell++) {
    buf.fill(COLOUR.DIM, COLOUR_BASE + cell * 4, COLOUR_BASE + cell * 4 + 4);
    buf.fill(0xff, COLOUR2_BASE + cell * 4, COLOUR2_BASE + cell * 4 + 4);
  }
  buf.set(TAIL, PAYLOAD_LEN - 2);
  return buf;
}

/**
 * Put a 256-byte cell image (64 × 32, 1 bpp, LSB leftmost, NOT skewed) into
 * the framebuffer, skewing its right half the way the panel needs. The bytes
 * under the header are left alone, so cell 0 loses its top-left corner row.
 */
export function placeCell(buf, cell, image, skew = SKEW_ROWS) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= NUM_CELLS) throw new Error(`no LCD cell ${cell}`);
  if (!image || image.length !== CELL_SIZE) throw new Error(`a cell image is ${CELL_SIZE} bytes`);
  const out = new Uint8Array(image);
  if (skew) {
    const half = CELL_STRIDE / 2;
    for (let r = 0; r < CELL_H; r++) {
      const src = r + skew;
      const row = r * CELL_STRIDE;
      if (src < CELL_H) out.set(image.subarray(src * CELL_STRIDE + half, (src + 1) * CELL_STRIDE), row + half);
      else out.fill(0, row + half, row + CELL_STRIDE);
    }
  }
  const start = cell * CELL_SIZE;
  const keep = Math.max(0, HEADER_LEN - start);
  buf.set(out.subarray(keep), start + keep);
}

export function setColour(buf, cell, value) {
  buf.fill(value & 0xff, COLOUR_BASE + cell * 4, COLOUR_BASE + cell * 4 + 4);
}

/** The framebuffer's MPSSE frame. It goes out twice: the display is double buffered. */
export const framebufferFrame = (buf) => frame(buf);

/* --------------------------------------------------------------- lamps */

/** Two bits a key. Not independent enables: 3 is off as well, and there is no amber. */
export const LED = Object.freeze({ OFF: 0, RED: 1, GREEN: 2 });

/* ------------------------------------------------------------- buttons */

/**
 * Every control the panel has, from the Toolset's `showConsoleMap.csv`:
 * `[index, name, lamp register | null, lamp bit, LCD cell | -1, models]`.
 * The lamp bit is the CSV's byte shift plus its position shift. The last
 * column is the CSV's "console type": 0 every model, 1 EC-50 only, 2 EC-30
 * and EC-50, 3 EC-40 and EC-50 — a model does not renumber anything, it only
 * leaves keys out.
 */
const TABLE = [
  [0, 'DEST_0', 0x3950, 22, -1, 0],
  [1, 'DEST_1', 0x3950, 20, -1, 0],
  [2, 'DEST_2', 0x3950, 18, -1, 0],
  [3, 'DEST_3', 0x3950, 16, -1, 0],
  [4, 'DEST_4', 0x3950, 14, -1, 0],
  [5, 'DEST_5', 0x3950, 12, -1, 0],
  [6, 'DEST_6', 0x3950, 10, -1, 0],
  [7, 'DEST_7', 0x3950, 8, -1, 0],
  [8, 'DEST_8', 0x3950, 6, -1, 0],
  [9, 'DEST_9', 0x3950, 4, -1, 0],
  [10, 'DEST_10', 0x3950, 2, -1, 0],
  [11, 'DEST_11', 0x3950, 0, 9, 0],
  [12, 'DEST_UP', null, -1, -1, 0],
  [13, 'DEST_DOWN', null, -1, -1, 0],
  [25, 'LAYER_UP', null, -1, -1, 0],
  [26, 'FREEZE_PGM', 0x3954, 10, -1, 0],
  [27, 'ARM', 0x3954, 8, -1, 0],
  [28, 'LAYER_TRANS', 0x3954, 6, -1, 0],
  [29, 'SHOW_CFG_0_1', 0x3954, 4, 13, 1],
  [30, 'SHOW_CFG_0_0', 0x3954, 2, 12, 1],
  [31, 'SHOW_CFG_1_1', 0x3954, 0, 16, 2],
  [32, 'LAYER_0', 0x3958, 30, -1, 0],
  [33, 'LAYER_1', 0x3958, 28, -1, 0],
  [34, 'LAYER_2', 0x3958, 26, -1, 0],
  [35, 'LAYER_3', 0x3958, 24, -1, 0],
  [36, 'LAYER_4', 0x3958, 22, -1, 0],
  [37, 'LAYER_5', 0x3958, 20, -1, 0],
  [38, 'LAYER_6', 0x3958, 18, -1, 0],
  [39, 'LAYER_7', 0x3958, 16, -1, 0],
  [40, 'LAYER_8', 0x3958, 14, 10, 0],
  [41, 'LAYER_DOWN', null, -1, -1, 0],
  [42, 'FREEZE_PVW', 0x3958, 10, -1, 0],
  [43, 'MATCH', 0x3958, 8, -1, 0],
  [44, 'LAYER_CUT', 0x3958, 6, -1, 0],
  [48, 'ASSIGN_0_0', 0x395C, 30, 36, 3],
  [49, 'ASSIGN_0_1', 0x395C, 28, 37, 3],
  [50, 'ASSIGN_0_2', 0x395C, 26, 2, 3],
  [51, 'ASSIGN_0_3', 0x395C, 24, 0, 3],
  [52, 'ASSIGN_0_4', 0x395C, 22, 1, 3],
  [53, 'ASSIGN_0_5', 0x395C, 20, 20, 3],
  [54, 'ASSIGN_0_6', 0x395C, 18, 18, 3],
  [55, 'ASSIGN_0_7', 0x395C, 16, 19, 3],
  [56, 'ASSIGN_0_8', 0x395C, 14, 29, 3],
  [57, 'ASSIGN_0_9', 0x395C, 12, 27, 3],
  [58, 'ASSIGN_0_10', 0x395C, 10, 28, 3],
  [59, 'ASSIGN_0_11', 0x395C, 8, 38, 3],
  [60, 'ASSIGN_0_UP', null, -1, -1, 3],
  [61, 'ASSIGN_0_DOWN', null, -1, -1, 3],
  [62, 'ASSIGN_0_LABEL', 0x395C, 2, 11, 3],
  [63, 'SHOW_CFG_1_0', 0x395C, 0, 15, 2],
  [64, 'ASSIGN_1_0', 0x3960, 24, 39, 0],
  [65, 'ASSIGN_1_1', 0x3960, 26, 40, 0],
  [66, 'ASSIGN_1_2', 0x3960, 28, 5, 0],
  [67, 'ASSIGN_1_3', 0x3960, 30, 3, 0],
  [68, 'ASSIGN_1_4', 0x3960, 16, 4, 0],
  [69, 'ASSIGN_1_5', 0x3960, 18, 23, 0],
  [70, 'ASSIGN_1_6', 0x3960, 20, 21, 0],
  [71, 'ASSIGN_1_7', 0x3960, 22, 22, 0],
  [72, 'ASSIGN_1_8', 0x3960, 8, 32, 0],
  [73, 'ASSIGN_1_9', 0x3960, 10, 30, 0],
  [74, 'ASSIGN_1_10', 0x3960, 12, 31, 0],
  [75, 'ASSIGN_1_11', 0x3960, 14, 41, 0],
  [76, 'ASSIGN_1_UP', null, -1, -1, 0],
  [77, 'ASSIGN_1_DOWN', null, -1, -1, 0],
  [78, 'ASSIGN_1_LABEL', 0x3960, 2, 14, 0],
  [79, 'ALL_TRANS', 0x3960, 0, -1, 0],
  [80, 'ASSIGN_2_0', 0x3964, 24, 42, 0],
  [81, 'ASSIGN_2_1', 0x3964, 26, 43, 0],
  [82, 'ASSIGN_2_2', 0x3964, 28, 8, 0],
  [83, 'ASSIGN_2_3', 0x3964, 30, 6, 0],
  [84, 'ASSIGN_2_4', 0x3964, 16, 7, 0],
  [85, 'ASSIGN_2_5', 0x3964, 18, 26, 0],
  [86, 'ASSIGN_2_6', 0x3964, 20, 24, 0],
  [87, 'ASSIGN_2_7', 0x3964, 22, 25, 0],
  [88, 'ASSIGN_2_8', 0x3964, 8, 35, 0],
  [89, 'ASSIGN_2_9', 0x3964, 10, 33, 0],
  [90, 'ASSIGN_2_10', 0x3964, 12, 34, 0],
  [91, 'ASSIGN_2_11', 0x3964, 14, 44, 0],
  [92, 'ASSIGN_2_UP', null, -1, -1, 0],
  [93, 'ASSIGN_2_DOWN', null, -1, -1, 0],
  [94, 'ASSIGN_2_LABEL', 0x3964, 2, 17, 0],
  [95, 'CUT', 0x3964, 0, -1, 0],
];

export const BUTTONS = Object.freeze(TABLE.map(([index, name, reg, bit, lcd, type]) => Object.freeze({
  index, name, reg, bit, lcd, type,
})));
export const BUTTON_BY_INDEX = new Map(BUTTONS.map((b) => [b.index, b]));
export const BUTTON_BY_NAME = new Map(BUTTONS.map((b) => [b.name, b]));

/** Which "console type" rows each model has. */
export const MODELS = Object.freeze({
  'ec-50': Object.freeze({ id: 'ec-50', name: 'EC-50', types: [0, 1, 2, 3] }),
  'ec-40': Object.freeze({ id: 'ec-40', name: 'EC-40', types: [0, 3] }),
  'ec-30': Object.freeze({ id: 'ec-30', name: 'EC-30', types: [0, 2] }),
});

export const hasButton = (model, b) => !!b && (MODELS[model] || MODELS['ec-50']).types.includes(b.type);

/**
 * The lamp registers' values for a set of lamp states, `index → LED.*`. Keys
 * with no lamp are skipped; everything not named is off.
 */
export function ledRegisters(states) {
  const regs = new Map(LED_REGS.map((r) => [r, 0]));
  for (const [index, state] of states) {
    const b = BUTTON_BY_INDEX.get(Number(index));
    if (!b || b.reg === null) continue;
    regs.set(b.reg, (regs.get(b.reg) & ~(0x3 << b.bit)) | ((state & 0x3) << b.bit));
  }
  for (const [r, v] of regs) regs.set(r, v >>> 0);
  return regs;
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
