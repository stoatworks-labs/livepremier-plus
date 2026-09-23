/*
 * The DaVinci Resolve Speed Editor's USB/Bluetooth HID protocol.
 *
 * Bytes only: no device handle, no transport. A host gives `authenticate` a
 * way to send and read feature reports, feeds input reports to
 * `decodeReport`, and writes whatever the `*Report` builders return. Every
 * report here, in and out, is a Uint8Array whose first byte is the report ID.
 *
 * Blackmagic has never published any of this. It comes from Sylvain Munaut's
 * reverse engineering (github.com/smunaut/blackmagic-misc, bmd.py, Apache-2.0)
 * and the key and LED tables from Julian Waller's node-blackmagic-controller
 * (MIT), which is what Bitfocus Companion drives the panel with. See
 * ATTRIBUTIONS.md.
 */

export const VENDOR_ID = 0x1edb;
export const PRODUCT_ID = 0xda0e;

/* Report IDs. Input and output reports are separate namespaces, so 3 and 4
   mean different things in each direction. */
export const REPORT = {
  AUTH: 0x06,       // feature, both ways
  IN_JOG: 0x03,     // input: jog mode + signed 32-bit value
  IN_KEYS: 0x04,    // input: up to six held key codes
  IN_BATTERY: 0x07, // input: charging flag + level
  OUT_LEDS: 0x02,   // output: LE32 bitfield, one bit per lit key
  OUT_JOG_MODE: 0x03,
  OUT_JOG_LEDS: 0x04 // output: three bits, JOG / SHTL / SCRL
};

/*
 * Every key: its name, the code it reports, and where its lamp is. `led` is a
 * bit in the main LED report; `jogLed` a bit in the jog-mode one. Most keys
 * have no lamp at all.
 */
export const KEYS = [
  { name: 'smart-insert', label: 'SMART INSRT', code: 0x01 },
  { name: 'append', label: 'APPND', code: 0x02 },
  { name: 'ripple-owr', label: 'RIPL O/WR', code: 0x03 },
  { name: 'close-up', label: 'CLOSE UP', code: 0x04, led: 0 },
  { name: 'place-on-top', label: 'PLACE ON TOP', code: 0x05 },
  { name: 'src-owr', label: 'SRC O/WR', code: 0x06 },
  { name: 'in', label: 'IN', code: 0x07 },
  { name: 'out', label: 'OUT', code: 0x08 },
  { name: 'trim-in', label: 'TRIM IN', code: 0x09 },
  { name: 'trim-out', label: 'TRIM OUT', code: 0x0a },
  { name: 'roll', label: 'ROLL', code: 0x0b },
  { name: 'slip-src', label: 'SLIP SRC', code: 0x0c },
  { name: 'slip-dest', label: 'SLIP DEST', code: 0x0d },
  { name: 'trans-dur', label: 'TRANS DUR', code: 0x0e },
  { name: 'cut', label: 'CUT', code: 0x0f, led: 1 },
  { name: 'dis', label: 'DIS', code: 0x10, led: 2 },
  { name: 'smth-cut', label: 'SMTH CUT', code: 0x11, led: 3 },
  { name: 'source', label: 'SOURCE', code: 0x1a },
  { name: 'timeline', label: 'TIMELINE', code: 0x1b },
  { name: 'shtl', label: 'SHTL', code: 0x1c, jogLed: 1 },
  { name: 'jog', label: 'JOG', code: 0x1d, jogLed: 0 },
  { name: 'scrl', label: 'SCRL', code: 0x1e, jogLed: 2 },
  { name: 'sync-bin', label: 'SYNC BIN', code: 0x1f },
  { name: 'trans', label: 'TRANS', code: 0x22, led: 4 },
  { name: 'video-only', label: 'VIDEO ONLY', code: 0x25, led: 13 },
  { name: 'audio-only', label: 'AUDIO ONLY', code: 0x26, led: 17 },
  { name: 'ripl-del', label: 'RIPL DEL', code: 0x2b },
  { name: 'audio-level', label: 'AUDIO LEVEL', code: 0x2c },
  { name: 'full-view', label: 'FULL VIEW', code: 0x2d },
  { name: 'snap', label: 'SNAP', code: 0x2e, led: 5 },
  { name: 'split', label: 'SPLIT', code: 0x2f },
  { name: 'live-owr', label: 'LIVE O/WR', code: 0x30, led: 9 },
  { name: 'esc', label: 'ESC', code: 0x31 },
  { name: 'cam1', label: 'CAM 1', code: 0x33, led: 14 },
  { name: 'cam2', label: 'CAM 2', code: 0x34, led: 15 },
  { name: 'cam3', label: 'CAM 3', code: 0x35, led: 16 },
  { name: 'cam4', label: 'CAM 4', code: 0x36, led: 10 },
  { name: 'cam5', label: 'CAM 5', code: 0x37, led: 11 },
  { name: 'cam6', label: 'CAM 6', code: 0x38, led: 12 },
  { name: 'cam7', label: 'CAM 7', code: 0x39, led: 6 },
  { name: 'cam8', label: 'CAM 8', code: 0x3a, led: 7 },
  { name: 'cam9', label: 'CAM 9', code: 0x3b, led: 8 },
  { name: 'stop-play', label: 'STOP/PLAY', code: 0x3c }
];

export const KEY_BY_CODE = new Map(KEYS.map((k) => [k.code, k]));
export const KEY_BY_NAME = new Map(KEYS.map((k) => [k.name, k]));

/*
 * What the wheel reports, set by the host with `jogModeReport`. The three
 * mode keys do NOT change this on their own — they are ordinary keys, and
 * which mode the wheel is in is whatever the host last asked for.
 *
 *   RELATIVE      each report is the movement since the last one
 *   ABSOLUTE      position since the mode was set, about -4096..4096 for
 *                 half a turn either way
 *   ABSOLUTE_ZERO the same with a small dead band around zero
 */
export const JOG_MODE = { RELATIVE: 0, ABSOLUTE: 1, RELATIVE_2: 2, ABSOLUTE_ZERO: 3 };

/* ------------------------------------------------------------------ auth */

/*
 * The panel sends no input reports at all until the host has answered its
 * challenge, and stops again when the answer expires — `authenticate`
 * resolves with the number of seconds until then, and the host must run it
 * again before that. The panel also offers to authenticate itself to the
 * host; nothing here checks its answer, as nothing is gained by doing so.
 */

const MASK64 = 0xffffffffffffffffn;
const rol8 = (v) => ((v << 56n) | (v >> 8n)) & MASK64;
const rol8n = (v, n) => { for (let i = 0; i < n; i++) v = rol8(v); return v; };

const AUTH_EVEN = [
  0x3ae1206f97c10bc8n, 0x2a9ab32bebf244c6n, 0x20a6f8b8df9adf0an, 0xaf80ece52cfc1719n,
  0xec2ee2f7414fd151n, 0xb055adfd73344a15n, 0xa63d2e3059001187n, 0x751bf623f42e0dden
];
const AUTH_ODD = [
  0x3e22b34f502e7fden, 0x24656b981875ab1cn, 0xa17f3456df7bf8c3n, 0x6df72e1941aef698n,
  0x72226f011e66ab94n, 0x3831a3c606296b42n, 0xfd7ff81881332c89n, 0x61a3f6474ff236c6n
];
const AUTH_MASK = 0xa79a63f585d37bf0n;

/** The host's answer to the panel's 64-bit challenge. */
export function authResponse(challenge) {
  const n = Number(challenge & 7n);
  let v = rol8n(challenge, n);
  let k;
  if ((v & 1n) === (BigInt(0x78 >> n) & 1n)) {
    k = AUTH_EVEN[n];
  } else {
    v ^= rol8(v);
    k = AUTH_ODD[n];
  }
  return v ^ (rol8(v) & AUTH_MASK) ^ k;
}

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
 * @param io.getFeature(id, length)   read one, id in byte 0 of what it returns
 * @returns seconds until the panel wants it done again
 */
export async function authenticate(io) {
  await io.sendFeature(authPacket(0));                  // reset the state machine
  const challenge = await io.getFeature(REPORT.AUTH, 10);
  await io.sendFeature(authPacket(1));                  // our challenge to it
  await io.getFeature(REPORT.AUTH, 10);                 // its answer, unchecked
  await io.sendFeature(authPacket(3, authResponse(readU64(challenge, 2))));
  const status = await io.getFeature(REPORT.AUTH, 10);
  if (status[1] !== 0x04) throw new Error('Speed Editor refused the authentication');
  return status[2] | (status[3] << 8);
}

/* ---------------------------------------------------------------- input */

/**
 * Decode one input report.
 *
 *   {type:'keys', codes:[…]}           every key held now (the panel sends the
 *                                      whole set on each change, never deltas)
 *   {type:'jog', mode, value}          see JOG_MODE for what value means
 *   {type:'battery', charging, level}  level 0..100
 *   null                               anything else
 */
export function decodeReport(bytes) {
  if (!bytes?.length) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (bytes[0]) {
    case REPORT.IN_KEYS: {
      const codes = [];
      for (let at = 1; at + 1 < bytes.length; at += 2) {
        const code = view.getUint16(at, true);
        if (code) codes.push(code);
      }
      return { type: 'keys', codes };
    }
    case REPORT.IN_JOG:
      if (bytes.length < 6) return null;
      return { type: 'jog', mode: bytes[1], value: view.getInt32(2, true) };
    case REPORT.IN_BATTERY:
      if (bytes.length < 3) return null;
      return { type: 'battery', charging: bytes[1] !== 0, level: bytes[2] };
    default:
      return null;
  }
}

/* --------------------------------------------------------------- output */

/** Light the keys whose LED bits are set in `bits`. */
export function ledReport(bits) {
  const out = new Uint8Array(5);
  out[0] = REPORT.OUT_LEDS;
  new DataView(out.buffer).setUint32(1, bits >>> 0, true);
  return out;
}

/** Light the JOG / SHTL / SCRL keys: bit 0, 1, 2. */
export function jogLedReport(bits) {
  return Uint8Array.of(REPORT.OUT_JOG_LEDS, bits & 0x07);
}

/** Put the wheel in a JOG_MODE. The trailing 0xff is what bmd.py sends. */
export function jogModeReport(mode) {
  return Uint8Array.of(REPORT.OUT_JOG_MODE, mode, 0, 0, 0, 0, 0xff);
}
