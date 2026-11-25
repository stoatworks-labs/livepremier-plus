/*
 * The Native Instruments Maschine MK3's bytes.  ** PREVIEW **
 *
 * No I/O: the device host (`devices/modules/maschine-mk3/`) moves these bytes
 * and the plugin (`plugins/maschine/`) reads them, from this one file, as the
 * X-keys and ATEM Micro Panel do theirs.
 *
 * ## Where it comes from
 *
 * The layout is OpenAV Ctlra's `ni_maschine_mk3.c` (BSD-3-Clause, Harry van
 * Haaren, 2017; ATTRIBUTIONS.md), rewritten, not copied. Some facts were
 * checked against autotel's maschine-mk3-linux device profile, which is GPL;
 * only facts were taken from it, never code. Nothing in this file has met a
 * real MK3. The spike it came from (`~/dev/maschine-spike`, 2026-11-25) drove
 * a virtual panel and a real Resolume, never a panel. **Never edit it from a
 * photo of a panel**; a real one that disagrees goes in NOTES.md first.
 *
 * ## USB
 *
 * 17cc:1600. Interface 4 is HID: input report 0x01 carries the controls and
 * 0x02 the pads; output report 0x80 carries 62 LED slots and 0x81 carries 41.
 * Interface 5 is vendor class 0xbd, with bulk OUT endpoint 0x04 taking the
 * pixels for both 480 × 272 screens. HID goes through node-hid; the screens
 * need libusb (`usb`), and a host without it still has keys and lamps.
 *
 * ## Controls report (0x01, 42 bytes with the id)
 *
 * ```text
 *   [1..10]   80 button bits, bit n at byte 1 + (n >> 3), mask 1 << (n & 7)
 *   [11]      main encoder, low nibble, a 4-bit counter that wraps
 *   [12..27]  8 knobs, u16 LE each, an absolute 0..999 that wraps (endless)
 *   [28..41]  7 analog fields, u16 LE: 0 a free-running counter, 1 the touch
 *             strip (0 = no finger, up to 1024), 4.. the pedal jack
 * ```
 *
 * ## Pads report (0x02, 64 bytes with the id)
 *
 * Up to 21 triplets: pad index, then (event << 4 | pressure >> 8), then
 * pressure & 0xff. Pressure is 12 bits. Event 0 is press, 1 note on, 2 press
 * off, 3 note off, 4 aftertouch. The list ends at the first all-zero triplet
 * after the first slot. Pad 0 is top left and 15 bottom right; Maschine's own
 * software numbers them from the bottom left, and so does this (`padNumber`).
 *
 * ## LEDs
 *
 * One flat list of 103 slots: 0..61 go in report 0x80, then 62..86 are the
 * touch strip and 87..102 the pads, in report 0x81. A colour slot is
 * (palette << 2) | level, palette 1..17 (17 white) and level 0..3. A mono slot
 * is a brightness, 0..127.
 *
 * ## Screens (bulk, endpoint 0x04)
 *
 * ```text
 *   84 00 SS 60 00 00 00 00   header; SS is the screen, 0 left and 1 right
 *   xxxx yyyy wwww hhhh       target rect, u16 BE
 *   then 4-byte commands [op, 0, n >> 8, n & 0xff], n counting pixel PAIRS:
 *     00  n pairs of RGB565 BE pixels follow
 *     01  repeat one pair (4 bytes follow) n times
 *     02  skip n pairs
 *     03  blit
 *     40  end of frame
 * ```
 */

export const VENDOR_ID = 0x17cc;
export const PRODUCT_ID = 0x1600;
export const PRODUCT_NAME = 'Maschine MK3';
export const HID_INTERFACE = 4;
export const SCREEN_INTERFACE = 5;
export const SCREEN_ENDPOINT = 0x04;

export const SCREEN_W = 480;
export const SCREEN_H = 272;
export const SCREENS = 2;

export const REPORT = Object.freeze({ CONTROLS: 0x01, PADS: 0x02, LEDS: 0x80, PAD_LEDS: 0x81 });
export const CONTROLS_BYTES = 42;
export const PADS_BYTES = 64;
export const LEDS_BANK0 = 62;
export const LEDS_BANK1 = 41;
export const LED_COUNT = LEDS_BANK0 + LEDS_BANK1;
export const STRIP_LED_BASE = 62;
export const STRIP_LEDS = 25;
export const PAD_LED_BASE = 87;
export const PADS = 16;
export const KNOBS = 8;
export const KNOB_RANGE = 1000;
export const PAD_MAX = 4095;
export const STRIP_MAX = 1024;

/**
 * Palette entries by name: where Ctlra's hue bucketing (`paletteOf`) puts
 * each colour. Unchecked against a panel; the levels are 0 (off) to 3.
 */
export const HUE = Object.freeze({
  RED: 1, ORANGE: 2, YELLOW: 3, GREEN: 6, CYAN: 9, BLUE: 11, PURPLE: 13, MAGENTA: 14, WHITE: 17,
});

/* A mono LED's brightness for each of the four levels a colour LED has, so
   the plugin speaks one language for both. 127 is the top; the steps are a
   guess until a panel is seen. */
export const MONO_LEVELS = Object.freeze([0, 0x10, 0x40, 0x7f]);

/*
 * Every button: its bit in the controls report, the LED slot that lights it
 * (null where none), and whether that LED takes a colour. Names are kebab
 * case and follow the panel's printing; `top-1`…`top-8` are the eight
 * buttons above the screens.
 */
const B = (name, bit, led = null, colour = false) => Object.freeze({ name, bit, led, colour });
export const BUTTONS = Object.freeze([
  B('encoder-push', 0),
  B('encoder-up', 2, 58, true),
  B('encoder-right', 3, 60, true),
  B('encoder-down', 4, 61, true),
  B('encoder-left', 5, 59, true),
  B('shift', 6, 44),
  B('top-8', 7, 19),
  ...'abcdefgh'.split('').map((g, i) => B(`group-${g}`, 8 + i, 29 + i, true)),
  B('notes', 16, 28), B('volume', 17, 20), B('swing', 18, 21), B('tempo', 19, 23),
  B('note-repeat', 20, 22), B('lock', 21, 24), B('pedal', 22),
  B('pad-mode', 24, 46), B('keyboard', 25, 47), B('chords', 26, 48), B('step', 27, 49),
  B('fixed-vel', 28, 45), B('scene', 29, 50), B('pattern', 30, 51), B('events', 31, 52),
  B('variation', 33, 53), B('duplicate', 34, 54), B('select', 35, 55), B('solo', 36, 56),
  B('mute', 37, 57), B('pitch', 38, 25), B('mod', 39, 26),
  B('perform', 40, 27), B('restart', 41, 37), B('erase', 42, 38), B('tap', 43, 39),
  B('follow', 44, 40), B('play', 45, 41), B('rec', 46, 42), B('stop', 47, 43),
  B('macro', 48, 11), B('settings', 49, 9), B('arrow-right', 50, 7), B('sampling', 51, 5, true),
  B('mixer', 52, 3), B('plugin', 53, 1),
  B('channel', 56, 0), B('arranger', 57, 2), B('browser', 58, 4), B('arrow-left', 59, 6),
  B('file', 60, 8), B('auto', 61, 10),
  ...[1, 2, 3, 4, 5, 6, 7].map((n) => B(`top-${n}`, 63 + n, 11 + n)),
  B('encoder-touch', 71),
  /* The knob touches run backwards: knob 1 is the top bit of byte 10. */
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => B(`knob-touch-${n}`, 80 - n)),
]);
export const BUTTON = new Map(BUTTONS.map((b) => [b.name, b]));

const u16le = (buf, i) => buf[i] | (buf[i + 1] << 8);

/** The shortest signed step from `was` to `now` on a counter that wraps at `modulus`. */
export function wrapDelta(now, was, modulus) {
  let d = (now - was) % modulus;
  if (d > modulus / 2) d -= modulus;
  if (d < -modulus / 2) d += modulus;
  return d;
}

/** A controls report (id first) as raw state: `{buttons: Uint8Array(80), encoder, knobs[8], analog[7]}`. */
export function parseControls(buf) {
  if (!buf || buf[0] !== REPORT.CONTROLS || buf.length < CONTROLS_BYTES) return null;
  const buttons = new Uint8Array(80);
  for (let n = 0; n < 80; n++) buttons[n] = (buf[1 + (n >> 3)] >> (n & 7)) & 1;
  const knobs = [];
  for (let i = 0; i < KNOBS; i++) knobs.push(u16le(buf, 12 + i * 2));
  const analog = [];
  for (let i = 0; i < 7; i++) analog.push(u16le(buf, 28 + i * 2));
  return { buttons, encoder: buf[11] & 0x0f, knobs, analog };
}

export const PAD_EVENTS = Object.freeze(['press', 'note-on', 'press-off', 'note-off', 'aftertouch']);

/** A pads report (id first) as `[{pad, event, pressure}]`; events this does not know are passed over. */
export function parsePads(buf) {
  if (!buf || buf[0] !== REPORT.PADS) return [];
  const out = [];
  for (let i = 1; i + 2 < buf.length; i += 3) {
    const pad = buf[i];
    const hi = buf[i + 1];
    const pressure = ((hi & 0x0f) << 8) | buf[i + 2];
    if (i > 1 && pad === 0 && hi === 0 && pressure === 0) break;
    const event = PAD_EVENTS[hi >> 4];
    if (event && pad < PADS) out.push({ pad, event, pressure });
  }
  return out;
}

/** A pad's number as Maschine prints it, 1 at the bottom left to 16 at the top right, from its index (0 top left). */
export const padNumber = (index) => (3 - (index >> 2)) * 4 + (index & 3) + 1;
/** The inverse: the report's index for pad number 1..16. */
export const padIndex = (number) => (3 - ((number - 1) >> 2)) * 4 + ((number - 1) & 3);

/**
 * Raw reports to events: button presses and releases, knob steps, the main
 * encoder's clicks, the strip, and pad hits. The first controls report only
 * records where everything is, because the knobs come up anywhere; a
 * decoder is made new for each connection.
 *
 * A pad is down from its first `press` or `note-on` until a `press-off` or
 * `note-off`, so a hit is one event whichever of the two a panel sends first.
 *
 * Events:
 *
 * ```text
 *   { type: 'button',  name, pressed }
 *   { type: 'knob',    index, delta }      delta in 1/1000 of the knob's wrap
 *   { type: 'encoder', delta }             clicks, signed
 *   { type: 'strip',   value }             0..1, or null when the finger lifts
 *   { type: 'pad',     index, number, pressed, pressure }
 * ```
 */
export class Mk3Decoder {
  constructor() {
    this.last = null;
    this.down = new Set();
  }

  decode(buf) {
    if (!buf || !buf.length) return [];
    if (buf[0] === REPORT.PADS) return this.#pads(buf);
    if (buf[0] === REPORT.CONTROLS) return this.#controls(buf);
    return [];
  }

  #controls(buf) {
    const s = parseControls(buf);
    if (!s) return [];
    const was = this.last;
    this.last = s;
    if (!was) return [];
    const out = [];
    for (const b of BUTTONS) {
      if (s.buttons[b.bit] !== was.buttons[b.bit]) out.push({ type: 'button', name: b.name, pressed: !!s.buttons[b.bit] });
    }
    for (let i = 0; i < KNOBS; i++) {
      const d = wrapDelta(s.knobs[i], was.knobs[i], KNOB_RANGE);
      if (d) out.push({ type: 'knob', index: i, delta: d });
    }
    const e = wrapDelta(s.encoder, was.encoder, 16);
    if (e) out.push({ type: 'encoder', delta: e });
    if (s.analog[1] !== was.analog[1]) {
      out.push({ type: 'strip', value: s.analog[1] ? Math.min(1, s.analog[1] / STRIP_MAX) : null });
    }
    return out;
  }

  #pads(buf) {
    const out = [];
    for (const { pad, event, pressure } of parsePads(buf)) {
      const on = event === 'press' || event === 'note-on';
      const off = event === 'press-off' || event === 'note-off';
      if (on && !this.down.has(pad)) {
        this.down.add(pad);
        out.push({ type: 'pad', index: pad, number: padNumber(pad), pressed: true, pressure });
      } else if (off && this.down.has(pad)) {
        this.down.delete(pad);
        out.push({ type: 'pad', index: pad, number: padNumber(pad), pressed: false, pressure: 0 });
      }
    }
    return out;
  }
}

/**
 * A controls report from a state, the inverse of `parseControls`. Only the
 * tests' pretend panel needs it: a real panel makes its own.
 * @param s.pressed  button names held down
 * @param s.knobs    8 raw knob positions, 0..999
 * @param s.encoder  the main encoder's 4-bit counter
 * @param s.strip    0 for no finger, else 1..1024
 */
export function buildControls({ pressed = [], knobs = [0, 0, 0, 0, 0, 0, 0, 0], encoder = 0, strip = 0, counter = 0 } = {}) {
  const buf = new Uint8Array(CONTROLS_BYTES);
  buf[0] = REPORT.CONTROLS;
  for (const name of pressed) {
    const b = BUTTON.get(name);
    if (b) buf[1 + (b.bit >> 3)] |= 1 << (b.bit & 7);
  }
  buf[11] = encoder & 0x0f;
  for (let i = 0; i < KNOBS; i++) {
    const v = (((knobs[i] ?? 0) % KNOB_RANGE) + KNOB_RANGE) % KNOB_RANGE;
    buf[12 + i * 2] = v & 0xff;
    buf[13 + i * 2] = v >> 8;
  }
  buf[28] = counter & 0xff; buf[29] = (counter >> 8) & 0xff;
  buf[30] = strip & 0xff; buf[31] = strip >> 8;
  return buf;
}

/** A pads report from `[{pad, event, pressure}]`, the inverse of `parsePads`. */
export function buildPads(hits) {
  const buf = new Uint8Array(PADS_BYTES);
  buf[0] = REPORT.PADS;
  hits.slice(0, 21).forEach(({ pad, event, pressure = 0 }, k) => {
    const e = Math.max(0, PAD_EVENTS.indexOf(event));
    buf[1 + k * 3] = pad;
    buf[2 + k * 3] = (e << 4) | ((pressure >> 8) & 0x0f);
    buf[3 + k * 3] = pressure & 0xff;
  });
  return buf;
}

/* ------------------------------------------------------------------ LEDs */

/** A colour LED's byte: `palette` 1..17 (17 white), `level` 0..3. */
export function colourLed(palette, level = 3) {
  if (!level || !palette) return 0;
  return ((palette & 0x1f) << 2) | (level & 3);
}

/** The palette entry nearest an RGB colour, after Ctlra's hue bucketing: 17 for greys, null for black. */
export function paletteOf([r, g, b]) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return null;
  if (max - min < 24) return HUE.WHITE;
  let h;
  if (max === r) h = ((g - b) / (max - min)) * 43;
  else if (max === g) h = 85 + ((b - r) / (max - min)) * 43;
  else h = 171 + ((r - g) / (max - min)) * 43;
  h = ((h % 256) + 256) % 256;
  return Math.floor(h / 16) + 1;
}

/** One light's byte for its slot: `{hue, level}` on a colour LED, the level's brightness on a mono one. */
function lightByte(light, colour) {
  if (!light || !light.level) return 0;
  const level = Math.max(0, Math.min(3, light.level | 0));
  return colour ? colourLed(light.hue ?? HUE.WHITE, level) : MONO_LEVELS[level];
}

/**
 * All 103 slots from what the plugin wants lit. Every light is `{hue, level}`
 * (level 0..3); a mono LED takes only the level.
 *
 * @param o.buttons  Map(button name → light); a name with no LED is passed over
 * @param o.pads     16 lights by pad index (0 top left), or null
 * @param o.strip    25 lights, left to right, or null
 */
export function ledSlots({ buttons = new Map(), pads = [], strip = [] } = {}) {
  const slots = new Uint8Array(LED_COUNT);
  for (const [name, light] of buttons) {
    const b = BUTTON.get(name);
    if (b && b.led !== null) slots[b.led] = lightByte(light, b.colour);
  }
  for (let i = 0; i < PADS; i++) slots[PAD_LED_BASE + i] = lightByte(pads[i], true);
  for (let i = 0; i < STRIP_LEDS; i++) slots[STRIP_LED_BASE + i] = lightByte(strip[i], true);
  return slots;
}

/** The two LED output reports for 103 slots, each with its id first. */
export function ledReports(slots) {
  const a = new Uint8Array(1 + LEDS_BANK0);
  const b = new Uint8Array(1 + LEDS_BANK1);
  a[0] = REPORT.LEDS;
  b[0] = REPORT.PAD_LEDS;
  for (let i = 0; i < LEDS_BANK0; i++) a[1 + i] = Math.min(127, slots[i] | 0);
  for (let i = 0; i < LEDS_BANK1; i++) b[1 + i] = Math.min(127, slots[LEDS_BANK0 + i] | 0);
  return [a, b];
}

/** Every LED off. */
export const darkReports = () => ledReports(new Uint8Array(LED_COUNT));

/** Back from the reports to slots, for the tests' pretend panel. */
export function slotsOf(bank0, bank1) {
  const slots = new Uint8Array(LED_COUNT);
  if (bank0) for (let i = 0; i < LEDS_BANK0; i++) slots[i] = bank0[1 + i] ?? 0;
  if (bank1) for (let i = 0; i < LEDS_BANK1; i++) slots[LEDS_BANK0 + i] = bank1[1 + i] ?? 0;
  return slots;
}

/** A colour slot's byte read back: `{hue, level}`, or null when off. */
export function readColour(byte) {
  return byte ? { hue: byte >> 2, level: byte & 3 } : null;
}

/* --------------------------------------------------------------- screens */

/** RGBA (8 bits a channel) to RGB565, one u16 a pixel. */
export function toRgb565(rgba, out = new Uint16Array(rgba.length >> 2)) {
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = ((rgba[i] & 0xf8) << 8) | ((rgba[i + 1] & 0xfc) << 3) | (rgba[i + 2] >> 3);
  }
  return out;
}

/** RGB565 back to RGBA, for the tests. */
export function fromRgb565(px, out = new Uint8ClampedArray(px.length * 4)) {
  for (let p = 0, i = 0; p < px.length; p++, i += 4) {
    const v = px[p];
    const r = v >> 11, g = (v >> 5) & 0x3f, b = v & 0x1f;
    out[i] = (r << 3) | (r >> 2);
    out[i + 1] = (g << 2) | (g >> 4);
    out[i + 2] = (b << 3) | (b >> 2);
    out[i + 3] = 255;
  }
  return out;
}

/**
 * Rows `[y0, y1)` where `next` differs from `prev`, or null when nothing
 * does. A missing `prev` is all of it.
 */
export function dirtyRows(next, prev, width = SCREEN_W) {
  if (!prev) return [0, next.length / width];
  const rows = next.length / width;
  let y0 = -1;
  for (let y = 0; y < rows && y0 < 0; y++) {
    for (let x = y * width, end = x + width; x < end; x++) if (next[x] !== prev[x]) { y0 = y; break; }
  }
  if (y0 < 0) return null;
  let y1 = y0 + 1;
  for (let y = rows - 1; y > y0; y--) {
    let diff = false;
    for (let x = y * width, end = x + width; x < end; x++) if (next[x] !== prev[x]) { diff = true; break; }
    if (diff) { y1 = y + 1; break; }
  }
  return [y0, y1];
}

/**
 * One bulk transfer that paints a rect of one screen: `px` holds the whole
 * screen as RGB565 and the rect is cut from it. Width × height must be even,
 * since the counts are in pairs; full-width rows always are.
 */
export function screenPacket(screen, px, { x = 0, y = 0, w = SCREEN_W, h = SCREEN_H } = {}) {
  if (screen !== 0 && screen !== 1) throw new Error('screen is 0 or 1');
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > SCREEN_W || y + h > SCREEN_H) throw new Error('rect is off the screen');
  if ((w * h) % 2) throw new Error('rect must hold an even number of pixels');
  const pairs = (w * h) / 2;
  if (pairs > 0xffff) throw new Error('rect is too big for one data command');
  const out = new Uint8Array(16 + 4 + w * h * 2 + 8);
  const view = new DataView(out.buffer);
  out.set([0x84, 0x00, screen, 0x60, 0, 0, 0, 0]);
  view.setUint16(8, x);
  view.setUint16(10, y);
  view.setUint16(12, w);
  view.setUint16(14, h);
  out.set([0x00, 0x00, pairs >> 8, pairs & 0xff], 16);
  let o = 20;
  for (let row = y; row < y + h; row++) {
    for (let col = x, i = row * SCREEN_W + x; col < x + w; col++, i++, o += 2) view.setUint16(o, px[i]);
  }
  out.set([0x03, 0x00, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00], o);
  return out;
}

/**
 * A screen packet read back: `{screen, rect, apply(px)}`, `apply` writing its
 * pixels into a whole-screen RGB565 buffer. It understands all five
 * commands, so the tests' pretend panel shows what a real one would be sent.
 */
export function readScreenPacket(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (b.length < 16 || b[0] !== 0x84 || b[3] !== 0x60) throw new Error('not a screen packet');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const screen = b[2];
  const rect = { x: view.getUint16(8), y: view.getUint16(10), w: view.getUint16(12), h: view.getUint16(14) };
  return {
    screen,
    rect,
    apply(px) {
      let pos = 0;
      const total = rect.w * rect.h;
      const put = (v) => {
        if (pos >= total) return;
        const row = rect.y + Math.floor(pos / rect.w);
        const col = rect.x + (pos % rect.w);
        px[row * SCREEN_W + col] = v;
        pos++;
      };
      for (let o = 16; o + 4 <= b.length;) {
        const op = b[o];
        const n = (b[o + 2] << 8) | b[o + 3];
        o += 4;
        if (op === 0x00) { for (let k = 0; k < n * 2; k++, o += 2) put(view.getUint16(o)); }
        else if (op === 0x01) { const c1 = view.getUint16(o), c2 = view.getUint16(o + 2); o += 4; for (let k = 0; k < n; k++) { put(c1); put(c2); } }
        else if (op === 0x02) pos += n * 2;
        else if (op === 0x03) continue;
        else if (op === 0x40) break;
        else throw new Error(`unknown screen command 0x${op.toString(16)}`);
      }
      return px;
    },
  };
}
