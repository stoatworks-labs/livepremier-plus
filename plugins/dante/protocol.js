/*
 * Dante — the control protocol, as bytes. No I/O, no DOM, no Node built-ins:
 * request builders and response parsers over `Uint8Array` (a Node `Buffer`
 * is one), so the server half, the simulator and the tests all use the same
 * tables.
 *
 * ## Where every table here comes from
 *
 * Audinate publishes nothing about this protocol. Everything below is a port
 * of the reverse engineering in **netaudio** — Christopher Ritsen's
 * network-audio-controller, <https://github.com/chris-ritsen/network-audio-controller>,
 * released into the public domain under the Unlicense — read at commit
 * `a3323a3f57830550bdc9c8ccf6e6ce358a518f43` (2026-10-02). Its protocol code
 * now lives in a Rust core, `packages/netaudio-core/src/`; each table below
 * names the file and function it was ported from, so a correction upstream is
 * one diff to read. Nothing here was worked out against a device by us.
 *
 * What counts as evidence, and what does not, is in `docs/DANTE.md`. In
 * short: netaudio keeps some packets that **Dante Controller itself** sent and
 * received, captured off a real network, and `test/dante.test.js` holds this
 * codec to those bytes. Those are independent of this file. The simulator,
 * `tools/dante-sim.mjs`, is built from this file and proves only that the
 * pieces fit together.
 *
 * ## The shape of a packet
 *
 * Every ARC request is eight bytes of header and a payload, every number
 * big-endian (`protocol.rs`, `frame_packet`):
 *
 *   u16 protocol id   u16 total length   u16 transaction id   u16 opcode   payload…
 *
 * A response repeats the protocol, length, transaction and opcode, then a u16
 * result code, then its body (`protocol.rs`, `response_envelope`; 10 bytes of
 * header). Strings live after the fixed records and are reached by u16
 * pointers that count **from the start of the packet**, not the body — the one
 * thing about this protocol that is easy to get wrong and look right.
 *
 * ## Two generations
 *
 * A device says which ARC revision it speaks in its `_netaudio-arc._udp` TXT
 * record (`arcp_vers`, e.g. `2.7.41`), and the revision **is** the protocol id:
 * `2.7.41` is `0x2729`, `2.8.9` is `0x2809` (`protocol.rs`, `arc_protocol`).
 * From `0x2809` on, the channel inventory and the subscription write are
 * different operations with a different layout (netaudio calls them "modern
 * ARC"); before it, the classic ones netaudio has used since 2021. Both are
 * here, and `arcProtocol()` chooses.
 */

/* ------------------------------------------------------------ constants */

/** Protocol ids — `protocol.rs`, `enum NetaudioProtocol`. */
export const PROTOCOL = Object.freeze({
  ARC: 0x27FF,        // the classic default every query is sent under
  ARC_2729: 0x2729,   // arcp 2.7.41
  ARC_2801: 0x2801,
  ARC_2809: 0x2809,   // arcp 2.8.9, the first "modern" revision
  ARC_280C: 0x280C,
  ARC_280F: 0x280F,
});

/** `protocol.rs`, `MODERN_ARC_PROTOCOL_IDS`. */
export const MODERN = Object.freeze([PROTOCOL.ARC_2809, PROTOCOL.ARC_280C, PROTOCOL.ARC_280F]);
/** `protocol.rs`, `COMMON_ARC_PROTOCOL_IDS` — what a classic response may come back under. */
export const COMMON = Object.freeze([PROTOCOL.ARC, PROTOCOL.ARC_2729, PROTOCOL.ARC_2809]);
/** `protocol.rs`, `DEVICE_SETTINGS_ARC_PROTOCOL_IDS`. */
const SETTINGS_PROTOCOLS = Object.freeze([PROTOCOL.ARC, PROTOCOL.ARC_2729, PROTOCOL.ARC_2801, PROTOCOL.ARC_2809]);

/** UDP ports — `protocol.rs`, `enum NetaudioPort`. Only ARC is used here. */
export const PORT = Object.freeze({ ARC: 4440, ARC_SECONDARY: 4455, SETTINGS: 8700, INFO: 8702, CONTROL: 8800 });

/** DNS-SD service types — `protocol.rs`. */
export const SERVICE = Object.freeze({
  ARC: '_netaudio-arc._udp.local',
  CHAN: '_netaudio-chan._udp.local',
  CMC: '_netaudio-cmc._udp.local',
  DBC: '_netaudio-dbc._udp.local',
});

/** Opcodes — `protocol.rs` and `commands/mod.rs`. */
export const OPCODE = Object.freeze({
  CHANNEL_COUNT: 0x1000,
  DEVICE_NAME: 0x1002,
  DEVICE_SETTINGS: 0x1100,
  TX_CHANNELS: 0x2000,
  TX_CHANNEL_NAMES: 0x2010,
  RX_CHANNELS: 0x3000,
  SUBSCRIPTION_ADD: 0x3010,
  SUBSCRIPTION_REMOVE: 0x3014,
  /* modern ARC only */
  TX_CHANNEL_STATUS: 0x2400,
  RX_CHANNEL_STATUS: 0x3400,
  SUBSCRIPTION_PAGE: 0x3410,
});

/** Result codes — `protocol.rs`, `enum NetaudioResultCode`. */
export const RESULT = Object.freeze({
  REQUEST: 0x0000,
  SUCCESS: 0x0001,
  ERROR: 0x0022,
  FRONTEND_UNAVAILABLE: 0x0030,
  MORE_PAGES: 0x8112,
});

export const REQUEST_HEADER = 8;
export const RESPONSE_HEADER = 10;
/** `protocol.rs`, `DANTE_NAME_MAX_LENGTH`. */
export const NAME_MAX = 31;

/** Records per classic inventory page — `parser.rs`. */
export const RX_PER_PAGE = 16;
export const TX_PER_PAGE = 32;
const RX_RECORD = 20;
const TX_RECORD = 8;
const TX_NAME_RECORD = 6;

/** Media type codes — `responses/mod.rs`, `MEDIA_TYPE_*`. */
export const MEDIA = Object.freeze({ AUDIO: 3, VIDEO: 4, ANCILLARY: 5 });

/* -------------------------------------------------------------- bytes */

const enc = new TextEncoder();
/* `bytes.rs`, `string_at_pointer`: a name that is not valid UTF-8 is no name. */
const dec = new TextDecoder('utf-8', { fatal: true });

export const u16 = (b, at) => (at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : null);
export const u32 = (b, at) => (at + 4 <= b.length ? ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) : null);

function put16(out, v) { out.push((v >>> 8) & 0xff, v & 0xff); }
function put32(out, v) { out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); }

/** `bytes.rs`, `string_at_pointer`: null-terminated, at an absolute offset; 0 is "none". */
export function stringAt(b, pointer) {
  if (!pointer || pointer >= b.length) return null;
  const end = b.indexOf(0, pointer);
  if (end < 0) return null;
  try { return dec.decode(b.subarray(pointer, end)); } catch { return null; }
}

/** Lower-case hex, for logs and tests. */
export const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (s) => Uint8Array.from(String(s).match(/../g) || [], (x) => parseInt(x, 16));

/* ---------------------------------------------------------- framing */

/** `protocol.rs`, `frame_packet` / `build_control_packet_for_protocol`. */
export function frame(protocolId, transactionId, opcode, payload = []) {
  const length = REQUEST_HEADER + payload.length;
  if (length > 0xffff) throw new Error('packet exceeds the protocol length limit');
  const out = [];
  put16(out, protocolId);
  put16(out, length);
  put16(out, transactionId);
  put16(out, opcode);
  return Uint8Array.from([...out, ...payload]);
}

/**
 * A response's header, or null when the declared length is not the length
 * received — `protocol.rs`, `response_envelope`.
 */
export function envelope(b) {
  if (!b || b.length < RESPONSE_HEADER || u16(b, 2) !== b.length) return null;
  return {
    protocolId: u16(b, 0),
    transactionId: u16(b, 4),
    opcode: u16(b, 6),
    result: u16(b, 8),
    body: b.subarray(RESPONSE_HEADER),
  };
}

/** The transaction id a request or response carries (bytes 4–5). */
export const transactionOf = (b) => u16(b, 4);

/** `protocol.rs`, `validate_response_envelope`. */
function expect(b, protocols, opcode, results) {
  const e = envelope(b);
  if (!e || !protocols.includes(e.protocolId) || e.opcode !== opcode || !results.includes(e.result)) return null;
  return e;
}

/* ------------------------------------------------------ the revision */

/**
 * The protocol a device speaks, from its `arcp_vers` TXT value —
 * `protocol.rs`, `arc_protocol` and `arc_protocol_for_identifier`: the
 * version's three parts packed as nibble.nibble.byte, capped at `0x280F`.
 * Null when the device did not say (a device added by address), and an
 * `{ error }` for a version netaudio refuses.
 */
export function arcProtocol(version) {
  if (version == null || version === '') return null;
  const parts = String(version).split('.');
  if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) return { error: 'unsupported ARC protocol version' };
  const [major, minor, patch] = parts.map(Number);
  if (major > 15 || minor > 15 || patch > 255) return { error: 'unsupported ARC protocol version' };
  const id = Math.min((major << 12) | (minor << 8) | patch, PROTOCOL.ARC_280F);
  const modern = MODERN.includes(id);
  if (!modern && !SETTINGS_PROTOCOLS.includes(id)) return { error: `unsupported ARC protocol 0x${id.toString(16)}` };
  return { protocolId: id, modern, version: String(version) };
}

/* ------------------------------------------------------------ names */

/**
 * `protocol.rs`, `validate_dante_name`: 1–31 ASCII letters, digits and
 * hyphens, not starting or ending with a hyphen. A device name.
 */
export function deviceNameProblem(name) {
  const s = String(name ?? '');
  if (s.length > NAME_MAX) return 'a Dante device name is at most 31 characters';
  if (!/^[A-Za-z0-9-]+$/.test(s)) return 'a Dante device name is letters, digits and hyphens';
  if (s.startsWith('-') || s.endsWith('-')) return 'a Dante device name cannot begin or end with a hyphen';
  return null;
}

/**
 * `protocol.rs`, `validate_dante_channel_reference`: how a subscription
 * names a transmitter channel — 1–31 printable ASCII characters or spaces.
 */
export function channelReferenceProblem(name) {
  const s = String(name ?? '');
  if (s.length > NAME_MAX) return 'a Dante channel name is at most 31 characters';
  if (!s.length || !/^[\x20-\x7e]+$/.test(s)) return 'a Dante channel name is printable ASCII';
  return null;
}

/* ------------------------------------------------- classic requests */

/** `commands/mod.rs`, `channel_query_payload`. */
function channelQuery(start, end = 0) {
  const p = [0, 0, 0, 1];
  put16(p, start);
  put16(p, end);
  return p;
}

/** `commands/device.rs`, `build_device_name`: always under 0x27FF. */
export const buildDeviceName = (txn) => frame(PROTOCOL.ARC, txn, OPCODE.DEVICE_NAME, [0, 0]);
/** `commands/device.rs`, `build_channel_count`. */
export const buildChannelCount = (txn) => frame(PROTOCOL.ARC, txn, OPCODE.CHANNEL_COUNT, [0, 0]);
/** `commands/device.rs`, `build_device_settings` — sample rate and latency. */
export const buildDeviceSettings = (txn) => frame(PROTOCOL.ARC, txn, OPCODE.DEVICE_SETTINGS, [0, 0]);

/** `commands/device.rs`, `build_receivers`: page 0 starts at channel 1, 16 a page. */
export function buildReceivers(page, txn) {
  return frame(PROTOCOL.ARC, txn, OPCODE.RX_CHANNELS, channelQuery(page * RX_PER_PAGE + 1));
}

/** `commands/device.rs`, `build_transmitters`: 32 a page. */
export function buildTransmitters(page, txn) {
  return frame(PROTOCOL.ARC, txn, OPCODE.TX_CHANNELS, channelQuery(page * TX_PER_PAGE + 1));
}

/** `commands/device.rs`, `build_transmitter_names`: one request for channels 1..count. */
export function buildTransmitterNames(count, txn) {
  if (!(count > 0)) throw new Error('no transmitter channels to name');
  return frame(PROTOCOL.ARC, txn, OPCODE.TX_CHANNEL_NAMES, channelQuery(1, count));
}

/* ------------------------------------------------ classic responses */

/** `responses/device.rs`, `parse_device_name`: the body is the name and its NUL. */
export function parseDeviceName(b) {
  const e = expect(b, COMMON, OPCODE.DEVICE_NAME, [RESULT.SUCCESS]);
  if (!e || !e.body.length || e.body[e.body.length - 1] !== 0) return null;
  const name = e.body.subarray(0, e.body.length - 1);
  if (name.includes(0)) return null;
  try { return dec.decode(name); } catch { return null; }
}

/** `parser.rs`, `parse_channel_count`: tx at offset 12, rx at 14. */
export function parseChannelCount(b) {
  if (!expect(b, COMMON, OPCODE.CHANNEL_COUNT, [RESULT.SUCCESS]) || b.length < 16) return null;
  return { tx: u16(b, 12), rx: u16(b, 14), capabilities: u16(b, 10) };
}

/** Info codes — `responses/mod.rs`, `DEVICE_SETTINGS_INFO_*`. */
const SETTING = Object.freeze({
  SAMPLE_RATE: 0x8020,
  DEFAULT_LATENCY_NS: 0x8204,
  CONFIGURED_LATENCY_NS: 0x8205,
  ACTIVE_LATENCY_NS: 0x8301,
  MAX_LATENCY_NS: 0x8302,
  MIN_LATENCY_NS: 0x8306,
});
export { SETTING as SETTING_CODES };

/**
 * `responses/device.rs`, `parse_device_settings`: a count at body byte 1, then
 * that many `(info code, value)` u16 pairs. A code with its top bit set
 * carries a pointer to a u32 rather than a value.
 */
export function parseDeviceSettings(b) {
  const e = expect(b, SETTINGS_PROTOCOLS, OPCODE.DEVICE_SETTINGS, [RESULT.SUCCESS]);
  if (!e || e.body.length < 2) return null;
  const count = e.body[1];
  if (e.body.length < 2 + count * 4) return null;
  const minimum = RESPONSE_HEADER + 2 + count * 4;
  const seen = new Set();
  const out = {};
  for (let i = 0; i < count; i++) {
    const code = u16(e.body, 2 + i * 4);
    const value = u16(e.body, 4 + i * 4);
    if (code === 0) continue;               // a property the device does not have
    if (seen.has(code)) return null;
    seen.add(code);
    if (!(code & 0x8000)) continue;
    if (value < minimum) return null;
    const v = u32(b, value);
    if (v == null) return null;
    if (code === SETTING.SAMPLE_RATE) out.sampleRate = v;
    else if (code === SETTING.CONFIGURED_LATENCY_NS) out.latencyNs = v;
    else if (code === SETTING.ACTIVE_LATENCY_NS) out.activeLatencyNs = v;
    else if (code === SETTING.DEFAULT_LATENCY_NS) out.defaultLatencyNs = v;
    else if (code === SETTING.MIN_LATENCY_NS) out.minLatencyNs = v;
    else if (code === SETTING.MAX_LATENCY_NS) out.maxLatencyNs = v;
  }
  return out;
}

/** `parser.rs`, `pointed_string` — a string below the records is a lie. */
const pointed = (b, pointer, minimum) => (pointer >= minimum ? stringAt(b, pointer) : null);

/**
 * One page of receive channels — `parser.rs`, `parse_rx_page`.
 *
 * Body: `[max records, count]`, then 20-byte records:
 *
 *   +0 channel  +2 flags  +4 format pointer  +6 tx channel ptr  +8 tx device ptr
 *   +10 rx name ptr  +12 rx status  +14 subscription status  (+16..19 unused here)
 *
 * A channel with no subscription has both tx pointers 0. Returns null for a
 * page that does not hold together — a gap, a wrong channel number, a pointer
 * into the records — rather than a partial answer.
 */
export function parseRxPage(b, start) {
  const e = expect(b, COMMON, OPCODE.RX_CHANNELS, [RESULT.SUCCESS, RESULT.MORE_PAGES]);
  if (!e || e.body.length < 2) return null;
  const max = e.body[0];
  const count = e.body[1];
  if (max > RX_PER_PAGE || count > max) return null;
  if (count === 0) {
    /* A final page may be empty, or padded to its capacity with zeros —
       never anything else. */
    if (e.result !== RESULT.SUCCESS) return null;
    if (max === 0) return e.body.length === 2 ? [] : null;
    return e.body.length === 2 + max * RX_RECORD && e.body.subarray(2).every((x) => x === 0) ? [] : null;
  }
  if (max !== count) return null;
  if (e.result === RESULT.MORE_PAGES && count !== RX_PER_PAGE) return null;
  const recordsEnd = 2 + count * RX_RECORD;
  if (e.body.length < recordsEnd) return null;
  const minimum = RESPONSE_HEADER + recordsEnd;
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = RESPONSE_HEADER + 2 + i * RX_RECORD;
    const number = u16(b, at);
    if (number !== start + i) return null;
    const txChannelPtr = u16(b, at + 6);
    const txDevicePtr = u16(b, at + 8);
    const label = pointed(b, u16(b, at + 10), minimum);
    if (label == null) return null;
    const txChannel = txChannelPtr ? pointed(b, txChannelPtr, minimum) : null;
    const txDevice = txDevicePtr ? pointed(b, txDevicePtr, minimum) : null;
    if ((txChannelPtr && txChannel == null) || (txDevicePtr && txDevice == null)) return null;
    out.push({
      number,
      label,
      flags: u16(b, at + 2),
      txChannel,
      txDevice,
      rxStatus: u16(b, at + 12),
      status: u16(b, at + 14),
    });
  }
  return out;
}

/**
 * One page of transmit channels — `parser.rs`, `parse_tx_info_page`.
 *
 * Two shapes. Usually `[max, count]` then 8-byte records
 * `+0 channel +2 ? +4 format pointer +6 name pointer`; a device that lists a
 * channel at more than one sample rate repeats it under a second format
 * pointer after the first group, and only the first group counts. The other
 * shape starts `[0, 0]` and ends its records with a zero channel number.
 */
export function parseTxPage(b, start) {
  const e = expect(b, COMMON, OPCODE.TX_CHANNELS, [RESULT.SUCCESS, RESULT.MORE_PAGES]);
  if (!e || e.body.length < 2) return null;
  const body = e.body;
  const out = [];
  if (body[0] === 0 && body[1] === 0) {
    if (body.length === 2 || (body.length === 6 && body[2] === 0 && body[3] === 0)) {
      return e.result === RESULT.SUCCESS ? [] : null;
    }
    const pointers = [];
    let minimumName = Infinity;
    let firstFormat = null;
    let terminated = false;
    for (let i = 0; i < TX_PER_PAGE; i++) {
      const at = RESPONSE_HEADER + 2 + i * TX_RECORD;
      if (at + TX_RECORD > b.length) return null;
      const number = u16(b, at);
      if (number === 0) { terminated = true; break; }
      if (number !== start + i) return null;
      const format = u16(b, at + 4);
      if (firstFormat == null) firstFormat = format;
      else if (format !== firstFormat) return null;
      const namePtr = u16(b, at + 6);
      if (!namePtr || namePtr >= b.length) return null;
      minimumName = Math.min(minimumName, namePtr);
      pointers.push(namePtr);
      out.push({ number });
    }
    if (!out.length || (!terminated && out.length < TX_PER_PAGE)) return null;
    if (e.result === RESULT.MORE_PAGES && out.length !== TX_PER_PAGE) return null;
    const recordsEnd = RESPONSE_HEADER + 2 + out.length * TX_RECORD;
    if (minimumName < recordsEnd) return null;
    /* The zero record is four bytes long and the names start right after it. */
    if (terminated && minimumName - recordsEnd !== 4) return null;
    for (let i = 0; i < out.length; i++) {
      const name = pointed(b, pointers[i], minimumName);
      if (name == null) return null;
      out[i].name = name;
    }
    return out;
  }
  const max = body[0];
  const count = body[1];
  if (max > TX_PER_PAGE || count > max) return null;
  if (e.result === RESULT.MORE_PAGES && (max === 0 || count !== max)) return null;
  if (count === 0) return e.result === RESULT.SUCCESS && body.length === 2 ? [] : null;
  const recordsEnd = 2 + count * TX_RECORD;
  const primaryFormat = RESPONSE_HEADER + recordsEnd;
  if (b.length < primaryFormat + 16) return null;
  let primaryEnded = false;
  for (let i = 0; i < count; i++) {
    const at = RESPONSE_HEADER + 2 + i * TX_RECORD;
    const number = u16(b, at);
    if (number !== start + i) return null;
    const format = u16(b, at + 4);
    if (format + 16 > b.length) return null;
    const name = pointed(b, u16(b, at + 6), format + 16);
    if (name == null) return null;
    if (format !== primaryFormat) { primaryEnded = true; continue; }
    if (primaryEnded) return null;
    out.push({ number, name });
  }
  return out.length ? out : null;
}

/**
 * Transmit channel labels — `parser.rs`, `parse_tx_friendly_page`. Records are
 * six bytes, `+0 ? +2 channel +4 name pointer`. Like the info page, two
 * shapes: `[max, count]` first, or `[0, 0]` with the record count implied by
 * where the first name begins. Answers `[[number, label], …]`.
 */
export function parseTxNamesPage(b, start = 1) {
  const e = expect(b, COMMON, OPCODE.TX_CHANNEL_NAMES, [RESULT.SUCCESS, RESULT.MORE_PAGES]);
  if (!e || e.body.length < 2) return null;
  const body = e.body;
  const out = [];
  if (body[0] === 0 && body[1] === 0) {
    if (body.length === 2) return e.result === RESULT.SUCCESS ? [] : null;
    if (body.length < 2 + TX_NAME_RECORD) return null;
    if (u16(body, 2 + 2) === 0) return e.result === RESULT.SUCCESS && body.subarray(2).every((x) => x === 0) ? [] : null;
    const firstPtr = u16(body, 2 + 4);
    const recordBytes = firstPtr - (RESPONSE_HEADER + 2);
    if (recordBytes <= 0 || recordBytes % TX_NAME_RECORD) return null;
    const count = recordBytes / TX_NAME_RECORD;
    if (count > TX_PER_PAGE || (e.result === RESULT.MORE_PAGES && count !== TX_PER_PAGE)) return null;
    if (body.length < 2 + recordBytes) return null;
    for (let i = 0; i < count; i++) {
      const at = 2 + i * TX_NAME_RECORD;
      const number = u16(body, at + 2);
      if (number !== start + i) return null;
      const name = pointed(b, u16(body, at + 4), firstPtr);
      if (name == null) return null;
      out.push([number, name]);
    }
    return out;
  }
  const max = body[0];
  const named = body[1];
  if (max > TX_PER_PAGE || named > max) return null;
  if (named === 0) return body.length === 2 + max * TX_RECORD ? [] : null;
  const recordsEnd = 2 + named * TX_NAME_RECORD;
  if (body.length < recordsEnd) return null;
  const minimum = RESPONSE_HEADER + recordsEnd;
  const seen = new Set();
  for (let i = 0; i < named; i++) {
    const at = 2 + i * TX_NAME_RECORD;
    const number = u16(body, at + 2);
    if (!number || seen.has(number)) return null;
    seen.add(number);
    const name = pointed(b, u16(body, at + 4), minimum);
    if (name == null) return null;
    out.push([number, name]);
  }
  return out;
}

/* ------------------------------------------------------ classic writes */

/**
 * Add subscriptions the classic way — `commands/subscriptions.rs`,
 * `build_add_subscriptions`. One to sixteen records, receive channels 1–255:
 *
 *   payload  00 00 02 <count>  then per record  00 <rx> <channel ptr> <device ptr>
 *
 * padded so the strings start no earlier than byte 52, each record carrying
 * its own copy of both names. A device of `"."` means the receiver itself.
 */
export function buildAddSubscriptions(subscriptions, txn) {
  const count = subscriptions.length;
  if (count < 1 || count > LEGACY_BATCH) throw new Error('subscription count must be 1-16');
  const recordBlock = 4 + 6 * count;
  const padding = Math.max(0, 44 - recordBlock);
  const tableAt = REQUEST_HEADER + recordBlock + padding;
  const records = [];
  const strings = [];
  for (const { rx, channel, device } of subscriptions) {
    if (!Number.isInteger(rx) || rx < 1 || rx > 255) throw new Error('a classic subscription names receive channels 1-255');
    checkSource(channel, device);
    const channelPtr = tableAt + strings.length;
    strings.push(...enc.encode(channel), 0);
    const devicePtr = tableAt + strings.length;
    strings.push(...enc.encode(device), 0);
    records.push(0, rx);
    put16(records, channelPtr);
    put16(records, devicePtr);
  }
  return frame(PROTOCOL.ARC, txn, OPCODE.SUBSCRIPTION_ADD, [0, 0, 0x02, count, ...records, ...new Array(padding).fill(0), ...strings]);
}

/** `commands/subscriptions.rs`, `LEGACY_SUBSCRIPTION_BATCH_CAPACITY`. */
export const LEGACY_BATCH = 16;

/**
 * Remove subscriptions the classic way — `commands/subscriptions.rs`,
 * `build_remove_subscriptions`: a u32 count, then each receive channel as a u32.
 */
export function buildRemoveSubscriptions(channels, txn) {
  if (!channels.length) throw new Error('nothing to remove');
  const p = [];
  put32(p, channels.length);
  for (const c of channels) {
    if (!Number.isInteger(c) || c < 1) throw new Error('receive channels count from 1');
    put32(p, c);
  }
  return frame(PROTOCOL.ARC, txn, OPCODE.SUBSCRIPTION_REMOVE, p);
}

function checkSource(channel, device) {
  const c = channelReferenceProblem(channel);
  if (c) throw new Error(c);
  if (device !== '.') {
    const d = deviceNameProblem(device);
    if (d) throw new Error(d);
  }
}

/**
 * Dante Controller's own subscription page for an ARC 2.7.41 device —
 * `commands/subscriptions.rs`, `build_subscription_page_2729`, which netaudio
 * holds byte-for-byte to packets Dante Controller sent (and so do our tests).
 *
 *   payload  00 00 20 <count>  then per record  <rx u16> <channel ptr> <device ptr>
 *
 * The string table always starts at 0x028C (room for 32 records), and equal
 * strings are written once and shared. A record with both pointers 0 clears.
 */
export const PAGE_2729_CAPACITY = 32;
const PAGE_2729_TABLE = 0x028C;
export function buildSubscriptionPage2729(records, txn) {
  if (!records.length || records.length > PAGE_2729_CAPACITY) throw new Error('subscription count must be 1-32');
  const strings = [];
  const offsets = new Map();
  const intern = (s) => {
    if (offsets.has(s)) return offsets.get(s);
    const at = PAGE_2729_TABLE + strings.length;
    strings.push(...enc.encode(s), 0);
    offsets.set(s, at);
    return at;
  };
  const seen = new Set();
  const body = [0, 0, PAGE_2729_CAPACITY, records.length];
  for (const r of records) {
    if (!Number.isInteger(r.rx) || r.rx < 1 || r.rx > 0xffff || seen.has(r.rx)) throw new Error('receive channels must be unique and count from 1');
    seen.add(r.rx);
    put16(body, r.rx);
    if (r.channel == null) { put16(body, 0); put16(body, 0); continue; }
    checkSource(r.channel, r.device);
    put16(body, intern(r.channel));
    put16(body, intern(r.device));
  }
  while (body.length < PAGE_2729_TABLE - REQUEST_HEADER) body.push(0);
  return frame(PROTOCOL.ARC_2729, txn, OPCODE.SUBSCRIPTION_ADD, [...body, ...strings]);
}

/* --------------------------------------------------- modern requests */

/**
 * A modern channel-status query — `commands/flows.rs`,
 * `build_channel_status_query`: a reserved word, then 24 bytes with
 * `0x0001` at 6, the media selector at 8, the first channel id at 10 and the
 * last (0 for "to the end") at 12. Revision 2.8.9 adds a fixed tail.
 */
export function buildChannelStatusQuery(protocolId, receiver, mediaSelector, first, last, txn) {
  if (!MODERN.includes(protocolId) || !mediaSelector || !first || (last && last < first)) throw new Error('not a modern channel query');
  const body = new Array(24).fill(0);
  body[7] = 1;
  body[8] = mediaSelector >> 8; body[9] = mediaSelector & 0xff;
  body[10] = first >> 8; body[11] = first & 0xff;
  body[12] = last >> 8; body[13] = last & 0xff;
  if (protocolId === PROTOCOL.ARC_2809) body.splice(18, 6, 0x83, 0x02, 0x83, 0x06, 0x03, 0x10);
  return frame(protocolId, txn, receiver ? OPCODE.RX_CHANNEL_STATUS : OPCODE.TX_CHANNEL_STATUS, [0, 0, ...body]);
}

/**
 * A modern subscription page — `commands/subscriptions.rs`,
 * `build_modern_arc_subscription_page`, matched in our tests to pages Dante
 * Controller sent an ARC 2.8.9 device:
 *
 *   payload  8 × 00, 08 00, <capacity> <count>,
 *            per record  <rx u16> <media u16> <channel ptr> <device ptr>
 *
 * The strings start at `20 + capacity × 8`. 2.8.9 writes each string anew per
 * record, as the controller does; 2.8.15 shares equal ones. 2.8.9 has no
 * "." shorthand for the receiver itself.
 */
export const PAGE_CAPACITY = 32;
export function buildSubscriptionPage(protocolId, capacity, records, txn, media = MEDIA.AUDIO) {
  if (!MODERN.includes(protocolId) || !(capacity >= 1 && capacity <= PAGE_CAPACITY)
    || !records.length || records.length > capacity || (media !== MEDIA.AUDIO && media !== MEDIA.VIDEO)) {
    throw new Error('not a valid subscription page');
  }
  const tableAt = 20 + capacity * 8;
  const strings = [];
  const offsets = new Map();
  const intern = (s) => {
    if (protocolId === PROTOCOL.ARC_280F && offsets.has(s)) return offsets.get(s);
    const at = tableAt + strings.length;
    strings.push(...enc.encode(s), 0);
    offsets.set(s, at);
    return at;
  };
  const seen = new Set();
  const body = [0, 0, 0, 0, 0, 0, 0, 0, 0x08, 0x00, capacity, records.length];
  for (const r of records) {
    if (!Number.isInteger(r.rx) || r.rx < 1 || r.rx > 0xffff || seen.has(r.rx)) throw new Error('receive channels must be unique and count from 1');
    seen.add(r.rx);
    put16(body, r.rx);
    put16(body, media);
    if (r.channel == null) { put16(body, 0); put16(body, 0); continue; }
    checkSource(r.channel, r.device);
    if (protocolId === PROTOCOL.ARC_2809 && r.device === '.') throw new Error('ARC 2.8.9 has no "." for the receiver itself');
    put16(body, intern(r.channel));
    put16(body, intern(r.device));
  }
  while (body.length < tableAt - REQUEST_HEADER) body.push(0);
  return frame(protocolId, txn, OPCODE.SUBSCRIPTION_PAGE, [...body, ...strings]);
}

/* -------------------------------------------------- modern responses */

/** `responses/mod.rs`: `MODERN_ARC_POINTER_TABLE_OFFSET`, the record offsets. */
const POINTER_TABLE = 18;
const STATUS_FORMAT_SIZE = 16;

/**
 * The page counts and the record pointers of a modern status page —
 * `responses/channel_status.rs`, `modern_arc_page_counts`, and
 * `responses/pointer_table.rs`, `parse_pointer_table_page`.
 */
function pointerTable(b, e) {
  if (e.body.length < 8) return null;
  const capacity = e.body[6];
  const count = e.body[7];
  if ((capacity === 0 && count !== 0) || count > capacity) return null;
  const tableEnd = POINTER_TABLE + count * 2;
  if (tableEnd > b.length) return null;
  const pointers = [];
  const seen = new Set();
  for (let i = 0; i < count; i++) {
    const p = u16(b, POINTER_TABLE + i * 2);
    if (p < tableEnd || seen.has(p)) return null;
    seen.add(p);
    pointers.push(p);
  }
  return { capacity, count, pointers, tableEnd };
}

/** `responses/channel_status.rs`, `parse_modern_arc_channel_status_record_prefix`. */
function statusPrefix(b, at, size, minimum) {
  if (at + size > b.length) return null;
  const number = u16(b, at + 2);
  const media = u16(b, at + 6);
  const mediaId = u16(b, at + 8);
  if (!number || !mediaId || ![MEDIA.AUDIO, MEDIA.VIDEO, MEDIA.ANCILLARY].includes(media)) return null;
  const name = pointed(b, u16(b, at + 20), minimum);
  if (name == null) return null;
  const format = u16(b, at + 22);
  if (format < minimum || format + STATUS_FORMAT_SIZE > b.length) return null;
  let sampleRate = null;
  let encoding = null;
  if (media === MEDIA.AUDIO) {
    sampleRate = u32(b, format);
    encoding = u16(b, format + 6);
    if (!sampleRate || !encoding) return null;
  }
  const factory = pointed(b, u16(b, at + 30), minimum);
  if (factory == null) return null;
  return { type: u16(b, at), number, media, mediaId, name, factory, sampleRate, encoding };
}

/**
 * A modern transmit-channel status page — `responses/channel_status.rs`,
 * `parse_modern_arc_transmitter_channel_status_page`. Records are type
 * `0x1414` (40 bytes) or `0x1616` (44). netaudio's reading of the two names:
 * the one at +20 is the channel's label now, the one at +30 its factory name
 * (`dante/device.py`, `apply_transmitter_channel_inventory`).
 */
export function parseTxStatusPage(b) {
  const e = expect(b, MODERN, OPCODE.TX_CHANNEL_STATUS, [RESULT.SUCCESS, RESULT.MORE_PAGES]);
  if (!e) return null;
  const t = pointerTable(b, e);
  if (!t) return null;
  const records = [];
  for (const p of t.pointers) {
    const type = u16(b, p);
    const size = type === 0x1414 ? 40 : type === 0x1616 ? 44 : 0;
    if (!size) return null;
    const r = statusPrefix(b, p, size, t.tableEnd);
    if (!r) return null;
    records.push({ number: r.number, media: r.media, mediaId: r.mediaId, label: r.name, factory: r.factory, sampleRate: r.sampleRate, encoding: r.encoding, end: p + size, at: p });
  }
  if (!noOverlap(records) || !unique(records)) return null;
  return { protocolId: e.protocolId, more: e.result === RESULT.MORE_PAGES, capacity: t.capacity, records: records.map(strip) };
}

/**
 * A modern receive-channel status page — `responses/channel_status.rs`,
 * `parse_modern_arc_receiver_channel_status_record`. Three record types, and
 * the subscription fields move with the type:
 *
 *   type     size  source channel  source device  subscription status  rx status
 *   0x141C    56        44              46                48               50
 *   0x161C    56        48              50                52               54
 *   0x161E    60        48              50                52               54
 */
const RX_STATUS_LAYOUT = new Map([
  [0x141C, { size: 56, channel: 44, device: 46, status: 48, rxStatus: 50 }],
  [0x161C, { size: 56, channel: 48, device: 50, status: 52, rxStatus: 54 }],
  [0x161E, { size: 60, channel: 48, device: 50, status: 52, rxStatus: 54 }],
]);
export function parseRxStatusPage(b) {
  const e = expect(b, MODERN, OPCODE.RX_CHANNEL_STATUS, [RESULT.SUCCESS, RESULT.MORE_PAGES]);
  if (!e) return null;
  const t = pointerTable(b, e);
  if (!t) return null;
  const records = [];
  for (const p of t.pointers) {
    const layout = RX_STATUS_LAYOUT.get(u16(b, p));
    if (!layout) return null;
    const r = statusPrefix(b, p, layout.size, t.tableEnd);
    if (!r) return null;
    const channelPtr = u16(b, p + layout.channel);
    const devicePtr = u16(b, p + layout.device);
    const txChannel = channelPtr ? pointed(b, channelPtr, t.tableEnd) : null;
    const txDevice = devicePtr ? pointed(b, devicePtr, t.tableEnd) : null;
    if ((channelPtr && txChannel == null) || (devicePtr && txDevice == null)) return null;
    records.push({
      number: r.number, media: r.media, mediaId: r.mediaId, label: r.name, factory: r.factory,
      sampleRate: r.sampleRate, encoding: r.encoding, txChannel, txDevice,
      status: u16(b, p + layout.status), rxStatus: u16(b, p + layout.rxStatus),
      flags: u32(b, p + 0x0c), at: p, end: p + layout.size,
    });
  }
  if (!noOverlap(records) || !unique(records)) return null;
  return { protocolId: e.protocolId, more: e.result === RESULT.MORE_PAGES, capacity: t.capacity, records: records.map(strip) };
}

const strip = ({ at, end, ...r }) => r;
const noOverlap = (records) => {
  const spans = records.map((r) => [r.at, r.end]).sort((a, b) => a[0] - b[0]);
  return spans.every((s, i) => i === 0 || spans[i - 1][1] <= s[0]);
};
const unique = (records) => {
  const numbers = new Set(records.map((r) => r.number));
  const media = new Set(records.map((r) => `${r.media}:${r.mediaId}`));
  return numbers.size === records.length && media.size === records.length;
};

/**
 * Where the next modern page starts — `channel_inventory.rs`, `accept`: the
 * first page asks for media selector 1 from id 1; after a "more pages"
 * answer, the media type of the last record and the lowest media-local id
 * not yet seen for it. Null when the inventory is complete.
 */
export function nextStatusRange(page, seen) {
  if (!page.more) return null;
  const last = page.records[page.records.length - 1];
  if (!last) return null;
  for (let id = 1; id <= 0xffff; id++) {
    if (!seen.has(`${last.media}:${id}`)) return { media: last.media, first: id };
  }
  return null;
}

/* ------------------------------------------------- write acknowledgement */

/**
 * Whether a device accepted a write — the result code, which is all netaudio
 * reads of one (`responses/device.rs`, `parse_result_code`). Acceptance is
 * not the routing: the next read of the receive channels is.
 */
export function writeAccepted(b, txn) {
  const e = envelope(b);
  if (!e || (txn != null && e.transactionId !== txn)) return { ok: false, error: 'no well-formed answer' };
  if (e.result === RESULT.SUCCESS || e.result === RESULT.MORE_PAGES) return { ok: true, result: e.result };
  return { ok: false, result: e.result, error: `the device answered 0x${e.result.toString(16).padStart(4, '0')}` };
}

/* ------------------------------------------------- subscription status */

/**
 * What a receive channel's subscription status means —
 * `subscription_status.rs`, `decode` and its `presentation` labels. Code 1 is
 * ambiguous on its own: with receiver status 0x0101 it is a live unicast
 * flow, with 0 the source has not been found. Codes netaudio has no
 * observation for come back as unknown, never guessed.
 *
 * `state` is one of none, connected, progress, warning, error, unknown.
 */
const STATUS = new Map([
  [0x0000, ['NONE', 'none', 'Not subscribed']],
  [0x0002, ['RESOLVED', 'progress', 'Resolved — the source was found; the flow is being set up']],
  [0x0003, ['RESOLVE_FAIL', 'error', 'Resolve failed — an error occurred while looking up the source channel']],
  [0x0004, ['SUBSCRIBE_SELF', 'connected', 'Subscribed (self) — to a channel on this same device']],
  [0x0005, ['RESOLVED_NONE', 'error', 'Source not present — the source channel is not on the network']],
  [0x0007, ['IDLE', 'none', 'Idle — a flow is configured but cannot carry audio yet']],
  [0x0008, ['IN_PROGRESS', 'progress', 'Establishing flow — setting up the flow with the transmitter']],
  [0x0009, ['DYNAMIC', 'connected', 'Subscribed (unicast)']],
  [0x000a, ['STATIC', 'connected', 'Subscribed (multicast)']],
  [0x000e, ['MANUAL', 'connected', 'Manually configured']],
  [0x000f, ['NO_CONNECTION', 'error', 'No connection — could not reach the transmitter']],
  [0x0010, ['CHANNEL_FORMAT', 'error', 'Channel format mismatch']],
  [0x0011, ['BUNDLE_FORMAT', 'error', 'Multicast flow format mismatch']],
  [0x0012, ['NO_RX', 'error', 'No more flows (Rx) — the receiver cannot take on any more flows']],
  [0x0013, ['RX_FAIL', 'error', 'Receiver setup failed']],
  [0x0014, ['NO_TX', 'error', 'No more flows (Tx) — the transmitter cannot supply any more flows']],
  [0x0015, ['TX_FAIL', 'error', 'Transmitter setup failed']],
  [0x0016, ['QOS_FAIL_RX', 'error', 'Rx bandwidth exceeded']],
  [0x0017, ['QOS_FAIL_TX', 'error', 'Tx bandwidth exceeded']],
  [0x0018, ['TX_REJECTED_ADDR', 'error', 'Address rejected by transmitter']],
  [0x0019, ['INVALID_MSG', 'error', 'Request rejected by transmitter']],
  [0x001a, ['CHANNEL_LATENCY', 'error', 'Incorrect channel latencies — the source needs more latency than the receiver supports']],
  [0x001b, ['CLOCK_DOMAIN', 'error', 'Clock domain mismatch']],
  [0x001c, ['UNSUPPORTED', 'error', 'Unsupported feature']],
  [0x001d, ['RX_LINK_DOWN', 'error', 'Receiver link down']],
  [0x001e, ['TX_LINK_DOWN', 'error', 'Transmitter link down']],
  [0x001f, ['DYNAMIC_PROTOCOL', 'error', 'No suitable protocol for a dynamic connection']],
  [0x0020, ['INVALID_CHANNEL', 'error', 'Invalid channel']],
  [0x0021, ['TX_SCHEDULER_FAILURE', 'error', 'Tx scheduler failure']],
  [0x0022, ['SUBSCRIBE_SELF_POLICY', 'error', 'Self-subscription not allowed on this device']],
  [0x0023, ['TX_NOT_READY', 'warning', 'External transmitter not ready']],
  [0x0024, ['RX_NOT_READY', 'warning', 'External receiver not ready']],
  [0x0025, ['TX_FANOUT_LIMIT_REACHED', 'error', 'No more unicast flows (Tx)']],
  [0x0026, ['TX_CHANNEL_ENCRYPTED', 'error', 'Encryption unsupported (Rx)']],
  [0x0027, ['TX_RESPONSE_UNEXPECTED', 'error', 'Unexpected response from the transmitter']],
  [0x00ff, ['SYSTEM_FAIL', 'error', 'Unexpected system failure']],
]);

export function subscriptionStatus(code, rxStatus) {
  if (code === 0x0001) {
    if (rxStatus === 0x0101) return { code, name: 'DYNAMIC', state: 'connected', label: 'Subscribed (unicast)' };
    if (rxStatus === 0x0000) return { code, name: 'UNRESOLVED', state: 'error', label: 'Unresolved — the transmitting device is not on the network' };
    return { code, name: null, state: 'unknown', label: `Status 1 with receiver status 0x${(rxStatus ?? 0).toString(16)} — not a combination anybody has observed` };
  }
  const known = STATUS.get(code);
  if (!known) return { code, name: null, state: 'unknown', label: `Unknown subscription status 0x${(code ?? 0).toString(16).padStart(4, '0')}` };
  return { code, name: known[0], state: known[1], label: known[2] };
}
