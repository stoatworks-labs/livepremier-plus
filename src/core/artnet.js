/*
 * Art-Net 4, the parts a node that listens needs — no I/O.
 *
 * A lighting desk drives this app the way it drives a media server: it sends
 * ArtDmx to UDP 6454, and it finds what is on the network by broadcasting
 * ArtPoll and listing whoever answers with an ArtPollReply. This reads the
 * first, answers the second, and reads ArtTimeCode, which a desk (MagicQ, of
 * the four this was written for) can send to chase a timeline.
 *
 * Read from the Art-Net 4 specification, V1.4 revision 1.4dp (23 Oct 2025),
 * Artistic Licence. Every number below that is not obvious names the field it
 * comes from.
 *
 * ## Two things that catch people out
 *
 * - **The OpCode is little-endian and the protocol version is big-endian**,
 *   in the same header. So is everything else: ArtDmx's Length is hi-lo,
 *   ArtPollReply's Port is lo-hi. Each field below says which.
 * - **A Port-Address is 15 bits** — Net (7) : Sub-Net (4) : Universe (4) —
 *   and it is the number this file deals in. Desks show it three ways
 *   (0:0:0, universe 0, "universe 1"); `server.js` explains the one the
 *   settings card uses.
 */

export const ARTNET_PORT = 6454;
const ID = 'Art-Net\0';

export const OP = Object.freeze({
  POLL: 0x2000,
  POLL_REPLY: 0x2100,
  DMX: 0x5000,
  SYNC: 0x5200,
  TIMECODE: 0x9700,
});

/* ArtPollReply, the fields this node sets. */
export const STYLE_MEDIA = 0x02;        /* StMedia: "a media server" */
const PORT_OUTPUT = 0x80;               /* PortTypes bit 7: can output data from Art-Net */
const GOOD_OUTPUT_ACTIVE = 0x80;        /* GoodOutputA bit 7: data is being output */
const STATUS1 = 0xe0;                   /* indicators normal; Port-Address set by network or web */
const STATUS2 = 0x08 | 0x01;            /* 15-bit Port-Address; configured through a web browser */
export const OEM_UNKNOWN = 0x00ff;      /* "OemUnknown", until an OEM code is issued */
const REPLY_LENGTH = 239;

/** The ArtTimeCode `Type` field. */
export const TIMECODE_TYPES = Object.freeze([
  { type: 0, rate: 24, dropFrame: false, name: 'Film (24)' },
  { type: 1, rate: 25, dropFrame: false, name: 'EBU (25)' },
  { type: 2, rate: 30, dropFrame: true, name: 'DF (29.97)' },
  { type: 3, rate: 30, dropFrame: false, name: 'SMPTE (30)' },
]);

/**
 * Read one Art-Net packet. Anything that is not Art-Net, or is too short for
 * its own OpCode, is null — a port this public hears all sorts.
 *
 * @param {Uint8Array} buf
 * @returns {null | {op:number} & object}
 */
export function parseArtnet(buf) {
  if (!buf || buf.length < 12) return null;
  for (let i = 0; i < 8; i++) if (buf[i] !== ID.charCodeAt(i)) return null;
  const op = buf[8] | (buf[9] << 8);                         /* OpCode: lo-hi */

  switch (op) {
    case OP.DMX: {
      if (buf.length < 18) return null;
      const portAddress = ((buf[15] & 0x7f) << 8) | buf[14];  /* Net : SubUni */
      let length = (buf[16] << 8) | buf[17];                  /* Length: hi-lo, 2–512 */
      length = Math.min(length, 512, buf.length - 18);
      return {
        op,
        sequence: buf[12],                                    /* 0 = sequencing off */
        physical: buf[13],
        portAddress,
        data: buf.subarray(18, 18 + length),
      };
    }
    case OP.POLL:
      return { op, flags: buf.length > 12 ? buf[12] : 0 };
    case OP.SYNC:
      return { op };
    case OP.TIMECODE: {
      if (buf.length < 19) return null;
      const type = buf[18] & 3;
      return {
        op,
        streamId: buf[13],                                    /* 0 = the master stream */
        frames: buf[14], seconds: buf[15], minutes: buf[16], hours: buf[17],
        type,
        rate: TIMECODE_TYPES[type].rate,
        dropFrame: TIMECODE_TYPES[type].dropFrame,
      };
    }
    default:
      return { op };
  }
}

/** A Port-Address split the way the wire and most desks show it. */
export function splitPortAddress(pa) {
  return { net: (pa >> 8) & 0x7f, subNet: (pa >> 4) & 0x0f, universe: pa & 0x0f };
}

export const formatPortAddress = (pa) => {
  const { net, subNet, universe } = splitPortAddress(pa);
  return `${net}:${subNet}:${universe}`;
};

/**
 * The ArtPollReplies that describe this node, one per four ports.
 *
 * A reply carries at most four ports, and they share one Net and Sub-Net, so
 * universes are grouped by their top eleven bits and each group of up to four
 * is a reply of its own, told apart by `BindIndex` (1, 2, …). That is the
 * spec's answer for a node with more than four universes.
 *
 * ⚠️ Titan's manual says a device can only advertise four universes and that
 * it makes "unpolled" extras itself, so a reply past the first may be ignored
 * there. Nothing breaks if it is: the desk sends to the universe either way.
 *
 * @param {object} o
 * @param {number[]} o.ip           this node's IPv4 address, four numbers
 * @param {number[]} [o.mac]        six numbers, zeros if unknown
 * @param {number[]} o.universes    Port-Addresses this node listens to
 * @param {string} o.shortName      ≤ 17 ASCII characters
 * @param {string} o.longName       ≤ 63 ASCII characters
 * @param {string} [o.report]       the NodeReport text
 * @param {number} [o.replies]      a counter for NodeReport, as the spec asks
 * @param {Set<number>} [o.active]  universes receiving data now
 * @returns {Uint8Array[]}
 */
export function buildPollReplies({ ip, mac = [0, 0, 0, 0, 0, 0], universes, shortName, longName, report = 'OK', replies = 0, active = new Set() }) {
  const groups = new Map();
  for (const pa of [...new Set(universes)].sort((a, b) => a - b)) {
    const top = pa >> 4;
    const list = groups.get(top) || [];
    groups.set(top, list);
    list.push(pa);
  }
  const chunks = [];
  for (const list of groups.values()) {
    for (let i = 0; i < list.length; i += 4) chunks.push(list.slice(i, i + 4));
  }
  /* A node with nothing patched still answers, with no ports: it is there. */
  if (!chunks.length) chunks.push([]);

  return chunks.map((ports, index) => {
    const b = new Uint8Array(REPLY_LENGTH);
    ascii(b, 0, ID, 8);
    b[8] = OP.POLL_REPLY & 0xff; b[9] = OP.POLL_REPLY >> 8;
    b.set(ip.slice(0, 4), 10);
    b[14] = ARTNET_PORT & 0xff; b[15] = ARTNET_PORT >> 8;     /* Port: lo-hi */
    b[16] = 0; b[17] = 1;                                     /* VersInfo: firmware revision */
    const top = ports.length ? ports[0] >> 4 : 0;
    b[18] = (top >> 4) & 0x7f;                                /* NetSwitch */
    b[19] = top & 0x0f;                                       /* SubSwitch */
    b[20] = OEM_UNKNOWN >> 8; b[21] = OEM_UNKNOWN & 0xff;     /* Oem: hi-lo */
    b[23] = STATUS1;
    ascii(b, 26, shortName, 18);
    ascii(b, 44, longName, 64);
    ascii(b, 108, `#0001 [${String(replies % 10000).padStart(4, '0')}] ${report}`, 64);
    b[172] = 0; b[173] = ports.length;                        /* NumPorts: hi-lo */
    ports.forEach((pa, i) => {
      b[174 + i] = PORT_OUTPUT;
      b[182 + i] = active.has(pa) ? GOOD_OUTPUT_ACTIVE : 0;
      b[190 + i] = pa & 0x0f;                                 /* SwOut */
    });
    b[200] = STYLE_MEDIA;
    b.set(mac.slice(0, 6), 201);
    b.set(ip.slice(0, 4), 207);                               /* BindIp */
    b[211] = index + 1;                                       /* BindIndex */
    b[212] = STATUS2;
    return b;
  });
}

/** Write ASCII into a fixed field, NUL-padded and NUL-terminated. */
function ascii(b, at, text, size) {
  const s = String(text).replace(/[^\x20-\x7e]/g, '?');
  const n = Math.min(s.length, size - 1);
  for (let i = 0; i < n; i++) b[at + i] = s.charCodeAt(i);
}

/**
 * An ArtDmx packet. The app never sends one to a switcher; tests and the
 * fake desk in `tools/` do, and a status universe will.
 */
export function buildArtDmx(portAddress, data, { sequence = 0, physical = 0 } = {}) {
  const length = Math.max(2, Math.min(512, data.length + (data.length & 1)));
  const b = new Uint8Array(18 + length);
  ascii(b, 0, ID, 8);
  b[8] = OP.DMX & 0xff; b[9] = OP.DMX >> 8;
  b[10] = 0; b[11] = 14;                                      /* ProtVer: hi-lo */
  b[12] = sequence; b[13] = physical;
  b[14] = portAddress & 0xff; b[15] = (portAddress >> 8) & 0x7f;
  b[16] = length >> 8; b[17] = length & 0xff;
  b.set(data.subarray ? data.subarray(0, 512) : data.slice(0, 512), 18);
  return b;
}

/** An ArtPoll, for tests and the fake desk. */
export function buildArtPoll() {
  const b = new Uint8Array(14);
  ascii(b, 0, ID, 8);
  b[8] = OP.POLL & 0xff; b[9] = OP.POLL >> 8;
  b[10] = 0; b[11] = 14;
  return b;
}

/** An ArtTimeCode, for tests and the fake desk. */
export function buildArtTimeCode({ hours, minutes, seconds, frames, type = 1, streamId = 0 }) {
  const b = new Uint8Array(19);
  ascii(b, 0, ID, 8);
  b[8] = OP.TIMECODE & 0xff; b[9] = OP.TIMECODE >> 8;
  b[10] = 0; b[11] = 14;
  b[13] = streamId;
  b[14] = frames; b[15] = seconds; b[16] = minutes; b[17] = hours; b[18] = type & 3;
  return b;
}

/** Read one ArtPollReply back — what a desk sees. Tests use it. */
export function parsePollReply(b) {
  if (!b || b.length < 213) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== ID.charCodeAt(i)) return null;
  if ((b[8] | (b[9] << 8)) !== OP.POLL_REPLY) return null;
  const text = (at, size) => {
    let s = '';
    for (let i = at; i < at + size && b[i]; i++) s += String.fromCharCode(b[i]);
    return s;
  };
  const numPorts = b[173];
  const top = ((b[18] & 0x7f) << 4) | (b[19] & 0x0f);
  return {
    ip: [...b.subarray(10, 14)],
    port: b[14] | (b[15] << 8),
    shortName: text(26, 18),
    longName: text(44, 64),
    report: text(108, 64),
    style: b[200],
    bindIndex: b[211],
    universes: Array.from({ length: numPorts }, (_, i) => (top << 4) | (b[190 + i] & 0x0f)),
    active: Array.from({ length: numPorts }, (_, i) => (b[182 + i] & GOOD_OUTPUT_ACTIVE) !== 0),
  };
}
