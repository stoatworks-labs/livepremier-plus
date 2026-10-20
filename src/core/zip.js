/*
 * Zip files, both ways, with no dependency.
 *
 * **Writing** (the Background Slicer's downloads): stored entries, no
 * compression — enough to hand an operator every generated PNG and export
 * file as one download. PNGs are already deflated and the text files are
 * small, so compressing would buy little. Stored entries are the simplest
 * thing every unzipper reads: a local header and the bytes per file, then a
 * central directory and its end record (PKWARE APPNOTE 6.3.x, §4.3). No
 * zip64: the page refuses anything that would need it (over 4 GiB or 65,535
 * files), which no set of backgrounds approaches.
 *
 * **Reading** (Image Library tools' zip upload): whatever an operator's
 * machine made — Finder's Compress, Windows' Send to, `zip`, a web export —
 * so stored and deflated entries, zip64 records, and data descriptors (the
 * sizes are taken from the central directory, which always has them). Read
 * from the central directory, never by walking local headers. Anything else
 * (encrypted, another method, a damaged entry) is listed with the reason
 * rather than thrown, so one odd file does not lose the other fifty.
 *
 * Moved here from the Background Slicer's folder when Image Library tools
 * needed it: a plugin may not import another's folder (AGENTS.md).
 *
 * No DOM, no I/O: `Uint8Array`s in and out. Deflate is undone by the
 * platform's `DecompressionStream('deflate-raw')` (every current browser, and
 * Node 21+), or by an `inflate` handed in.
 */

let TABLE = null;
function crcTable() {
  if (TABLE) return TABLE;
  TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    TABLE[n] = c >>> 0;
  }
  return TABLE;
}

/** CRC-32 (IEEE 802.3), as zip and PNG use it. */
export function crc32(bytes) {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s) => new TextEncoder().encode(s);

/** DOS date and time for the headers. */
function dosTime(date) {
  const d = date instanceof Date ? date : new Date();
  return {
    time: ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31),
    date: (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31)
  };
}

/**
 * Build a zip. `files` is `[{ name, data }]`, `data` a `Uint8Array` or a
 * string (written as UTF-8). Names are stored with the UTF-8 flag set.
 */
export function zipStore(files, { date = new Date() } = {}) {
  const { time, date: day } = dosTime(date);
  const entries = files.map((f) => {
    const name = utf8(String(f.name).replace(/^\/+/, ''));
    const data = typeof f.data === 'string' ? utf8(f.data) : f.data;
    return { name, data, crc: crc32(data) };
  });
  if (entries.length > 0xffff) throw new Error('too many files for a zip without zip64');

  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const local = new Uint8Array(30 + e.name.length);
    const v = new DataView(local.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);          // version needed: 2.0
    v.setUint16(6, 0x0800, true);      // flags: UTF-8 names
    v.setUint16(8, 0, true);           // method: stored
    v.setUint16(10, time, true);
    v.setUint16(12, day, true);
    v.setUint32(14, e.crc, true);
    v.setUint32(18, e.data.length, true);
    v.setUint32(22, e.data.length, true);
    v.setUint16(26, e.name.length, true);
    v.setUint16(28, 0, true);
    local.set(e.name, 30);

    const cen = new Uint8Array(46 + e.name.length);
    const c = new DataView(cen.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);          // version made by
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, day, true);
    c.setUint32(16, e.crc, true);
    c.setUint32(20, e.data.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, e.name.length, true);
    c.setUint32(42, offset, true);
    cen.set(e.name, 46);

    parts.push(local, e.data);
    central.push(cen);
    offset += local.length + e.data.length;
    if (offset > 0xffffffff) throw new Error('too large for a zip without zip64');
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * Read a stored zip back: `[{ name, data }]`. Only what `zipStore` writes —
 * used by the tests to prove the round trip, not as a general unzipper.
 */
export function unzipStore(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && v.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error('no end of central directory');
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = [];
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    if (method !== 0) throw new Error(`${name} is compressed`);
    const lname = v.getUint16(local + 26, true);
    const lextra = v.getUint16(local + 28, true);
    const data = bytes.subarray(local + 30 + lname + lextra, local + 30 + lname + lextra + size);
    if (crc32(data) !== crc) throw new Error(`${name} fails its CRC`);
    out.push({ name, data });
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

/* ---------------------------------------------------------------- reading */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const MAX32 = 0xffffffff;

/** The end-of-central-directory record: the last one in the file, comment and all. */
function findEnd(v, length) {
  /* The record is 22 bytes plus a comment of up to 65,535. */
  const floor = Math.max(0, length - 22 - 0xffff);
  for (let at = length - 22; at >= floor; at--) {
    if (v.getUint32(at, true) === SIG_EOCD) return at;
  }
  return -1;
}

const u64 = (v, at) => Number(v.getBigUint64(at, true));

/**
 * The entries of a zip, from its central directory, without reading any data:
 * `[{ name, dir, method, encrypted, crc, size, compressedSize, offset }]`.
 * Throws only when the file is not a zip at all.
 */
export function listZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = findEnd(v, bytes.length);
  if (end < 0) throw new Error('not a zip file (no end of central directory)');
  let count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  /* zip64: the 32-bit fields say "look in the zip64 record". */
  if (count === 0xffff || at === MAX32) {
    const loc = end - 20;
    if (loc < 0 || v.getUint32(loc, true) !== SIG_LOCATOR64) throw new Error('a zip64 file without its locator');
    const rec = u64(v, loc + 8);
    if (v.getUint32(rec, true) !== SIG_EOCD64) throw new Error('a zip64 file without its end record');
    count = u64(v, rec + 32);
    at = u64(v, rec + 48);
  }
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.length || v.getUint32(at, true) !== SIG_CENTRAL) throw new Error('a damaged central directory');
    const flags = v.getUint16(at + 8, true);
    const method = v.getUint16(at + 10, true);
    const crc = v.getUint32(at + 16, true);
    let compressedSize = v.getUint32(at + 20, true);
    let size = v.getUint32(at + 24, true);
    const nameLen = v.getUint16(at + 28, true);
    const extraLen = v.getUint16(at + 30, true);
    const commentLen = v.getUint16(at + 32, true);
    let offset = v.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    /* The zip64 extra field holds, in this order, whichever of the three
       the 32-bit fields could not. */
    let x = at + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = v.getUint16(x, true);
      const len = v.getUint16(x + 2, true);
      if (id === 0x0001) {
        let p = x + 4;
        if (size === MAX32) { size = u64(v, p); p += 8; }
        if (compressedSize === MAX32) { compressedSize = u64(v, p); p += 8; }
        if (offset === MAX32) { offset = u64(v, p); }
      }
      x += 4 + len;
    }
    out.push({
      name,
      dir: name.endsWith('/'),
      method,
      encrypted: (flags & 1) === 1,
      crc,
      size,
      compressedSize,
      offset
    });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * Raw deflate undone by the platform, refusing to produce more than `limit`
 * bytes — a header that lies about its size cannot fill the page's memory.
 */
export async function inflateRaw(data, limit = Infinity) {
  if (typeof DecompressionStream !== 'function') throw new Error('this browser cannot undo deflate (no DecompressionStream)');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      throw new Error('it unpacks to more than its header says');
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * One entry's bytes, checked against its CRC. Throws with a reason an
 * operator can read: encrypted, a method this does not undo, damaged.
 */
export async function readEntry(bytes, entry, { inflate = inflateRaw } = {}) {
  if (entry.encrypted) throw new Error('it is encrypted');
  if (entry.method !== 0 && entry.method !== 8) throw new Error(`it is compressed a way this cannot undo (method ${entry.method})`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.offset;
  if (at + 30 > bytes.length || v.getUint32(at, true) !== SIG_LOCAL) throw new Error('its header is damaged');
  /* The local header's own name and extra lengths: they can differ from the
     central directory's. */
  const start = at + 30 + v.getUint16(at + 26, true) + v.getUint16(at + 28, true);
  if (start + entry.compressedSize > bytes.length) throw new Error('it is cut short');
  const raw = bytes.subarray(start, start + entry.compressedSize);
  const data = entry.method === 0 ? raw : await inflate(raw, entry.size);
  if (data.length !== entry.size) throw new Error('it unpacks to the wrong size');
  if (crc32(data) !== entry.crc) throw new Error('it fails its CRC');
  return data;
}
