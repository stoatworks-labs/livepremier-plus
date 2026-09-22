// CRC-16/X-25: reflected polynomial 0x8408 (0x1021), init 0xFFFF, final xor 0xFFFF.
// The UCenter frame's head and body checksums both use it; verified against a
// captured keep-alive frame (test/apollo.test.js).

const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  TABLE[i] = c;
}

/** @param {Uint8Array} data */
export function crc16x25(data) {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ data[i]) & 0xff];
  return ~crc & 0xffff;
}
