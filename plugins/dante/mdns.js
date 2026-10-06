/*
 * Dante — DNS messages, as bytes, for multicast DNS discovery. No I/O.
 *
 * Dante devices advertise themselves with DNS-SD over mDNS: one
 * `_netaudio-arc._udp` instance per device, named after the device, whose SRV
 * record gives the control port and whose TXT record says which protocol
 * revision it speaks (`arcp_vers`). `discovery.js` asks for them; this file
 * writes the question and reads the answer.
 *
 * ## Why a question from an ephemeral port, and what that buys
 *
 * RFC 6762 §6.7 — a query sent from any source port other than 5353 is a
 * *legacy unicast* query, and a responder answers it with a unicast packet
 * straight back to that address and port, echoing the query id and the
 * question. So this never binds port 5353, never joins the mDNS group and
 * never competes with the operating system's own responder (mDNSResponder,
 * Avahi) for the port. The price is that answers carry TTLs of at most ten
 * seconds and nothing is pushed to us — which is why `discovery.js` asks again
 * on a timer rather than listening.
 *
 * Names in answers are compressed (RFC 1035 §4.1.4): a two-byte pointer whose
 * top bits are `11` stands for the rest of a name already written earlier in
 * the packet. The reader follows them with a hop limit and only backwards, so
 * a hostile packet cannot loop it.
 *
 * Nothing here is Dante-specific beyond the record types it bothers to decode;
 * `servicesFrom` gathers PTR, SRV, TXT and A records into instances.
 */

export const TYPE = Object.freeze({ A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 });
export const CLASS_IN = 1;
/** In a question, "answer by unicast" (RFC 6762 §5.4); in a record, "flush your cache". */
export const TOP_BIT = 0x8000;
export const MDNS_GROUP = '224.0.0.251';
export const MDNS_PORT = 5353;

const MAX_HOPS = 16;
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

const u16 = (b, at) => (at + 2 <= b.length ? (b[at] << 8) | b[at + 1] : null);
const u32 = (b, at) => (at + 4 <= b.length ? ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) : null);
const put16 = (out, v) => out.push((v >>> 8) & 0xff, v & 0xff);
const put32 = (out, v) => out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);

/** `Desk._netaudio-arc._udp.local.` and `Desk._netaudio-arc._udp.local` are one name. */
export const canonical = (name) => String(name).replace(/\.$/, '').toLowerCase();

/* ------------------------------------------------------------- writing */

/**
 * Write a name, compressing against what `table` already holds. The table maps
 * a lower-cased suffix to the offset it was first written at; pass one per
 * message, or null for no compression. Labels are split on dots, so an
 * instance label containing a dot cannot be written — no Dante name may hold
 * one.
 */
function writeName(out, name, table) {
  const labels = String(name).replace(/\.$/, '').split('.').filter(Boolean);
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.').toLowerCase();
    if (table && table.has(suffix)) {
      put16(out, 0xC000 | table.get(suffix));
      return;
    }
    if (table && out.length < 0x3fff) table.set(suffix, out.length);
    const bytes = enc.encode(labels[i]);
    if (bytes.length > 63) throw new Error('a DNS label is at most 63 bytes');
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
}

/**
 * A query: `{ id, questions: [{ name, type, unicast? }] }`. With `unicast`
 * the question carries the QU bit; a legacy query from an ephemeral port needs
 * none, because its port already asks for a unicast answer.
 */
export function buildQuery({ id = 0, questions }) {
  const out = [];
  put16(out, id);
  put16(out, 0);              // flags: a standard query
  put16(out, questions.length);
  put16(out, 0); put16(out, 0); put16(out, 0);
  const table = new Map();
  for (const q of questions) {
    writeName(out, q.name, table);
    put16(out, q.type);
    put16(out, CLASS_IN | (q.unicast ? TOP_BIT : 0));
  }
  return Uint8Array.from(out);
}

function writeRecord(out, r, table) {
  writeName(out, r.name, table);
  put16(out, r.type);
  put16(out, CLASS_IN | (r.flush ? TOP_BIT : 0));
  put32(out, r.ttl ?? 10);
  const lengthAt = out.length;
  put16(out, 0);
  const start = out.length;
  if (r.type === TYPE.A) {
    out.push(...String(r.data).split('.').map(Number));
  } else if (r.type === TYPE.PTR) {
    writeName(out, r.data, table);
  } else if (r.type === TYPE.SRV) {
    put16(out, r.data.priority ?? 0);
    put16(out, r.data.weight ?? 0);
    put16(out, r.data.port);
    writeName(out, r.data.target, table);
  } else if (r.type === TYPE.TXT) {
    const entries = Object.entries(r.data || {});
    if (!entries.length) out.push(0);
    for (const [k, v] of entries) {
      const bytes = enc.encode(v === true ? k : `${k}=${v}`);
      out.push(bytes.length, ...bytes);
    }
  } else {
    throw new Error(`cannot write a record of type ${r.type}`);
  }
  const length = out.length - start;
  out[lengthAt] = length >> 8;
  out[lengthAt + 1] = length & 0xff;
}

/**
 * A response: `{ id, questions, answers, additionals }`, each record
 * `{ name, type, ttl, flush?, data }`. Compressed, as a responder would. The
 * simulator answers with this; nothing on the server half sends one.
 */
export function buildResponse({ id = 0, questions = [], answers = [], additionals = [] }) {
  const out = [];
  put16(out, id);
  put16(out, 0x8400);          // a response, authoritative
  put16(out, questions.length);
  put16(out, answers.length);
  put16(out, 0);
  put16(out, additionals.length);
  const table = new Map();
  for (const q of questions) {
    writeName(out, q.name, table);
    put16(out, q.type);
    put16(out, CLASS_IN);
  }
  for (const r of answers) writeRecord(out, r, table);
  for (const r of additionals) writeRecord(out, r, table);
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------- reading */

/**
 * Read a possibly compressed name at `at`. Answers `{ name, next }`, `next`
 * being where the name ends in the packet as written (after its first
 * pointer, if it has one), or null for a name that is malformed, loops, or
 * points forwards.
 */
export function readName(b, at) {
  const labels = [];
  let pos = at;
  let next = null;
  let hops = 0;
  for (;;) {
    if (pos >= b.length) return null;
    const len = b[pos];
    if (len === 0) {
      if (next == null) next = pos + 1;
      break;
    }
    if ((len & 0xC0) === 0xC0) {
      const target = u16(b, pos);
      if (target == null) return null;
      const pointer = target & 0x3fff;
      if (next == null) next = pos + 2;
      if (pointer >= pos || ++hops > MAX_HOPS) return null;
      pos = pointer;
      continue;
    }
    if (len & 0xC0) return null;            // 01 and 10 are reserved
    if (pos + 1 + len > b.length) return null;
    labels.push(dec.decode(b.subarray(pos + 1, pos + 1 + len)));
    pos += 1 + len;
    if (labels.length > 128) return null;
  }
  return { name: labels.join('.'), next };
}

/** TXT strings to `{ key: value }` (RFC 6763 §6): a bare key is `true`, the first copy of a key wins. */
export function parseTxt(b, at, end) {
  const out = {};
  let pos = at;
  while (pos < end) {
    const len = b[pos];
    if (pos + 1 + len > end) return null;
    const s = dec.decode(b.subarray(pos + 1, pos + 1 + len));
    pos += 1 + len;
    if (!s) continue;
    const eq = s.indexOf('=');
    const key = (eq < 0 ? s : s.slice(0, eq)).toLowerCase();
    if (!key || key in out) continue;
    out[key] = eq < 0 ? true : s.slice(eq + 1);
  }
  return out;
}

function readRecord(b, at) {
  const n = readName(b, at);
  if (!n) return null;
  let pos = n.next;
  const type = u16(b, pos);
  const klass = u16(b, pos + 2);
  const ttl = u32(b, pos + 4);
  const length = u16(b, pos + 8);
  if (type == null || klass == null || ttl == null || length == null) return null;
  const start = pos + 10;
  const end = start + length;
  if (end > b.length) return null;
  const record = { name: n.name, type, flush: Boolean(klass & TOP_BIT), ttl, data: null };
  if (type === TYPE.A && length === 4) {
    record.data = Array.from(b.subarray(start, end)).join('.');
  } else if (type === TYPE.AAAA && length === 16) {
    const words = [];
    for (let i = 0; i < 16; i += 2) words.push(u16(b, start + i).toString(16));
    record.data = words.join(':');
  } else if (type === TYPE.PTR) {
    const t = readName(b, start);
    if (!t) return null;
    record.data = t.name;
  } else if (type === TYPE.SRV && length >= 7) {
    const t = readName(b, start + 6);
    if (!t) return null;
    record.data = { priority: u16(b, start), weight: u16(b, start + 2), port: u16(b, start + 4), target: t.name };
  } else if (type === TYPE.TXT) {
    record.data = parseTxt(b, start, end);
    if (!record.data) return null;
  }
  return { record, next: end };
}

/**
 * A whole message, or null when any part of it does not parse — a truncated
 * or hostile packet is dropped, not half-read.
 */
export function parseMessage(b) {
  if (!b || b.length < 12) return null;
  const id = u16(b, 0);
  const flags = u16(b, 2);
  const counts = [u16(b, 4), u16(b, 6), u16(b, 8), u16(b, 10)];
  let pos = 12;
  const questions = [];
  for (let i = 0; i < counts[0]; i++) {
    const n = readName(b, pos);
    if (!n || n.next + 4 > b.length) return null;
    questions.push({ name: n.name, type: u16(b, n.next), unicast: Boolean(u16(b, n.next + 2) & TOP_BIT) });
    pos = n.next + 4;
  }
  const sections = [[], [], []];
  for (let s = 0; s < 3; s++) {
    for (let i = 0; i < counts[s + 1]; i++) {
      const r = readRecord(b, pos);
      if (!r) return null;
      sections[s].push(r.record);
      pos = r.next;
    }
  }
  return {
    id, flags, response: Boolean(flags & 0x8000),
    questions, answers: sections[0], authorities: sections[1], additionals: sections[2]
  };
}

/* ------------------------------------------------------------ gathering */

/**
 * Fold a message's records into service instances of the given types:
 * `[{ type, instance, name, host, port, txt, addresses }]`, where `instance`
 * is the full instance name and `name` its first label — for a Dante service
 * that is the device's name. A record set split across packets is joined by
 * `discovery.js`, which keeps what earlier answers said.
 */
export function servicesFrom(message, types) {
  if (!message) return [];
  const records = [...message.answers, ...message.additionals];
  const wanted = new Set(types.map(canonical));
  const instances = new Map();
  const hosts = new Map();
  for (const r of records) {
    if (r.type === TYPE.A) {
      const list = hosts.get(canonical(r.name)) || [];
      if (!list.includes(r.data)) list.push(r.data);
      hosts.set(canonical(r.name), list);
    }
  }
  const instanceOf = (full) => {
    const key = canonical(full);
    if (!instances.has(key)) {
      const type = [...wanted].find((t) => key.endsWith('.' + t));
      if (!type) return null;
      const label = full.replace(/\.$/, '').slice(0, -(type.length + 1));
      instances.set(key, { type, instance: full.replace(/\.$/, ''), name: label, host: null, port: null, txt: null, addresses: [] });
    }
    return instances.get(key);
  };
  for (const r of records) {
    if (r.type === TYPE.PTR && wanted.has(canonical(r.name))) instanceOf(r.data);
    else if (r.type === TYPE.SRV) {
      const s = instanceOf(r.name);
      if (s) { s.host = r.data.target; s.port = r.data.port; }
    } else if (r.type === TYPE.TXT) {
      const s = instanceOf(r.name);
      if (s) s.txt = r.data;
    }
  }
  for (const s of instances.values()) {
    if (s.host) s.addresses = hosts.get(canonical(s.host)) || [];
  }
  return [...instances.values()];
}
