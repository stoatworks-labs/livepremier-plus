/*
 * An X-keys panel's bytes — P.I. Engineering's programmable keypads, sticks,
 * foot pedals and T-bar panels, as LivePremier Plus reads and lights them.
 * ** PREVIEW **: never yet run against a panel.
 *
 * Everything here is SuperFly.tv's xkeys library (MIT) — the code Bitfocus
 * Companion drives real X-keys with — ported to plain functions: the product
 * table is generated from its `products.ts` (`xkeys-products.js`), and the
 * input parsing and output messages follow its `xkeys.ts`.
 * `test/xkeys.test.js` replays that library's recordings of real panels
 * through `decodeReport` and checks the messages here against the bytes it
 * recorded. Never edit a table from a photo of a panel; a real panel that
 * disagrees goes in docs/NOTES.md first.
 *
 * Like `atem-micro-panel.js` and `ec-panel.js` it lives in `core/` with no I/O,
 * because the device host's driver and the plugin both read it and Docker
 * carries no `devices/`.
 *
 * ## The wire
 *
 * ```text
 *   in   32+ bytes, no report id:  [unit id, flags, button bytes…, analogue…]
 *        flags bit 0 = the program switch, bit 1 = "this answers Generate Data";
 *        flags 214 = the version reply (firmware at byte 10), and anything
 *        above 3 is some other special report, never keys
 *   out  36 bytes, report id 0 first:  [0, command, arguments…, zero padding]
 * ```
 *
 * A key is a bit: button byte x, bit y is key `x × bBits + y + 1`, so keys
 * count down each column of `bBits`. Key 0 is the program switch, on the
 * panels that have one.
 */

import { XKEYS_VENDOR_ID, BACKLIGHT, PRODUCTS } from './xkeys-products.js';

export { BACKLIGHT, PRODUCTS };
export const VENDOR_ID = XKEYS_VENDOR_ID;

/* Every output report: id 0, then 35 bytes — what the library pads to, and
   what Windows insists on (the output report's length plus its id). */
export const OUT_BYTES = 36;

export const CMD = Object.freeze({
  RGB_BACKLIGHT: 165,
  RGB_ALL: 166,
  GENERATE_DATA: 177,
  INDICATOR: 179,
  BACKLIGHT: 181,
  ALL_BACKLIGHTS: 182,
  VERSION: 214,
});

/* The version reply's marker in byte 1, and the highest flags a key report has. */
const VERSION_REPLY = 214;
const MAX_FLAGS = 3;

/** The two lamps above the keys on most panels. */
export const INDICATOR = Object.freeze({ GREEN: 1, RED: 2 });

/** Colours as the panels take them. A two-colour panel shows blue, red, both, or neither. */
export const RGB = Object.freeze({
  OFF: Object.freeze({ r: 0, g: 0, b: 0 }),
  RED: Object.freeze({ r: 255, g: 0, b: 0 }),
  GREEN: Object.freeze({ r: 0, g: 255, b: 0 }),
  BLUE: Object.freeze({ r: 0, g: 0, b: 255 }),
  YELLOW: Object.freeze({ r: 255, g: 128, b: 0 }),
  PURPLE: Object.freeze({ r: 255, g: 0, b: 255 }),
  WHITE: Object.freeze({ r: 255, g: 255, b: 255 }),
});

/* ---------------------------------------------------------- the panels */

const ENTRIES = Object.entries(PRODUCTS).map(([model, p]) => Object.freeze({ model, ...p }));
const BY_MODEL = new Map(ENTRIES.map((p) => [p.model, p]));

/** Every panel this knows, `{ model, name, … }`, in the table's order. */
export const MODELS = Object.freeze(ENTRIES);

export const productOf = (model) => BY_MODEL.get(model) ?? null;

/**
 * The panel a HID entry is, or null. An X-keys shows several HID interfaces
 * (keyboard, mouse, joystick and its own); the table names the one its data
 * comes on. An interface the platform could not say (`null`, or `-1`, as
 * hidapi reports for a device with no USB parent) is accepted, as the
 * library accepts `null`.
 */
export function findProduct({ vendorId = VENDOR_ID, productId, interface: iface } = {}) {
  if (vendorId !== VENDOR_ID) return null;
  const unknown = iface === null || iface === undefined || iface === -1;
  for (const p of ENTRIES) {
    for (const [pid, at] of p.hidDevices) {
      if (pid === productId && (unknown || at === iface)) return p;
    }
  }
  return null;
}

/** How a panel lights its keys: `'none'`, `'blue'` (sticks), `'two'` (blue and red) or `'rgb'`. */
export function lampsOf(product) {
  switch (product?.backLightType) {
    case BACKLIGHT.LEGACY:
    case BACKLIGHT.LINEAR: return 'two';
    case BACKLIGHT.STICK_BUTTONS: return 'blue';
    case BACKLIGHT.REMAP_24:
    case BACKLIGHT.RGBx2: return 'rgb';
    default: return 'none';
  }
}

/** Where a key sits, `{row, col}` from 1, as the library places it (row and col 0 for the program switch). */
export function keyLocation(product, index) {
  if (product.btnLocation) {
    const at = product.btnLocation[index];
    return at ? { row: at[0], col: at[1] } : null;
  }
  if (index === 0) return { row: 0, col: 0 };
  const col = Math.ceil(index / product.bBits);
  return { row: index - product.bBits * (col - 1), col };
}

/**
 * Every key a panel has, `{index, row, col}`, the program switch first. Keys
 * the table disables (the shuttle's own bits on a jog panel, the joystick's
 * well) are left out; so are bits a placed panel has no place for.
 */
export function keysOf(product) {
  const out = [];
  const disabled = new Set(product.disableButtons || []);
  if (product.hasPS) out.push({ index: 0, row: 0, col: 0 });
  const last = product.bBytes * product.bBits;
  for (let index = 1; index <= last; index++) {
    if (disabled.has(index)) continue;
    const at = keyLocation(product, index);
    if (!at) continue;
    out.push({ index, ...at });
  }
  return out;
}

/* ------------------------------------------------------------- reading */

const signed = (b) => (b < 128 ? b : b - 256);

/**
 * One input report. `{type: 'keys', unitId, generated, keys, tbar, jog,
 * shuttle, timestamp}` for the usual report — `keys` every key held, by index,
 * in order; `generated` when it answers Generate Data — or `{type: 'version',
 * unitId, firmware}`, or `{type: 'special', code}` for any other special
 * report, or null for one too short to be anything.
 */
export function decodeReport(product, bytes) {
  if (!product || !bytes || bytes.length < 2 + product.bBytes) return null;
  const flags = bytes[1];
  if (flags === VERSION_REPLY) {
    return { type: 'version', unitId: bytes[0], firmware: bytes[10] || 1 };
  }
  if (flags > MAX_FLAGS) return { type: 'special', code: flags };

  const disabled = new Set(product.disableButtons || []);
  const keys = [];
  if (product.hasPS && (flags & 1)) keys.push(0);
  for (let x = 0; x < product.bBytes; x++) {
    const d = bytes[2 + x];
    if (!d) continue;
    for (let y = 0; y < product.bBits; y++) {
      if (!(d & (1 << y))) continue;
      const index = x * product.bBits + y + 1;
      if (!disabled.has(index)) keys.push(index);
    }
  }
  const at = (i) => (i < bytes.length ? bytes[i] : 0);
  const ts = product.timestampByte;
  return {
    type: 'keys',
    unitId: bytes[0],
    generated: (flags & 2) !== 0,
    keys,
    tbar: (product.hasTbar || []).map((t) => at(t.tbarByte)),
    jog: (product.hasJog || []).map((j) => signed(at(j.jogByte))),
    shuttle: (product.hasShuttle || []).map((s) => signed(at(s.shuttleByte))),
    timestamp: ts !== undefined && ts + 4 <= bytes.length
      ? ((bytes[ts] << 24) >>> 0) + (bytes[ts + 1] << 16) + (bytes[ts + 2] << 8) + bytes[ts + 3]
      : null,
  };
}

/** Keys pressed and let go between two reports' `keys`. */
export function keyChanges(before, now) {
  const was = new Set(before || []);
  const is = new Set(now || []);
  return {
    down: [...is].filter((k) => !was.has(k)),
    up: [...was].filter((k) => !is.has(k)),
  };
}

/* -------------------------------------------------------------- writing */

function report(bytes) {
  const out = new Array(OUT_BYTES).fill(0);
  bytes.forEach((b, i) => { out[i] = b & 0xff; });
  return out;
}

/** Ask for the firmware version: the panel answers with a version report. */
export const versionRequest = () => report([0, CMD.VERSION]);

/** Ask for every key's state now: the panel answers with a key report, `generated` set. */
export const generateDataRequest = () => report([0, CMD.GENERATE_DATA]);

/** One of the two lamps above the keys: `'off'`, `'on'` or `'flash'`. */
export function indicatorReport(led, mode) {
  const at = led === INDICATOR.RED ? 7 : 6;
  return report([0, CMD.INDICATOR, at, mode === 'flash' ? 2 : mode === 'on' ? 1 : 0]);
}

const lit = (on, flash) => (on ? (flash ? 2 : 1) : 0);

/**
 * One key's backlight, as the reports that set it. A two-colour panel takes
 * blue from `b` and red from `r` or `g`, as the library does; a stick has
 * only blue, lit for any colour. A panel with no backlights takes nothing.
 */
export function backlightReports(product, index, colour = RGB.OFF, flash = false) {
  if (index === 0) return [];        // the program switch has no light
  const c = colour || RGB.OFF;
  const at = keyLocation(product, index);
  if (!at) return [];
  switch (product.backLightType) {
    case BACKLIGHT.REMAP_24: {
      const led = (at.col - 1) * 8 + at.row - 1;
      return [report([0, CMD.BACKLIGHT, led, c.g, c.r, c.b, flash ? 1 : 0])];     // G, R, B, flash
    }
    case BACKLIGHT.RGBx2: {
      const led = index - 1;
      return [0, 1].map((bank) => report([0, CMD.RGB_BACKLIGHT, led, bank, c.r, c.g, c.b, flash ? 1 : 0]));
    }
    case BACKLIGHT.STICK_BUTTONS: {
      let led = at.col - 1;
      if (led > 11) led += 4;
      else if (led > 5) led += 2;
      return [report([0, CMD.BACKLIGHT, led, lit(c.r > 0 || c.g > 0 || c.b > 0, flash), 1])];
    }
    case BACKLIGHT.LINEAR: {
      const blue = index - 1;
      return [
        report([0, CMD.BACKLIGHT, blue, lit(c.b > 0, flash), 0]),
        report([0, CMD.BACKLIGHT, blue + product.backLight2offset, lit(c.r > 0 || c.g > 0, flash), 0]),
      ];
    }
    case BACKLIGHT.LEGACY: {
      const blue = (at.col - 1) * 8 + at.row - 1;
      return [
        report([0, CMD.BACKLIGHT, blue, lit(c.b > 0, flash), 1]),
        report([0, CMD.BACKLIGHT, blue + (product.backLight2offset || 0), lit(c.r > 0 || c.g > 0, flash), 1]),
      ];
    }
    default:
      return [];
  }
}

/** Every key's backlight at once. */
export function allBacklightReports(product, colour = RGB.OFF) {
  const c = colour || RGB.OFF;
  if (product.backLightType === BACKLIGHT.RGBx2) {
    return [0, 1].map((bank) => report([0, CMD.RGB_ALL, bank, c.r, c.g, c.b]));
  }
  /* Sent even to a panel with no backlights, as the library does: harmless. */
  return [
    report([0, CMD.ALL_BACKLIGHTS, 0, c.b]),
    report([0, CMD.ALL_BACKLIGHTS, 1, c.r || c.g]),
  ];
}

/** Every backlight and both lamps off — how a panel is left for whoever has it next. */
export function darkReports(product) {
  return [
    ...allBacklightReports(product, RGB.OFF),
    indicatorReport(INDICATOR.GREEN, 'off'),
    indicatorReport(INDICATOR.RED, 'off'),
  ];
}
