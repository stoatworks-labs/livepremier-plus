/*
 * The Blackmagic ATEM Micro Panel's USB/Bluetooth HID protocol.  ** PREVIEW **
 *
 * Bytes only: no device handle, no transport, no I/O — the same rule as the
 * rest of `src/core/`. The device driver (`devices/modules/atem-micro-panel/`)
 * and the plugin's server half (`plugins/atem-micro-panel/`) both read the key
 * table, and Docker has no `devices/`, so it lives here, as the Barco EC
 * panel's does in `ec-panel.js`.
 *
 * ## What the panel is
 *
 * A switcher's face with no switcher behind it. It does nothing on its own:
 * ATEM Software Control, on the computer the panel is plugged into (or paired
 * with), reads its keys and T-bar and sets every key's colour itself. So it is
 * a keyboard with lamps, and whatever holds it decides what each key means —
 * here, `plugins/atem-micro-panel/core.js`.
 *
 * Blackmagic has never published any of this. The handshake is the Speed
 * Editor's, from Sylvain Munaut's reverse engineering (bmd.py, Apache-2.0),
 * answered on feature report 5 rather than 6. The key codes, lamp bits and
 * report ids follow Julian Waller's node-blackmagic-controller (MIT), which is
 * what Bitfocus Companion drives the panel with. See ATTRIBUTIONS.md.
 *
 * ⚠️ **Never yet run against a panel here.** Everything below is as those two
 * sources describe it; `test/atem-micro-panel.test.js` holds this file to
 * them and to a pretend panel, which proves nothing about the hardware.
 */

import { authResponse } from '../vendor/surface/hid/speed-editor.js';

export const VENDOR_ID = 0x1edb;
/* The same ids over USB and over Bluetooth, where it is a HID device too. */
export const PRODUCT_ID = 0xbef0;
export const PRODUCT_NAME = 'ATEM Micro Panel';

/* Report ids. Input, output and feature reports are separate namespaces. */
export const REPORT = Object.freeze({
  AUTH: 0x05,        // feature, both ways: the handshake (the Speed Editor's is 6)
  IN_KEYS: 0x03,     // input: every key held now, LE16 codes, zero-terminated
  IN_BATTERY: 0x06,  // input: level in byte 2
  IN_TBAR: 0x08,     // input: LE16 position, 0..4096
  OUT_LEDS: 0x02,    // output: one bit per lamp colour, 32 bytes with the id
});

export const LED_REPORT_BYTES = 32;
export const TBAR_MAX = 4096;
export const TBAR_SEGMENTS = 16;
/* The T-bar's meter is the first sixteen bits of the lamp report. Which end
   segment 0 is at has not been seen. */
const TBAR_LED_BIT = 0;

/**
 * A key's colour is three bits — red, green, blue — at its `led` bit, so a key
 * shows one of eight colours, on or off, with no brightness between.
 */
export const COLOUR = Object.freeze({
  OFF: 0, RED: 1, GREEN: 2, YELLOW: 3, BLUE: 4, MAGENTA: 5, CYAN: 6, WHITE: 7,
});

/*
 * Every key, by the panel's own engraving: its name here, the label printed
 * on it, the code it reports, the first of its three lamp bits, and where it
 * sits (row 0 is the top; columns as node-blackmagic-controller counts them,
 * the T-bar in column 14).
 */
const k = (row, col, name, label, code, led) => Object.freeze({ row, col, name, label, code, led });

export const KEYS = Object.freeze([
  k(0, 5, 'MACRO', 'MACRO', 0x01, 16),
  k(0, 6, 'KEY1_ON_AIR', 'KEY 1 ON AIR', 0x02, 19),
  k(0, 7, 'KEY2_ON_AIR', 'KEY 2 ON AIR', 0x03, 22),
  k(0, 8, 'KEY3_ON_AIR', 'KEY 3 ON AIR', 0x04, 25),
  k(0, 9, 'KEY4_ON_AIR', 'KEY 4 ON AIR', 0x05, 28),

  k(1, 5, 'NEXT_BKGD', 'BKGD', 0x06, 31),
  k(1, 6, 'NEXT_KEY1', 'KEY 1', 0x07, 34),
  k(1, 7, 'NEXT_KEY2', 'KEY 2', 0x08, 37),
  k(1, 8, 'NEXT_KEY3', 'KEY 3', 0x09, 40),
  k(1, 9, 'NEXT_KEY4', 'KEY 4', 0x0a, 43),

  ...Array.from({ length: 10 }, (_, i) => k(2, i, `PGM_${i + 1}`, `PROGRAM ${i + 1}`, 0x0b + i, 46 + 3 * i)),
  ...Array.from({ length: 10 }, (_, i) => k(3, i, `PVW_${i + 1}`, `PREVIEW ${i + 1}`, 0x15 + i, 76 + 3 * i)),

  ...Array.from({ length: 4 }, (_, i) => k(0, 10 + i, `ME_${i + 1}`, `M/E ${i + 1}`, 0x1f + i, 106 + 3 * i)),

  k(1, 11, 'DIP', 'DIP', 0x23, 118),
  k(1, 12, 'DVE', 'DVE', 0x24, 121),
  k(1, 13, 'STING', 'STING', 0x25, 124),
  k(2, 10, 'SHIFT', 'SHIFT', 0x26, 127),
  k(2, 11, 'MIX', 'MIX', 0x27, 130),
  k(2, 12, 'WIPE', 'WIPE', 0x28, 133),
  k(2, 13, 'ARM', 'ARM', 0x29, 136),
  k(3, 10, 'PREV_TRANS', 'PREV TRANS', 0x2a, 139),
  k(3, 11, 'CUT', 'CUT', 0x2b, 142),
  k(3, 13, 'AUTO', 'AUTO', 0x2c, 145),

  k(1, 15, 'DSK1_TIE', 'DSK 1 TIE', 0x2d, 148),
  k(1, 16, 'DSK2_TIE', 'DSK 2 TIE', 0x2e, 151),
  k(2, 15, 'DSK1_CUT', 'DSK 1 CUT', 0x2f, 154),
  k(2, 16, 'DSK2_CUT', 'DSK 2 CUT', 0x30, 157),
  k(3, 15, 'DSK1_AUTO', 'DSK 1 AUTO', 0x31, 160),
  k(3, 16, 'DSK2_AUTO', 'DSK 2 AUTO', 0x32, 163),
]);

export const KEY_BY_CODE = new Map(KEYS.map((key) => [key.code, key]));
export const KEY_BY_NAME = new Map(KEYS.map((key) => [key.name, key]));

/* ------------------------------------------------------------------ auth */

/*
 * The panel says nothing until the host has answered its challenge, and stops
 * again when the answer expires; `authenticate` resolves with the seconds
 * until then. The steps and the arithmetic are the Speed Editor's, so the
 * answer comes from the vendored `authResponse` that has passed on a real
 * Speed Editor; only the report id differs.
 */

const readU64 = (bytes, at) => {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[at + i]);
  return v;
};

/** A 10-byte AUTH feature report: id, step, then a little-endian u64. */
export function authPacket(step, value = 0n) {
  const out = new Uint8Array(10);
  out[0] = REPORT.AUTH;
  out[1] = step;
  for (let i = 0; i < 8; i++) out[2 + i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return out;
}

/**
 * Run the handshake.
 *
 * @param io.sendFeature(bytes)       send a feature report, id in byte 0
 * @param io.getFeature(id, length)   read one, at that length, id in byte 0
 * @returns seconds until the panel wants it done again
 */
export async function authenticate(io) {
  await io.sendFeature(authPacket(0));                  // reset the state machine
  const challenge = await io.getFeature(REPORT.AUTH, 10);
  await io.sendFeature(authPacket(1));                  // our challenge to it
  await io.getFeature(REPORT.AUTH, 10);                 // its answer, unchecked
  await io.sendFeature(authPacket(3, authResponse(readU64(challenge, 2))));
  const status = await io.getFeature(REPORT.AUTH, 10);
  if (status[1] !== 0x04) throw new Error('the ATEM Micro Panel refused the authentication');
  return status[2] | (status[3] << 8);
}

/* ---------------------------------------------------------------- input */

/**
 * Decode one input report.
 *
 *   {type:'keys', codes:[…]}       every key held now — the whole set on each
 *                                  change, never a delta
 *   {type:'tbar', raw, fraction}   where the lever is, 0..4096 and 0..1
 *   {type:'battery', level}        0..100
 *   null                           anything else
 */
export function decodeReport(bytes) {
  if (!bytes?.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case REPORT.IN_KEYS: {
      const codes = [];
      for (let at = 1; at + 1 < bytes.length; at += 2) {
        const code = view.getUint16(at, true);
        if (!code) break;
        codes.push(code);
      }
      return { type: 'keys', codes };
    }
    case REPORT.IN_TBAR: {
      if (bytes.length < 3) return null;
      const raw = view.getUint16(1, true);
      return { type: 'tbar', raw, fraction: Math.min(1, Math.max(0, raw / TBAR_MAX)) };
    }
    case REPORT.IN_BATTERY:
      if (bytes.length < 3) return null;
      return { type: 'battery', level: bytes[2] };
    default:
      return null;
  }
}

/**
 * Which keys went down and which came up between two key reports. The panel
 * sends what is held, so a press is a code that was not there before.
 */
export function keyChanges(before, codes) {
  const was = new Set(before);
  const now = new Set(codes);
  return {
    down: codes.filter((c) => !was.has(c) && KEY_BY_CODE.has(c)),
    up: [...was].filter((c) => !now.has(c) && KEY_BY_CODE.has(c)),
  };
}

/* --------------------------------------------------------------- output */

const setBit = (out, bit, on) => {
  const at = 1 + (bit >> 3);
  const mask = 1 << (bit & 7);
  if (on) out[at] |= mask; else out[at] &= ~mask;
};

/**
 * The whole lamp report: every key's colour and the T-bar's meter. The panel
 * keeps no lamp state of its own that this relies on — each report says
 * everything, so a key not named is dark.
 *
 * @param {Map<string, number>|object} colours  key name → COLOUR
 * @param {boolean[]} [meter]                   up to sixteen segments, segment 0 first
 */
export function ledReport(colours = new Map(), meter = []) {
  const out = new Uint8Array(LED_REPORT_BYTES);
  out[0] = REPORT.OUT_LEDS;
  const entries = colours instanceof Map ? colours : new Map(Object.entries(colours));
  for (const [name, colour] of entries) {
    const key = KEY_BY_NAME.get(name);
    if (!key) continue;
    const c = Number(colour) & 7;
    setBit(out, key.led, c & 1);
    setBit(out, key.led + 1, c & 2);
    setBit(out, key.led + 2, c & 4);
  }
  for (let i = 0; i < TBAR_SEGMENTS; i++) setBit(out, TBAR_LED_BIT + i, !!meter[i]);
  return out;
}

/** The meter for a fraction of travel, 0..1: that many segments lit from segment 0. */
export function meterFor(fraction) {
  const lit = Math.round(Math.min(1, Math.max(0, Number(fraction) || 0)) * TBAR_SEGMENTS);
  return Array.from({ length: TBAR_SEGMENTS }, (_, i) => i < lit);
}

/** The report that leaves every lamp dark. */
export const darkReport = () => ledReport();
