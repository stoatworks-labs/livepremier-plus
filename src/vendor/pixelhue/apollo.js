// The UCenter WebSocket frame ("Apollo 2.0" / "NOVA" uniform protocol).
//
// Every message on the console's control WebSocket — U5 mini `ws://<ip>:8088/unico/v1/ucenter/ws`,
// U5 / U5 Pro `ws://127.0.0.1:19999/unico/v1/ucenter/ws` — is one binary frame:
//
//   offset  size  field
//   0       4     "NOVA"                      frame delimiter
//   4       1     0                           (unused)
//   5       1     1                           frame body format: 1 = the TLV/JSON body below
//   6       10    0                           reserved
//   16      2     u16 LE  body length         = frame length - 22
//   18      2     u16 LE  body checksum       CRC-16/X-25 over bytes [22, end)
//   20      2     u16 LE  head checksum       CRC-16/X-25 over bytes [0, 20)
//   22      3     u24 LE  sequence id         request id, echoed in the reply
//   25      1     0
//   26      1     total packets               1 unless the message is split
//   27      5     0                           (packet index lives here when split)
//   32      ...   TLV1                        header: u32 LE code, u16 LE error/length-high, u16 LE length, JSON
//   ...     ...   TLV2                        body:   u32 LE code (the message tag), u16 LE, u16 LE length, JSON
//
// The header JSON is always `{"seq":0,"sn":"","source":""}` from the vendor's own clients.
// The tag in TLV2 says what the body means (see tags.js). Both CRCs were checked
// against a captured keep-alive frame; see test/apollo.test.js.
//
// WebSocket messages are self-delimiting, so decoding trusts the buffer length over the
// length fields and only uses the "length-high" word when the low word does not fit.

import { crc16x25 } from './crc16.js';

export const MAGIC = Buffer.from('NOVA', 'ascii');
export const HEADER_TAG = 0x00102101; // TLV1 code the vendor's keep-alive carries
export const FRAME_HEAD = 32;
export const TLV_HEAD = 8;

/** The vendor's keep-alive: seq 2, empty body under tag 0. Sent once a second by Unico. */
export const PING = Buffer.from([
  78, 79, 86, 65, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 57, 0, 169, 18, 7, 140, 2, 0, 0, 0, 1, 0, 0,
  0, 0, 0, 1, 33, 16, 0, 0, 0, 29, 0, 123, 34, 115, 101, 113, 34, 58, 48, 44, 34, 115, 110, 34, 58,
  34, 34, 44, 34, 115, 111, 117, 114, 99, 101, 34, 58, 34, 34, 125, 0, 0, 0, 0, 0, 0, 2, 0, 123, 125,
]);

const DEFAULT_HEADER = { seq: 0, sn: '', source: '' };

function tlv(code, json) {
  const payload = Buffer.from(JSON.stringify(json ?? {}), 'utf8');
  const out = Buffer.alloc(TLV_HEAD + payload.length);
  out.writeUInt32LE(code >>> 0, 0);
  out.writeUInt16LE((payload.length >>> 16) & 0xffff, 4);
  out.writeUInt16LE(payload.length & 0xffff, 6);
  payload.copy(out, TLV_HEAD);
  return out;
}

/**
 * Build one frame.
 * @param {object} o
 * @param {number} o.tag       TLV2 command code
 * @param {any}    [o.data]    TLV2 JSON body (object or array)
 * @param {object} [o.header]  TLV1 JSON header, defaults to {seq:0,sn:"",source:""}
 * @param {number} [o.seq]     sequence id (u24)
 * @param {number} [o.headerTag]
 */
export function encodeFrame({ tag, data = {}, header = DEFAULT_HEADER, seq = 1, headerTag = HEADER_TAG }) {
  const body = Buffer.concat([tlv(headerTag, header), tlv(tag, data)]);
  const frame = Buffer.alloc(FRAME_HEAD + body.length);
  MAGIC.copy(frame, 0);
  frame[5] = 1;
  frame.writeUInt16LE((frame.length - 22) & 0xffff, 16);
  frame.writeUIntLE(seq & 0xffffff, 22, 3);
  frame[26] = 1;
  body.copy(frame, FRAME_HEAD);
  frame.writeUInt16LE(crc16x25(frame.subarray(22)), 18);
  frame.writeUInt16LE(crc16x25(frame.subarray(0, 20)), 20);
  return frame;
}

function parseJson(buf) {
  const text = buf.toString('utf8');
  if (!text.length) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readTlv(buf, at) {
  if (buf.length < at + TLV_HEAD) throw new Error(`frame truncated at TLV offset ${at}`);
  const code = buf.readUInt32LE(at);
  const high = buf.readUInt16LE(at + 4);
  const low = buf.readUInt16LE(at + 6);
  const remaining = buf.length - at - TLV_HEAD;
  let length = low;
  let error = 0;
  if (low > remaining) throw new Error(`TLV length ${low} exceeds frame (${remaining} left)`);
  if (high !== 0) {
    const ext = (high << 16) + low;
    if (ext === remaining) length = ext; // extended length: this TLV is the last one and huge
    else error = high; // otherwise the word is an error code (responses)
  }
  const raw = buf.subarray(at + TLV_HEAD, at + TLV_HEAD + length);
  return { code, error, length, raw, json: parseJson(raw), next: at + TLV_HEAD + length };
}

/**
 * Decode one frame. Throws on a bad delimiter or truncation; does not verify checksums
 * unless asked (the vendor's own parser runs with checksums off).
 */
export function decodeFrame(input, { verifyChecksums = false } = {}) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < FRAME_HEAD + TLV_HEAD) throw new Error(`frame too short (${buf.length} bytes)`);
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error('bad frame delimiter');
  if (verifyChecksums) {
    const head = buf.readUInt16LE(20);
    const body = buf.readUInt16LE(18);
    if (crc16x25(buf.subarray(0, 20)) !== head) throw new Error('head checksum mismatch');
    if (crc16x25(buf.subarray(22)) !== body) throw new Error('body checksum mismatch');
  }
  const seq = buf.readUIntLE(22, 3);
  const totalPackets = buf[26] || 1;
  const header = readTlv(buf, FRAME_HEAD);
  const body = readTlv(buf, header.next);
  return {
    seq,
    totalPackets,
    bodyLength: buf.readUInt16LE(16),
    header: { tag: header.code, error: header.error, json: header.json },
    tag: body.code,
    error: body.error,
    data: body.json,
    raw: body.raw,
  };
}

export function isPing(buf) {
  return Buffer.isBuffer(buf) && buf.length === PING.length && buf.equals(PING);
}
