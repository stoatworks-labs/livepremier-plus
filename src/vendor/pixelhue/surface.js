// The U5 mini's "Event Controller" surface protocol — TCP 17100 on the console.
//
// This is what the console's `Lcd` process serves and what Pixelhue's own Companion
// surface plugin (`surface-pixelhue-u5-mini`) speaks. Discovery is mDNS `_pixelhue._tcp`
// with TXT `sn`, `version`, `model`, `displayName`, `rows`, `cols`.
//
//   offset  size  field
//   0       4     10 30 50 00        magic
//   4       2     u16 LE packet type  0 = request, 1 = response
//   6       2     u16 LE version      0x0101
//   8       2     u16 LE sequence id
//   10      2     u16 LE total length (12 + TLVs)
//   12      ...   TLV: u16 LE tag (1 = request data, 2 = response data), u16 LE length, JSON
//
// A request body is a JSON array (one object per item); a response body is an object.
// Heartbeat is out-of-band: the raw bytes "ping" from the client, "pong" back, every 5 s.
//
// Host → panel:  [{ page, column, row, data: "base64,<PNG 72×72 base64>" }]   draw one key
// Panel → host:  { page, row, column, type: 0 | 1 }                            0 press, 1 release
//
// Rows/columns are 0-based in a 4 × 10 grid on the U5 mini.
//
// What the console's LCD app does with them (V1.0.3, read from liblcdkeyboardproxyimpl.so and
// liblcdcompanionimpl.so; docs/protocols.md has the detail):
//
// - A row of the grid is one of the four bus rows. It shows a client's drawing only while the
//   operator has switched it to its Companion module with the row's area-switch key; the console
//   keeps what was drawn for the other rows until then.
// - `page` is the row's page. A draw for another page moves the row to it, and a press reports the
//   page the row shows. The vendor plugin always sends a number (Companion's page, 1 if none),
//   so this does too: what the LCD app makes of a null is unknown.
// - One client at a time. A LAN client takes the grid from a localhost one (the console's
//   built-in Companion) and from another LAN address; a second connection from the address
//   already holding it, or from localhost while a LAN client holds it, is closed.

export const SURFACE_MAGIC = Buffer.from([0x10, 0x30, 0x50, 0x00]);
export const SURFACE_PORT = 17100;
export const SURFACE_VERSION = 0x0101;
export const SURFACE_HEAD = 12;
export const TAG_REQUEST = 1;
export const TAG_RESPONSE = 2;
export const PING = Buffer.from('ping', 'ascii');
export const PONG = Buffer.from('pong', 'ascii');
export const MDNS_TYPE = 'pixelhue';
export const KEY_ICON_SIZE = 72;
export const GRID_ROWS = 4;
export const GRID_COLUMNS = 10;

let sequence = 0;
export function nextSeq() {
  sequence = (sequence + 1) & 0xffff;
  return sequence;
}

/**
 * Build one packet.
 * @param {any} data        object (response) or object/array (request)
 * @param {object} [o]
 * @param {number} [o.packetType]  0 request (default), 1 response
 * @param {number} [o.seq]
 * @param {number} [o.tag]         defaults to 1 for requests, 2 for responses
 * @param {boolean} [o.raw]        send `data` as-is instead of wrapping a request in an array
 *                                 (the panel's own key events are bare objects)
 */
export function encodePacket(data, { packetType = 0, seq = nextSeq(), tag, raw = false } = {}) {
  const body = packetType === 1 || raw
    ? JSON.stringify(data ?? {})
    : JSON.stringify(data == null ? [] : Array.isArray(data) ? data : [data]);
  const payload = Buffer.from(body, 'utf8');
  const tlvTag = tag ?? (packetType === 1 ? TAG_RESPONSE : TAG_REQUEST);
  if (payload.length + 4 > 0xffff) throw new Error(`surface payload too large: ${payload.length}`);
  const out = Buffer.alloc(SURFACE_HEAD + 4 + payload.length);
  SURFACE_MAGIC.copy(out, 0);
  out.writeUInt16LE(packetType & 0xffff, 4);
  out.writeUInt16LE(SURFACE_VERSION, 6);
  out.writeUInt16LE(seq & 0xffff, 8);
  out.writeUInt16LE(out.length & 0xffff, 10);
  out.writeUInt16LE(tlvTag & 0xffff, 12);
  out.writeUInt16LE(payload.length & 0xffff, 14);
  payload.copy(out, 16);
  return out;
}

/** Decode one complete packet (as produced by SurfaceStream). */
export function decodePacket(buf) {
  if (buf.length < SURFACE_HEAD) throw new Error('surface packet too short');
  if (!buf.subarray(0, 4).equals(SURFACE_MAGIC)) throw new Error('bad surface magic');
  const packetType = buf.readUInt16LE(4);
  const version = buf.readUInt16LE(6);
  const seq = buf.readUInt16LE(8);
  const total = buf.readUInt16LE(10);
  if (total < SURFACE_HEAD || buf.length < total) throw new Error('surface packet truncated');
  const tlvs = [];
  let at = SURFACE_HEAD;
  while (at + 4 <= total) {
    const tag = buf.readUInt16LE(at);
    const len = buf.readUInt16LE(at + 2);
    if (at + 4 + len > total) break;
    const raw = buf.subarray(at + 4, at + 4 + len);
    let json = null;
    const text = raw.toString('utf8').replace(/\0+$/, '');
    if (text.length) {
      try { json = JSON.parse(text); } catch { json = text; }
    }
    tlvs.push({ tag, raw, json });
    at += 4 + len;
  }
  const want = packetType === 1 ? TAG_RESPONSE : TAG_REQUEST;
  const chosen = tlvs.find((t) => t.tag === want) ?? tlvs[0];
  return { packetType, isResponse: packetType === 1, version, seq, total, tlvs, data: chosen?.json ?? null };
}

/**
 * Splits a TCP byte stream into packets, discarding the out-of-band "ping"/"pong"
 * heartbeats and anything unframed. Feed it chunks, take packets.
 */
export class SurfaceStream {
  #buf = Buffer.alloc(0);

  /** @returns {{packets: Buffer[], heartbeats: string[]}} */
  push(chunk) {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : Buffer.from(chunk);
    const packets = [];
    const heartbeats = [];
    for (;;) {
      if (this.#buf.length >= 4) {
        const head4 = this.#buf.subarray(0, 4);
        if (head4.equals(PING) || head4.equals(PONG)) {
          heartbeats.push(head4.toString('ascii'));
          this.#buf = this.#buf.subarray(4);
          continue;
        }
      }
      const at = this.#buf.indexOf(SURFACE_MAGIC);
      if (at < 0) {
        // keep a tail that could be the start of a magic split across chunks
        if (this.#buf.length > 3) this.#buf = this.#buf.subarray(this.#buf.length - 3);
        break;
      }
      if (at > 0) this.#buf = this.#buf.subarray(at);
      if (this.#buf.length < SURFACE_HEAD) break;
      const total = this.#buf.readUInt16LE(10);
      if (total < SURFACE_HEAD) {
        this.#buf = this.#buf.subarray(1);
        continue;
      }
      if (this.#buf.length < total) break;
      packets.push(Buffer.from(this.#buf.subarray(0, total)));
      this.#buf = this.#buf.subarray(total);
    }
    return { packets, heartbeats };
  }
}

/** Build the host→panel draw request for one key image. `page` is the row's page, from 1. */
export function encodeDraw({ column, row, png, page = 1 }, opts) {
  const b64 = Buffer.isBuffer(png) ? png.toString('base64') : String(png);
  return encodePacket({ page, column, row, data: `base64,${b64}` }, opts);
}

/**
 * Interpret a panel→host packet body as a key event, or null. `page` is the page the row
 * showed when the key went down or up, or null when the event did not say.
 */
export function keyEventFrom(data) {
  const d = Array.isArray(data) ? data[0] : data;
  if (!d || typeof d !== 'object') return null;
  if (d.type !== 0 && d.type !== 1) return null;
  const page = Number.isInteger(d.page) ? d.page : null;
  return { pressed: d.type === 0, column: Number(d.column), row: Number(d.row), page };
}
