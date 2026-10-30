/*
 * sACN (ANSI E1.31), the receive side — no I/O.
 *
 * Every desk this was written for sends it, and it has the one thing Art-Net
 * lacks for a show: a priority. A backup desk sending the same universe at a
 * lower priority takes over by itself when the main one stops, which is a
 * tracking backup for nothing. `core/dmx-input.js` does the arbitration; this
 * only reads packets.
 *
 * Read from E1.31-2016. E1.31-2025 (approved January 2026) adds IPv6, which
 * this does not do.
 *
 * A data packet is three nested layers, each with a flags-and-length word
 * and a vector, at fixed offsets because every field before the slots is
 * fixed in size:
 *
 *     root      0..37    preamble, "ASC-E1.17", vector 4 (data) / 8 (extended), CID
 *     framing  38..114   vector 2, source name, priority, sync address,
 *                        sequence, options, universe
 *     DMP     115..      vector 2, 0xa1, first address 0, increment 1,
 *                        count (1 + slots), START code, slots
 *
 * Everything is big-endian (network order).
 */

export const SACN_PORT = 5568;

const ACN_ID = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00];
const VECTOR_ROOT_DATA = 0x00000004;
const VECTOR_ROOT_EXTENDED = 0x00000008;
const VECTOR_FRAMING_DATA = 0x00000002;
const VECTOR_EXTENDED_SYNC = 0x00000001;
const VECTOR_EXTENDED_DISCOVERY = 0x00000002;

/* Framing options. */
export const OPTION_PREVIEW = 0x80;      /* "shall not be used to drive live output" */
export const OPTION_TERMINATED = 0x40;   /* the source has stopped sending this universe */
export const OPTION_FORCE_SYNC = 0x20;

/** The universe a receiver listens to the discovery messages on; not a data universe. */
export const DISCOVERY_UNIVERSE = 64214;

/** The multicast group for a universe: 239.255.<hi>.<lo>. */
export function multicastGroup(universe) {
  return `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;
}

/** Data universes are 1–63999. */
export const validUniverse = (u) => Number.isInteger(u) && u >= 1 && u <= 63999;

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];

/**
 * Read one sACN packet: `{kind: 'data' | 'sync' | 'discovery', …}`, or null
 * for anything that is not E1.31.
 *
 * @param {Uint8Array} b
 */
export function parseSacn(b) {
  if (!b || b.length < 46) return null;
  if (u16(b, 0) !== 0x0010) return null;                      /* preamble size */
  for (let i = 0; i < ACN_ID.length; i++) if (b[4 + i] !== ACN_ID[i]) return null;
  const rootVector = u32(b, 18);
  const cid = hex(b.subarray(22, 38));

  if (rootVector === VECTOR_ROOT_DATA) {
    if (b.length < 126) return null;
    if (u32(b, 40) !== VECTOR_FRAMING_DATA) return null;
    if (b[117] !== 0x02 || b[118] !== 0xa1) return null;      /* DMP vector, address type */
    const count = u16(b, 123);                                /* START code + slots */
    const slots = Math.max(0, Math.min(count - 1, 512, b.length - 126));
    return {
      kind: 'data',
      cid,
      sourceName: utf8z(b.subarray(44, 108)),
      priority: b[108],
      syncAddress: u16(b, 109),
      sequence: b[111],
      options: b[112],
      preview: (b[112] & OPTION_PREVIEW) !== 0,
      terminated: (b[112] & OPTION_TERMINATED) !== 0,
      universe: u16(b, 113),
      startCode: b[125],
      data: b.subarray(126, 126 + slots),
    };
  }
  if (rootVector === VECTOR_ROOT_EXTENDED) {
    const vector = u32(b, 40);
    if (vector === VECTOR_EXTENDED_SYNC && b.length >= 49) {
      return { kind: 'sync', cid, sequence: b[44], syncAddress: u16(b, 45) };
    }
    if (vector === VECTOR_EXTENDED_DISCOVERY) return { kind: 'discovery', cid };
  }
  return null;
}

/**
 * Whether a packet's sequence number says it is out of order, by E1.31's rule:
 * discard when the signed 8-bit difference to the last one is in (−20, 0].
 */
export function outOfOrder(last, next) {
  if (last === null || last === undefined) return false;
  let d = (next - last) & 0xff;
  if (d > 127) d -= 256;
  return d <= 0 && d > -20;
}

/**
 * A data packet, for tests and the fake desk. `cid` is 32 hex digits.
 */
export function buildSacnData(universe, data, { cid = '00'.repeat(16), sourceName = 'test', priority = 100, sequence = 0, options = 0, startCode = 0 } = {}) {
  const slots = Math.min(512, data.length);
  const b = new Uint8Array(126 + slots);
  const put16 = (i, v) => { b[i] = (v >> 8) & 0xff; b[i + 1] = v & 0xff; };
  const put32 = (i, v) => { b[i] = (v >>> 24) & 0xff; b[i + 1] = (v >> 16) & 0xff; b[i + 2] = (v >> 8) & 0xff; b[i + 3] = v & 0xff; };
  put16(0, 0x0010);
  b.set(ACN_ID, 4);
  put16(16, 0x7000 | (b.length - 16));
  put32(18, VECTOR_ROOT_DATA);
  b.set(unhex(cid), 22);
  put16(38, 0x7000 | (b.length - 38));
  put32(40, VECTOR_FRAMING_DATA);
  const name = new TextEncoder().encode(sourceName).subarray(0, 63);
  b.set(name, 44);
  b[108] = priority;
  b[111] = sequence & 0xff;
  b[112] = options;
  put16(113, universe);
  put16(115, 0x7000 | (b.length - 115));
  b[117] = 0x02;
  b[118] = 0xa1;
  put16(119, 0);
  put16(121, 1);
  put16(123, slots + 1);
  b[125] = startCode;
  b.set(data.subarray ? data.subarray(0, slots) : data.slice(0, slots), 126);
  return b;
}

function hex(bytes) {
  let s = '';
  for (const x of bytes) s += x.toString(16).padStart(2, '0');
  return s;
}

function unhex(s) {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(String(s).slice(i * 2, i * 2 + 2), 16) || 0;
  return out;
}

function utf8z(bytes) {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end >= 0 ? bytes.subarray(0, end) : bytes);
}
