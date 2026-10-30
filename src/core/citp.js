/*
 * CITP and its media-server layer, MSEX, the parts a media server needs —
 * no I/O.
 *
 * CITP is how MagicQ, grandMA2 and Titan learn what a media server holds:
 * its layers and where each is patched, its libraries with names and
 * thumbnails, what each layer is showing, and low-rate video previews. The
 * desk finds the server by a multicast `PINF/PLoc`, connects over TCP, and
 * asks. grandMA3 has no CITP at all.
 *
 * Read from the CITP specification as published by the CITP group (MSEX 1.2,
 * the 2014 revision with the personality suffix), with the Wireshark
 * dissector (1.6.1) as a second reading of the field layouts. Every number
 * below that is not obvious names the field it comes from.
 *
 * ## What catches people out
 *
 * - **Everything is little-endian**, and a cookie ("CITP", "MSEX", "PNG ")
 *   is its four characters in order on the wire — the spec's `0x50544943`
 *   is "CITP" read as a little-endian uint32.
 * - **Each MSEX message has a layout per version**, 1.0, 1.1 and 1.2, and the
 *   version is in every message's header. Counts are a uint8 before 1.2 and a
 *   uint16 from it; libraries are a number in 1.0 and a four-byte id after.
 *   A server answers in the version it was asked in, or in the version a 1.2
 *   client settled with `CInf`.
 * - **Strings come two ways**: `ucs1` is bytes, `ucs2` UTF-16LE, both ending
 *   in a zero. The server UUID in `SInf` and `StFr` is 36 bytes with no zero.
 * - **RGB8 was BGR in MSEX 1.0.** The pixels are swapped for a 1.0 asker.
 * - **A buffer size is a uint16**: a thumbnail or a stream frame is under
 *   64 KiB, or it is sent as fragments (`fJPG`, `fPNG`, 1.2 only).
 */

export const CITP_PORT = 4809;
/* The multicast group since 2014, and the one before it, which the spec asks
   servers to go on supporting. */
export const CITP_GROUPS = Object.freeze(['239.224.0.180', '224.0.0.180']);

const HEADER = 20;          /* CITP_Header */
const PINF_HEADER = HEADER + 4;
const MSEX_HEADER = HEADER + 6;

/* MSEX versions as [major, minor], oldest first. */
export const MSEX_VERSIONS = Object.freeze([[1, 0], [1, 1], [1, 2]]);
export const V10 = Object.freeze([1, 0]);
export const V11 = Object.freeze([1, 1]);
export const V12 = Object.freeze([1, 2]);
/** Version order: negative, zero or positive as `a` is older than, the same as, or newer than `b`. */
export const versionCompare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);
const atLeast12 = (v) => versionCompare(v, V12) >= 0;

/* SInf 1.2 SupportedLibraryTypes: one bit per library type, Media being 1. */
export const LIBRARY_MEDIA = 1;
export const libraryTypeBits = (types) => types.reduce((bits, t) => bits | (1 << (t - 1)), 0);

/* LSta LayerStatusFlags. */
export const LAYER_PLAYING = 0x0001;

export const FORMATS = Object.freeze({ RGB8: 'RGB8', JPEG: 'JPEG', PNG: 'PNG ', FJPG: 'fJPG', FPNG: 'fPNG' });

/* StFr fragment preamble: FrameIndex u32, FragmentCount u16, FragmentIndex u16, FragmentByteOffset u32. */
const FRAGMENT_PREAMBLE = 12;

/* ------------------------------------------------------------- writing */

class Writer {
  #bytes = [];
  u8(v) { this.#bytes.push(v & 0xff); return this; }
  u16(v) { return this.u8(v).u8(v >>> 8); }
  u32(v) { return this.u16(v & 0xffff).u16(v >>> 16); }
  u64(v) {
    const big = BigInt(Math.max(0, Math.floor(Number(v) || 0)));
    return this.u32(Number(big & 0xffffffffn)).u32(Number(big >> 32n));
  }
  cookie(s) { for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i) || 0x20); return this; }
  bytes(b) { for (const x of b) this.#bytes.push(x); return this; }
  /* ucs1: one byte per character, anything outside Latin-1 as '?'. */
  ucs1(s) {
    for (const ch of String(s ?? '')) {
      const c = ch.codePointAt(0);
      this.u8(c > 0 && c < 256 ? c : 0x3f);
    }
    return this.u8(0);
  }
  ucs2(s) {
    const str = String(s ?? '');
    for (let i = 0; i < str.length; i++) this.u16(str.charCodeAt(i) || 0x3f);
    return this.u16(0);
  }
  /* A fixed-length ucs1 field with no terminator: the server UUID. */
  fixed(s, length) {
    for (let i = 0; i < length; i++) this.u8(i < s.length ? s.charCodeAt(i) : 0);
    return this;
  }
  libraryId(id) { for (let i = 0; i < 4; i++) this.u8(id[i] || 0); return this; }
  done() { return Uint8Array.from(this.#bytes); }
}

/** A whole CITP message: the CITP header, then `payload` (second-layer header and all). */
export function citpMessage(contentType, payload, { requestIndex = 0 } = {}) {
  const out = new Uint8Array(HEADER + payload.length);
  const v = new DataView(out.buffer);
  out.set([0x43, 0x49, 0x54, 0x50], 0);         /* Cookie "CITP" */
  out[4] = 1; out[5] = 0;                       /* VersionMajor 1, VersionMinor 0 */
  v.setUint16(6, requestIndex, true);           /* RequestIndex / InResponseTo */
  v.setUint32(8, out.length, true);             /* MessageSize, header included */
  v.setUint16(12, 1, true);                     /* MessagePartCount */
  v.setUint16(14, 0, true);                     /* MessagePart */
  for (let i = 0; i < 4; i++) out[16 + i] = contentType.charCodeAt(i);
  out.set(payload, HEADER);
  return out;
}

const pinf = (type, body) => citpMessage('PINF', new Writer().cookie(type).bytes(body).done());

/** PINF/PNam: this peer's display name, the first thing said on a TCP connection. */
export const buildPNam = (name) => pinf('PNam', new Writer().ucs1(name).done());

/** PINF/PLoc: the multicast "I am here, connect on this port". */
export function buildPLoc({ port, type = 'MediaServer', name, state = 'Running' }) {
  return pinf('PLoc', new Writer().u16(port).ucs1(type).ucs1(name).ucs1(state).done());
}

/** Any MSEX message: its header (`version`, `type`), then `body`. */
export function msexMessage(version, type, body, { inResponseTo = 0 } = {}) {
  const payload = new Writer().u8(version[0]).u8(version[1]).cookie(type).bytes(body).done();
  return citpMessage('MSEX', payload, { requestIndex: inResponseTo });
}

/**
 * MSEX/SInf. Before 1.2: product name and version and the layers' DMX
 * sources. From 1.2: the server's UUID, the versions and formats it offers,
 * and the layers' sources with their personality suffix.
 *
 * @param {number[]} version
 * @param {object} info
 * @param {string} info.uuid
 * @param {string} info.product
 * @param {number[]} info.productVersion   [major, minor, bugfix]
 * @param {number[]} [info.libraryTypes]   [1] for media only
 * @param {string[]} [info.thumbnailFormats]
 * @param {string[]} [info.streamFormats]
 * @param {string[]} info.layers           each layer's DMX source, suffix included (cut before 1.2)
 */
export function buildSInf(version, info, options) {
  const w = new Writer();
  const [maj = 0, min = 0, bug = 0] = info.productVersion || [];
  const layers = (info.layers || []).slice(0, 255);
  if (!atLeast12(version)) {
    w.ucs2(info.product).u8(maj).u8(min).u8(layers.length);
    for (const l of layers) w.ucs1(String(l).replace(/\/PersonalityID\/.*$/, ''));
    return msexMessage(V10, 'SInf', w.done(), options);
  }
  w.fixed(info.uuid, 36).ucs2(info.product).u8(maj).u8(min).u8(bug);
  w.u8(MSEX_VERSIONS.length);
  for (const [a, b] of MSEX_VERSIONS) w.u16((a << 8) | b);
  w.u16(libraryTypeBits(info.libraryTypes || [LIBRARY_MEDIA]));
  const thumbs = info.thumbnailFormats || [FORMATS.PNG, FORMATS.JPEG, FORMATS.RGB8];
  w.u8(thumbs.length);
  for (const f of thumbs) w.cookie(f);
  const streams = info.streamFormats || [FORMATS.JPEG, FORMATS.FJPG, FORMATS.PNG, FORMATS.FPNG, FORMATS.RGB8];
  w.u8(streams.length);
  for (const f of streams) w.cookie(f);
  w.u8(layers.length);
  for (const l of layers) w.ucs1(l);
  return msexMessage(version, 'SInf', w.done(), options);
}

/** MSEX/Nack: "I do not do that", for a 1.2 session. */
export const buildNack = (version, receivedType, options) =>
  msexMessage(version, 'Nack', new Writer().cookie(receivedType).done(), options);

/**
 * MSEX/LSta, every layer's state.
 *
 * @param {number[]} version
 * @param {Array<{layer: number, output: number, library: number, element: number, name: string,
 *   position?: number, length?: number, fps?: number, flags?: number}>} layers
 *   `library` and `element` are 0-based indexes; the 1.2 layout adds the library's type and id.
 */
export function buildLSta(version, layers) {
  const w = new Writer();
  const list = layers.slice(0, 255);
  w.u8(list.length);
  for (const l of list) {
    w.u8(l.layer).u8(l.output ?? 0);
    if (atLeast12(version)) w.u8(LIBRARY_MEDIA).libraryId(libraryId(l.library));
    else w.u8(l.library);
    w.u8(l.element).ucs2(l.name).u32(l.position || 0).u32(l.length || 0).u8(l.fps || 0).u32(l.flags || 0);
  }
  return msexMessage(atLeast12(version) ? version : V10, 'LSta', w.done());
}

/** A first-level library's id: {Level 1, Level1 n, 0, 0}. */
export const libraryId = (index) => [1, index & 0xff, 0, 0];

const count = (w, version, n) => (atLeast12(version) ? w.u16(n) : w.u8(Math.min(n, 255)));

/**
 * MSEX/ELIn, libraries.
 *
 * @param {Array<{index: number, dmx: number[], name: string, elements: number, serial?: number}>} libraries
 */
export function buildELIn(version, libraryType, libraries, options) {
  const w = new Writer().u8(libraryType);
  count(w, version, libraries.length);
  for (const lib of libraries) {
    if (versionCompare(version, V11) < 0) w.u8(lib.index);
    else w.libraryId(libraryId(lib.index));
    if (atLeast12(version)) w.u32(lib.serial || 0);
    w.u8(lib.dmx[0]).u8(lib.dmx[1]).ucs2(lib.name);
    if (versionCompare(version, V11) >= 0) count(w, version, 0);   /* LibraryCount: no sub-libraries */
    count(w, version, lib.elements);
  }
  return msexMessage(version, 'ELIn', w.done(), options);
}

/**
 * MSEX/MEIn, media elements in one library.
 *
 * @param {Array<{index: number, dmx: number[], name: string, serial?: number, timestamp?: number,
 *   width?: number, height?: number, length?: number, fps?: number}>} elements
 */
export function buildMEIn(version, library, elements, options) {
  const w = new Writer();
  if (versionCompare(version, V11) < 0) w.u8(library);
  else w.libraryId(libraryId(library));
  count(w, version, elements.length);
  for (const e of elements) {
    w.u8(e.index);
    if (atLeast12(version)) w.u32(e.serial || 0);
    w.u8(e.dmx[0]).u8(e.dmx[1]).ucs2(e.name).u64(e.timestamp || 0)
      .u16(e.width || 0).u16(e.height || 0).u32(e.length || 0).u8(e.fps || 0);
  }
  return msexMessage(version, 'MEIn', w.done(), options);
}

/** MSEX/ELUp: a library's contents have changed. */
export function buildELUp(version, libraryType, library, flags = 0x02) {
  const w = new Writer().u8(libraryType);
  if (versionCompare(version, V11) < 0) w.u8(library);
  else w.libraryId(libraryId(library));
  if (atLeast12(version)) {
    w.u8(flags | 0x10 | 0x20);                 /* all elements and sub-libraries affected */
    w.bytes(new Uint8Array(64));               /* AffectedElements, AffectedLibraries: ignored */
  } else w.u8(flags);
  return msexMessage(version, 'ELUp', w.done());
}

/** MSEX/EThn, one element's thumbnail. `image.data` must be under 64 KiB. */
export function buildEThn(version, { libraryType = LIBRARY_MEDIA, library, element, image }, options) {
  const w = new Writer().u8(libraryType);
  if (versionCompare(version, V11) < 0) w.u8(library);
  else w.libraryId(libraryId(library));
  w.u8(element).cookie(image.format).u16(image.width).u16(image.height).u16(image.data.length).bytes(image.data);
  return msexMessage(version, 'EThn', w.done(), options);
}

/** MSEX/ELTh, one library's thumbnail. */
export function buildELTh(version, { libraryType = LIBRARY_MEDIA, library, image }, options) {
  const w = new Writer().u8(libraryType);
  if (versionCompare(version, V11) < 0) w.u8(library);
  else w.libraryId(libraryId(library));
  w.cookie(image.format).u16(image.width).u16(image.height).u16(image.data.length).bytes(image.data);
  return msexMessage(version, 'ELTh', w.done(), options);
}

/**
 * MSEX/VSrc, the video sources a desk may subscribe to.
 *
 * @param {Array<{id: number, name: string, output?: number, layer?: number, width: number, height: number}>} sources
 */
export function buildVSrc(version, sources, options) {
  const w = new Writer().u16(sources.length);
  for (const s of sources) {
    w.u16(s.id).ucs2(s.name).u8(s.output ?? 0xff).u8(s.layer ?? 0xff).u16(0).u16(s.width).u16(s.height);
  }
  return msexMessage(version, 'VSrc', w.done(), options);
}

/**
 * MSEX/StFr, one video frame, multicast. A fragmented format (`fJPG`,
 * `fPNG`) comes back as several messages, each a fragment with its preamble;
 * anything else as one, which must be under 64 KiB.
 */
export function buildStFr(version, { uuid, source, image, frameIndex = 0, fragmentSize = 1400 }) {
  const head = (w) => {
    if (atLeast12(version)) w.fixed(uuid, 36);
    return w.u16(source).cookie(image.format).u16(image.width).u16(image.height);
  };
  const fragmented = image.format === FORMATS.FJPG || image.format === FORMATS.FPNG;
  if (!fragmented) {
    return [msexMessage(version, 'StFr', head(new Writer()).u16(image.data.length).bytes(image.data).done())];
  }
  const size = Math.max(1, fragmentSize);
  const total = Math.max(1, Math.ceil(image.data.length / size));
  const out = [];
  for (let i = 0; i < total; i++) {
    const part = image.data.subarray(i * size, (i + 1) * size);
    const w = head(new Writer()).u16(FRAGMENT_PREAMBLE + part.length);
    w.u32(frameIndex).u16(total).u16(i).u32(i * size).bytes(part);
    out.push(msexMessage(version, 'StFr', w.done()));
  }
  return out;
}

/* ------------------------------------------------------------- reading */

class Reader {
  constructor(bytes, at = 0) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.at = at; }
  need(n) { if (this.at + n > this.b.length) throw new RangeError('short message'); }
  u8() { this.need(1); return this.b[this.at++]; }
  u16() { this.need(2); const x = this.v.getUint16(this.at, true); this.at += 2; return x; }
  u32() { this.need(4); const x = this.v.getUint32(this.at, true); this.at += 4; return x; }
  cookie() { this.need(4); const s = String.fromCharCode(...this.b.subarray(this.at, this.at + 4)); this.at += 4; return s; }
  libraryId() { this.need(4); const id = [...this.b.subarray(this.at, this.at + 4)]; this.at += 4; return id; }
  ucs1() {
    let s = '';
    for (;;) { const c = this.u8(); if (!c) return s; s += String.fromCharCode(c); }
  }
  list(n, read) { const out = []; for (let i = 0; i < n; i++) out.push(read()); return out; }
}

/**
 * One CITP message, or null when it is not one: `{ layer, type, requestIndex,
 * version, body }`. `version` is the MSEX version (null for other layers);
 * `body` the bytes after the second-layer header.
 */
export function parseCitp(bytes) {
  if (!bytes || bytes.length < HEADER + 4) return null;
  if (bytes[0] !== 0x43 || bytes[1] !== 0x49 || bytes[2] !== 0x54 || bytes[3] !== 0x50) return null;
  const r = new Reader(bytes, 16);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const requestIndex = v.getUint16(6, true);
  const layer = r.cookie();
  if (layer === 'MSEX') {
    if (bytes.length < MSEX_HEADER) return null;
    const version = [r.u8(), r.u8()];
    return { layer, type: r.cookie(), requestIndex, version, body: bytes.subarray(MSEX_HEADER) };
  }
  if (bytes.length < PINF_HEADER) return null;
  return { layer, type: r.cookie(), requestIndex, version: null, body: bytes.subarray(PINF_HEADER) };
}

/**
 * Splits a TCP stream into CITP messages. A stream that stops making sense
 * (no "CITP" where a header should be) is reported once, and the caller
 * should close it: there is no way to find the next message.
 */
export class CitpStream {
  #pending = new Uint8Array(0);
  broken = false;

  /** @returns {Uint8Array[]} the whole messages the chunk completed */
  push(chunk) {
    if (this.broken) return [];
    const joined = new Uint8Array(this.#pending.length + chunk.length);
    joined.set(this.#pending, 0);
    joined.set(chunk, this.#pending.length);
    const out = [];
    let at = 0;
    while (joined.length - at >= 4) {
      if (joined[at] !== 0x43 || joined[at + 1] !== 0x49 || joined[at + 2] !== 0x54 || joined[at + 3] !== 0x50) {
        this.broken = true;
        return out;
      }
      if (joined.length - at < HEADER) break;
      const size = new DataView(joined.buffer, at + 8, 4).getUint32(0, true);
      if (size < HEADER || size > 16 * 1024 * 1024) { this.broken = true; return out; }
      if (joined.length - at < size) break;
      out.push(joined.slice(at, at + size));
      at += size;
    }
    this.#pending = joined.slice(at);
    return out;
  }
}

/**
 * A request's fields, from a parsed message. Only what a media server is
 * asked: PINF/PNam and PLoc, and MSEX CInf, GELI, GEIn, GELT, GETh, GVSr and
 * RqSt. Anything else, or anything short, is null.
 */
export function readRequest(msg) {
  if (!msg) return null;
  const r = new Reader(msg.body);
  const v = msg.version;
  const n = () => (v && atLeast12(v) ? r.u16() : r.u8());
  const lib = () => (v && versionCompare(v, V11) >= 0 ? r.libraryId() : [1, r.u8(), 0, 0]);
  try {
    if (msg.layer === 'PINF') {
      if (msg.type === 'PNam') return { name: r.ucs1() };
      if (msg.type === 'PLoc') return { port: r.u16(), type: r.ucs1(), name: r.ucs1(), state: r.ucs1() };
      return null;
    }
    if (msg.layer !== 'MSEX') return null;
    switch (msg.type) {
      case 'CInf': {
        const k = r.u8();
        return { versions: r.list(k, () => { const x = r.u16(); return [x >> 8, x & 0xff]; }) };
      }
      case 'GELI': {
        const libraryType = r.u8();
        const parent = versionCompare(v, V11) >= 0 ? r.libraryId() : [0, 0, 0, 0];
        const k = n();
        return { libraryType, parent, libraries: r.list(k, () => r.u8()) };
      }
      case 'GEIn': {
        const libraryType = r.u8();
        const library = lib();
        const k = n();
        return { libraryType, library, elements: r.list(k, () => r.u8()) };
      }
      case 'GELT': {
        const thumb = { format: r.cookie(), width: r.u16(), height: r.u16(), flags: r.u8() };
        const libraryType = r.u8();
        const k = n();
        return { ...thumb, libraryType, libraries: r.list(k, lib) };
      }
      case 'GETh': {
        const thumb = { format: r.cookie(), width: r.u16(), height: r.u16(), flags: r.u8() };
        const libraryType = r.u8();
        const library = lib();
        const k = n();
        return { ...thumb, libraryType, library, elements: r.list(k, () => r.u8()) };
      }
      case 'GVSr': return {};
      case 'RqSt':
        return { source: r.u16(), format: r.cookie(), width: r.u16(), height: r.u16(), fps: r.u8(), timeout: r.u8() };
      default: return null;
    }
  } catch {
    return null;
  }
}

/**
 * The highest version both sides have, from a CInf's list; null when there
 * is none (a client offering only versions this does not speak).
 */
export function highestCommon(offered) {
  const ours = new Set(MSEX_VERSIONS.map(([a, b]) => `${a}.${b}`));
  const both = (offered || []).filter(([a, b]) => ours.has(`${a}.${b}`)).sort(versionCompare);
  return both.length ? both[both.length - 1] : null;
}

/* Exposed for the tests, which read messages back field by field. */
export { Reader as CitpReader };
