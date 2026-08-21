/*
 * Endless rotary encoders.
 *
 * An encoder does not have a position, it has movement, and there are three
 * incompatible conventions for putting that movement in a 7-bit CC. Getting
 * this wrong is not subtle — pick the wrong one and the parameter runs away in
 * one direction, or moves backwards.
 *
 *   signed      bit 6 is the sign, bits 0-5 the tick count.
 *               0x01..0x3F clockwise, 0x41..0x7F anticlockwise.
 *               Mackie Control, and so the X-Touch in MC mode.
 *   twos        1..63 clockwise, 127..65 anticlockwise (two's complement).
 *   offset      64 is centre; above is clockwise, below anticlockwise.
 *
 * `absolute` is included because plenty of "encoders" are really potentiometers
 * — the APC40's device-control knobs among them — and a mapping should be able
 * to say so rather than having a separate control type.
 */

export const RELATIVE_MODES = ['signed', 'twos', 'offset'];

/**
 * Decode a CC value into a tick delta.
 *
 * Returns 0 for the neutral value in each convention, which lets a caller
 * forward everything without special-casing "no movement".
 */
export function decodeRelative(value, mode = 'signed') {
  const v = value & 0x7f;
  switch (mode) {
    case 'signed':
      return v & 0x40 ? -(v & 0x3f) : v & 0x3f;
    case 'twos':
      return v < 64 ? v : v - 128;
    case 'offset':
      return v - 64;
    default:
      throw new Error(`unknown relative mode ${mode}`);
  }
}

/** Encode a tick delta back into a CC value, for driving an emulated surface. */
export function encodeRelative(delta, mode = 'signed') {
  const d = Math.max(-63, Math.min(63, Math.round(delta)));
  switch (mode) {
    case 'signed':
      return d < 0 ? 0x40 | Math.min(63, -d) : d & 0x3f;
    case 'twos':
      return d < 0 ? (d + 128) & 0x7f : d & 0x7f;
    case 'offset':
      return (64 + d) & 0x7f;
    default:
      throw new Error(`unknown relative mode ${mode}`);
  }
}

/**
 * Acceleration.
 *
 * Endless encoders send one tick per detent however fast they are turned, so a
 * long parameter is a lot of wrist. Multiplying by turn speed gives coarse
 * movement when spun and single units when nudged, which is how every desk
 * that has these behaves.
 *
 * The curve is deliberately gentle and capped: a surface that overshoots by an
 * order of magnitude when the operator hurries is worse than one that is slow.
 */
export class Accelerator {
  constructor({ max = 12, window = 250 } = {}) {
    this.max = max;
    this.window = window;
    this.last = -Infinity;
    this.rate = 0;
  }

  /** Scale `delta` by how recently the previous tick arrived. */
  apply(delta, now = Date.now()) {
    const gap = now - this.last;
    this.last = now;
    if (gap > this.window) this.rate = 1;
    else {
      /* Ticks arriving twice as close double the rate, up to the cap. */
      const speed = Math.max(1, this.window / Math.max(gap, 1) / 4);
      this.rate = Math.min(this.max, this.rate * 0.5 + speed * 0.5);
    }
    return delta * Math.max(1, Math.round(this.rate));
  }

  reset() {
    this.last = -Infinity;
    this.rate = 0;
  }
}
