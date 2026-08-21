/*
 * Mackie Control, as spoken by the Behringer X-Touch.
 *
 * MCU is what makes an X-Touch worth wiring to a switcher at all: the faders
 * are motorised, the V-Pots have LED rings, and each strip has a two-row
 * scribble strip. All three are feedback devices, and all three are addressed
 * by conventions that are widely implemented but not, anywhere, officially
 * published. What follows is the de-facto protocol.
 *
 *   faders        pitch bend, channel 0-7 per strip, channel 8 = master.
 *                 14-bit. The SAME message drives the motor, so feedback is
 *                 just the message the surface would have sent.
 *   fader touch   notes 104-111, 112 = master. Sent when a finger lands and
 *                 leaves. Essential: a motor fader must not be driven while it
 *                 is being held, and a touched fader's own moves must win.
 *   V-Pots        CC 16-23, sign-magnitude relative.
 *   V-Pot rings   CC 48-55, value = (mode << 4) | position, bit 6 lights the
 *                 centre LED.
 *   buttons       note on/off, velocity 127 press, 0 release.
 *   button lamps  note on, velocity 0 off / 1 flashing / 127 lit.
 *   meters        channel pressure, (strip << 4) | level.
 *   scribble      SysEx 12: two rows of 56 characters, 7 per strip.
 *   strip colour  SysEx 72, an X-Touch extension, one byte per strip.
 *
 * `deviceId` selects the surface: 0x14 is a Mackie Control (what the X-Touch
 * emulates by default), 0x15 an extender.
 */

import { encode } from './message.js';

export const MCU_DEVICE_ID = 0x14;
export const XT_DEVICE_ID = 0x15;

export const FADER_TOUCH_BASE = 104;
export const VPOT_CC_BASE = 16;
export const VPOT_RING_CC_BASE = 48;
export const STRIPS = 8;

/** V-Pot LED ring display styles. */
export const RING_MODE = {
  SINGLE: 0,   // one lit LED — a plain position
  BOOST_CUT: 1, // fills outward from centre — signed values
  WRAP: 2,     // fills from the left — a level
  SPREAD: 3    // symmetric about centre — a width
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/* ------------------------------------------------------------------ faders */

/** Position a motorised fader from a 0..1 value. */
export const faderMessage = (strip, norm) => ({
  type: 'pitchBend',
  channel: strip,
  value: Math.round(clamp(norm, 0, 1) * 16383)
});

/** The 0..1 position a fader message represents. */
export const faderValue = (msg) => msg.value / 16383;

/** True when `note` is a fader-touch contact, and which strip it belongs to. */
export function faderTouch(note) {
  const strip = note - FADER_TOUCH_BASE;
  return strip >= 0 && strip <= STRIPS ? strip : null;
}

/* ------------------------------------------------------------------ V-Pots */

/** The strip a V-Pot CC belongs to, or null. */
export function vpotStrip(controller) {
  const strip = controller - VPOT_CC_BASE;
  return strip >= 0 && strip < STRIPS ? strip : null;
}

/**
 * Light a V-Pot's LED ring.
 *
 * `norm` is 0..1. Position 0 means every LED off, so a real zero is
 * distinguishable from "no value" — which is why `null` blanks the ring
 * instead of showing position 1.
 */
export function ringMessage(strip, norm, mode = RING_MODE.WRAP, centre = false) {
  const pos = norm === null || norm === undefined
    ? 0
    : clamp(Math.round(norm * 10) + 1, 1, 11);
  return {
    type: 'cc',
    channel: 0,
    controller: VPOT_RING_CC_BASE + strip,
    value: ((mode & 0x03) << 4) | (centre ? 0x40 : 0) | pos
  };
}

/* ----------------------------------------------------------------- buttons */

export const LAMP = { OFF: 0, FLASH: 1, ON: 127 };

/** Set a button lamp. `state` is a LAMP value, or a boolean. */
export const lampMessage = (note, state, channel = 0) => ({
  type: 'noteOn',
  channel,
  note,
  velocity: typeof state === 'boolean' ? (state ? LAMP.ON : LAMP.OFF) : state
});

/* ------------------------------------------------------------------ meters */

/**
 * Drive a strip's meter. `level` is 0..1; 0x0E lights the clip LED and 0x0F
 * clears it, which is why the usable range stops at 0x0C.
 */
export const meterMessage = (strip, level) => ({
  type: 'channelPressure',
  channel: 0,
  value: ((strip & 0x07) << 4) | clamp(Math.round(level * 0x0c), 0, 0x0c)
});

/* --------------------------------------------------------------- scribble */

/*
 * The scribble strips are one 112-character buffer: 56 characters on the top
 * row then 56 on the bottom, seven per strip. Writing a strip means writing at
 * the right offset — there is no "strip 3, row 2" addressing.
 */
export const SCRIBBLE_WIDTH = 7;

/** ASCII, padded or truncated to a scribble cell. The surface has no charset. */
function cell(text) {
  const s = String(text ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .slice(0, SCRIBBLE_WIDTH);
  return s.padEnd(SCRIBBLE_WIDTH, ' ');
}

/**
 * Write one strip's two rows.
 *
 * Sent as a single SysEx per strip rather than one buffer-wide message: strips
 * update independently as layers are selected, and rewriting all eight on every
 * change is both slower and visibly flickery on hardware.
 */
export function scribbleMessage(strip, top, bottom, deviceId = MCU_DEVICE_ID) {
  const chars = [...cell(top)].map((c) => c.charCodeAt(0));
  const offset = strip * SCRIBBLE_WIDTH;
  const msgs = [{ type: 'sysex', data: [0x00, 0x00, 0x66, deviceId, 0x12, offset, ...chars] }];
  if (bottom !== undefined) {
    const low = [...cell(bottom)].map((c) => c.charCodeAt(0));
    msgs.push({
      type: 'sysex',
      data: [0x00, 0x00, 0x66, deviceId, 0x12, offset + 56, ...low]
    });
  }
  return msgs;
}

/*
 * Scribble strip backlight colours. This is a Behringer addition, not Mackie:
 * one message carries all eight strips, and a real MCU ignores it.
 */
export const STRIP_COLOUR = {
  OFF: 0, RED: 1, GREEN: 2, YELLOW: 3, BLUE: 4, MAGENTA: 5, CYAN: 6, WHITE: 7
};

export const stripColourMessage = (colours, deviceId = MCU_DEVICE_ID) => ({
  type: 'sysex',
  data: [
    0x00, 0x00, 0x66, deviceId, 0x72,
    ...Array.from({ length: STRIPS }, (_, i) => (colours[i] ?? STRIP_COLOUR.OFF) & 0x07)
  ]
});

/** Bytes for every message in a list, ready to hand to a port. */
export const bytes = (msgs) => (Array.isArray(msgs) ? msgs : [msgs]).map(encode);
