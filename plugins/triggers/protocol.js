/*
 * Triggers — the wire formats, with no I/O: OSC messages, Art-Net and sACN
 * DMX packets, and MIDI bytes.
 *
 * Everything here builds a Buffer and nothing sends one; `outputs.js` does
 * that. Each format is written from its published document, and the tests
 * read the bytes back with an independent reader (`server/osc.js`'s decoder
 * for OSC) or against the document's own fixed values.
 *
 * ## OSC
 *
 * OSC 1.0: the address, the type tags and the arguments, each padded to four
 * bytes. Only what a sound desk, QLab or a lighting desk is sent in practice:
 * `i`, `f`, `s`, `T` and `F`. UDP only — OSC over TCP is framed two ways
 * (length-prefixed in 1.0, SLIP in 1.1) and nothing this is for needs it yet.
 *
 * ## Art-Net
 *
 * Art-Net 4, `ArtDmx` (OpCode 0x5000) to UDP 6454. The 15-bit Port-Address is
 * Net (7 bits), Sub-Net (4) and Universe (4); `0:0:1` and `1` are the same
 * universe. Sequence counts 1 to 255 and never 0, which means "no
 * sequencing" to a receiver.
 *
 * ## sACN
 *
 * ANSI E1.31: a root layer, a framing layer and a DMP layer, 638 bytes for a
 * full universe. Priority is per source and per **universe**: a source at 150
 * wins every channel of the universe over a desk at 100, not only the ones it
 * has set. The stream-terminated option bit tells a receiver to drop this
 * source at once rather than wait out its 2.5 s timeout, which is what makes
 * a release a real hand-back to the desk.
 *
 * ## MIDI
 *
 * Channel messages, and MIDI Show Control (MSC) — the sysex lighting desks,
 * QLab and show controllers answer `GO 45` in. Channels are 1–16 as a person
 * counts them; the status byte carries 0–15.
 */

import { MSC_COMMANDS, MSC_FORMATS } from './core.js';

export { ARTNET_PORT, SACN_PORT } from './core.js';

/* ------------------------------------------------------------------ OSC */

const pad4 = (n) => (n + 3) & ~3;

function oscString(s) {
  const raw = Buffer.from(String(s), 'utf8');
  const out = Buffer.alloc(pad4(raw.length + 1));
  raw.copy(out);
  return out;
}

/**
 * One OSC message. `args` are `{ type, value }`, type one of `i f s T F`.
 */
export function encodeOsc(address, args = []) {
  if (typeof address !== 'string' || !address.startsWith('/')) throw new Error('an OSC address starts with /');
  const tags = [','];
  const parts = [];
  for (const a of args) {
    switch (a.type) {
      case 'i': { const b = Buffer.alloc(4); b.writeInt32BE(a.value | 0); tags.push('i'); parts.push(b); break; }
      case 'f': { const b = Buffer.alloc(4); b.writeFloatBE(Number(a.value)); tags.push('f'); parts.push(b); break; }
      case 's': tags.push('s'); parts.push(oscString(a.value)); break;
      case 'T': tags.push('T'); break;
      case 'F': tags.push('F'); break;
      default: throw new Error(`no OSC type "${a.type}"`);
    }
  }
  return Buffer.concat([oscString(address), oscString(tags.join('')), ...parts]);
}

/* ------------------------------------------------------------------ DMX */

export const DMX_SLOTS = 512;

/** Art-Net `ArtDmx`: a whole universe, 512 slots. */
export function encodeArtDmx({ universe, sequence, data }) {
  const out = Buffer.alloc(18 + DMX_SLOTS);
  out.write('Art-Net\0', 0, 'latin1');
  out.writeUInt16LE(0x5000, 8);   /* OpCode, low byte first — the one field that is */
  out.writeUInt16BE(14, 10);      /* ProtVer */
  out[12] = sequence & 0xff;
  out[13] = 0;                    /* Physical: informational */
  out[14] = universe & 0xff;      /* SubUni */
  out[15] = (universe >> 8) & 0x7f; /* Net */
  out.writeUInt16BE(DMX_SLOTS, 16);
  Buffer.from(data).copy(out, 18, 0, DMX_SLOTS);
  return out;
}

const ACN_ID = Buffer.from('ASC-E1.17\0\0\0', 'latin1');
export const SACN_TERMINATED = 0x40;

/** sACN (E1.31) data packet: a whole universe, 512 slots, start code 0. */
export function encodeSacn({ universe, sequence, data, priority = 100, cid, source = 'LivePremier Plus', options = 0 }) {
  const out = Buffer.alloc(638);
  /* Root layer */
  out.writeUInt16BE(0x0010, 0);
  out.writeUInt16BE(0x0000, 2);
  ACN_ID.copy(out, 4);
  out.writeUInt16BE(0x7000 | (638 - 16), 16);
  out.writeUInt32BE(0x00000004, 18);
  Buffer.from(cid).copy(out, 22, 0, 16);
  /* Framing layer */
  out.writeUInt16BE(0x7000 | (638 - 38), 38);
  out.writeUInt32BE(0x00000002, 40);
  Buffer.from(String(source).slice(0, 63), 'utf8').copy(out, 44, 0, 63);
  out[108] = Math.max(0, Math.min(200, priority | 0));
  out.writeUInt16BE(0, 109);      /* no synchronisation */
  out[111] = sequence & 0xff;
  out[112] = options & 0xff;
  out.writeUInt16BE(universe, 113);
  /* DMP layer */
  out.writeUInt16BE(0x7000 | (638 - 115), 115);
  out[117] = 0x02;
  out[118] = 0xa1;
  out.writeUInt16BE(0x0000, 119);
  out.writeUInt16BE(0x0001, 121);
  out.writeUInt16BE(DMX_SLOTS + 1, 123);
  out[125] = 0x00;                /* DMX start code */
  Buffer.from(data).copy(out, 126, 0, DMX_SLOTS);
  return out;
}

/** The multicast group an sACN universe is sent to with no address given. */
export const sacnMulticast = (universe) => `239.255.${(universe >> 8) & 0xff}.${universe & 0xff}`;

/* ------------------------------------------------------------------ MIDI */

const byte7 = (n, what) => {
  if (!Number.isInteger(n) || n < 0 || n > 127) throw new Error(`${what} is 0–127`);
  return n;
};
const channel = (ch) => {
  if (!Number.isInteger(ch) || ch < 1 || ch > 16) throw new Error('a MIDI channel is 1–16');
  return ch - 1;
};

export const noteOn = (ch, note, vel) => Buffer.from([0x90 | channel(ch), byte7(note, 'a note'), byte7(vel, 'a velocity')]);
export const noteOff = (ch, note, vel = 0) => Buffer.from([0x80 | channel(ch), byte7(note, 'a note'), byte7(vel, 'a velocity')]);
export const controlChange = (ch, cc, value) => Buffer.from([0xb0 | channel(ch), byte7(cc, 'a controller'), byte7(value, 'a value')]);
export const programChange = (ch, program) => Buffer.from([0xc0 | channel(ch), byte7(program, 'a program')]);

/**
 * One MIDI Show Control message: `F0 7F <device> 02 <format> <command> <data> F7`.
 * A cue number and list are ASCII, digits and one point, the list after a 00.
 */
export function mscMessage({ command, cue = null, list = null, macro = null, device = 0x7f, format = 'all' }) {
  const spec = MSC_COMMANDS[command];
  if (!spec) throw new Error(`no MSC command “${command}”`);
  const fmt = MSC_FORMATS[format];
  if (fmt == null) throw new Error(`no MSC format “${format}”`);
  const data = [];
  if (spec.macro) {
    data.push(byte7(macro, 'a macro number'));
  } else if (cue != null && cue !== '') {
    const number = String(cue);
    if (!/^\d+(\.\d+)?$/.test(number)) throw new Error(`“${number}” is not a cue number`);
    data.push(...Buffer.from(number, 'latin1'));
    if (list != null && list !== '') {
      if (!/^\d+(\.\d+)?$/.test(String(list))) throw new Error(`“${list}” is not a cue list`);
      data.push(0, ...Buffer.from(String(list), 'latin1'));
    }
  } else if (spec.cue === true) {
    throw new Error(`MSC ${command} needs a cue number`);
  }
  return Buffer.from([0xf0, 0x7f, byte7(device, 'an MSC device'), 0x02, fmt, spec.code, ...data, 0xf7]);
}

/** Raw bytes as typed: `F0 7F 01 02 01 01 F7`, hex, spaces optional between pairs. */
export function hexBytes(text) {
  const s = String(text).replace(/\s+/g, '');
  if (!s || s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error(`“${text}” is not hex bytes`);
  return Buffer.from(s, 'hex');
}
