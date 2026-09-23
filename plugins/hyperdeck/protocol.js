/*
 * The Blackmagic HyperDeck Ethernet Protocol — the words, with no socket.
 *
 * TCP 9993, text, one command per line. Pure: the parser and the command
 * builders are here so the tests can hold them against captured replies, and
 * `link.js` is the only file that opens anything.
 *
 * ## The wire
 *
 * A reply is a line starting with a three-digit code. If that line ends in a
 * colon, a block of `name: value` lines follows, ended by a blank line;
 * otherwise the line is the whole reply.
 *
 * ```text
 *   200 ok
 *   208 transport info:
 *   status: play
 *   clip id: 2
 *   timecode: 00:00:04:12
 *
 * ```
 *
 * - `1xx` is a failure (`100 syntax error`, `105 no disk`, `111 remote control
 *   disabled`) and `2xx` a success. Each command gets exactly one, in order.
 * - `5xx` is **asynchronous** — `500 connection info` on connect, then `508
 *   transport info` and the rest once `notify:` has asked for them. They are
 *   not answers, and a matcher that took one for the reply to the command in
 *   flight would pair every later reply with the wrong command.
 *
 * ## Who else speaks it
 *
 * Mitti is the reference: it answers the protocol as a HyperDeck does, which
 * is how ATEM Software Control drives it, with its cues as the clips. It
 * cannot play backwards, so it has no shuttle or jog, and it has nothing to
 * record. That difference is a *profile* below, not a special case in the
 * link, so the next player that emulates a deck is one more entry.
 *
 * ⚠️ **Never run against a real HyperDeck or a real Mitti from this repo.**
 * The parser is written from Blackmagic's published protocol (the "HyperDeck
 * Ethernet Protocol" section of the HyperDeck manual, protocol 1.11 and later)
 * and proven against `tools/hyperdeck-sim.mjs`. Prove it on your own deck
 * before a show.
 */

export const HYPERDECK_PORT = 9993;

/**
 * What each kind of deck can do. `record` is what gates the Record button and
 * the recorder role; `notify` whether it is worth asking for pushed transport
 * changes (a deck that ignores `notify:` is polled, which works on either).
 */
export const PROFILES = [
  {
    id: 'hyperdeck', label: 'Blackmagic HyperDeck', record: true, notify: true,
    what: 'A HyperDeck Studio, Shuttle or Extreme: plays and records.'
  },
  {
    id: 'mitti', label: 'Mitti (HyperDeck emulation)', record: false, notify: true,
    what: 'Mitti with HyperDeck control switched on in its preferences. Its cues are the clips; it plays but does not record.'
  },
  {
    id: 'generic', label: 'Other HyperDeck-compatible', record: true, notify: true,
    what: 'Anything else that answers the HyperDeck protocol. Record is offered; the deck will refuse it if it cannot.'
  },
];

export const profileOf = (id) => PROFILES.find((p) => p.id === id) || PROFILES[0];

/** The transport states the protocol names. */
export const STATUSES = ['preview', 'stopped', 'play', 'forward', 'rewind', 'jog', 'shuttle', 'record'];

/* ---------------------------------------------------------------- parsing */

/**
 * Feed text in, get whole replies out: `{ code, text, fields, lines }`.
 *
 * `fields` is the block's `name: value` lines as an object, keys as written
 * (`clip id`, `display timecode`). `lines` is the same block raw, which
 * `clips get` needs because its lines are `<id>: <name> <start> <duration>`
 * and its "names" are numbers.
 */
export class ReplyParser {
  constructor() {
    this.buffer = '';
    this.open = null;
  }

  push(chunk) {
    this.buffer += chunk;
    const out = [];
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (this.open) {
        if (line.trim() === '') { out.push(this.open); this.open = null; continue; }
        this.open.lines.push(line);
        const colon = line.indexOf(':');
        if (colon > 0) this.open.fields[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
        continue;
      }
      const head = /^(\d{3})\s+(.*)$/.exec(line.trim());
      if (!head) continue;
      const reply = { code: Number(head[1]), text: head[2].replace(/:$/, '').trim(), fields: {}, lines: [] };
      if (head[2].trim().endsWith(':')) this.open = reply;
      else out.push(reply);
    }
    /* A peer that never sends a newline would grow this for ever. */
    if (this.buffer.length > 256 * 1024) this.buffer = '';
    return out;
  }
}

export const isAsync = (reply) => reply.code >= 500 && reply.code < 600;
export const isError = (reply) => reply.code >= 100 && reply.code < 200;

/* ---------------------------------------------------------------- timecode */

const TC = /^(\d{1,2}):(\d{2}):(\d{2})[:;.](\d{2})$/;

/**
 * The timecode frame rate a video format counts in: `1080p50` → 50,
 * `1080i50` → 25, `1080p2997` → 29.97. Null for a format we cannot read,
 * which makes every remaining-time sum null rather than wrong.
 */
export function frameRate(format) {
  const m = /(\d{3,4})([pi])(\d{2,4})/i.exec(String(format || ''));
  if (!m) return null;
  const digits = m[3];
  let rate = digits.length > 2 ? Number(digits) / 100 : Number(digits);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  if (m[2].toLowerCase() === 'i') rate /= 2;
  return rate;
}

/** `HH:MM:SS:FF` to seconds at a rate, or null. Drop-frame is read as non-drop — near enough for a countdown. */
export function tcSeconds(tc, rate) {
  const m = TC.exec(String(tc || '').trim());
  if (!m || !rate) return null;
  const fps = Math.round(rate);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / fps;
}

export const isTimecode = (s) => TC.test(String(s || '').trim());

/* ---------------------------------------------------------------- readers */

const bool = (v) => (v === 'true' ? true : v === 'false' ? false : null);
const int = (v) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isInteger(n) ? n : null;
};

/** A `208`/`508 transport info` block, as the fields this app uses. Missing fields are absent, not null — a `508` carries only what changed. */
export function readTransport(fields) {
  const out = {};
  if ('status' in fields) out.status = fields.status;
  if ('speed' in fields) out.speed = Number(fields.speed);
  if ('slot id' in fields) out.slot = int(fields['slot id']);
  if ('clip id' in fields) out.clip = int(fields['clip id']);
  if ('single clip' in fields) out.singleClip = bool(fields['single clip']);
  if ('loop' in fields) out.loop = bool(fields.loop);
  if ('display timecode' in fields) out.displayTimecode = fields['display timecode'];
  if ('timecode' in fields) out.timecode = fields.timecode;
  if ('video format' in fields) out.videoFormat = fields['video format'];
  if ('input video format' in fields) out.inputFormat = fields['input video format'];
  return out;
}

/**
 * A `205 clips info` block. Two line shapes exist:
 *
 *   1.11 and later   `1: Opener.mov 00:00:00:00 00:00:30:00`   name, start, duration
 *   earlier          `1: Opener.mov H.264 1080p25 00:00:30:00` name, codec, format, duration
 *
 * Told apart by whether the token before the duration is a timecode. A clip
 * name may contain spaces, so the name is everything left over.
 */
export function readClips(lines) {
  const clips = [];
  for (const line of lines) {
    const m = /^\s*(\d+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const tokens = m[2].trim().split(/\s+/);
    if (!tokens.length || !tokens[0]) continue;
    let name = m[2].trim();
    let start = null;
    let duration = null;
    const last = tokens[tokens.length - 1];
    if (tokens.length >= 3 && isTimecode(last) && isTimecode(tokens[tokens.length - 2])) {
      start = tokens[tokens.length - 2];
      duration = last;
      name = tokens.slice(0, -2).join(' ');
    } else if (tokens.length >= 4 && isTimecode(last)) {
      duration = last;
      name = tokens.slice(0, -3).join(' ');
    } else if (tokens.length >= 2 && isTimecode(last)) {
      duration = last;
      name = tokens.slice(0, -1).join(' ');
    }
    clips.push({ id: Number(m[1]), name, start, duration });
  }
  return clips.sort((a, b) => a.id - b.id);
}

/** `204 device info`, or the `500 connection info` greeting. */
export function readDevice(fields) {
  return {
    model: fields.model || '',
    protocol: fields['protocol version'] || '',
    software: fields['software version'] || '',
    slots: int(fields['slot count']),
  };
}

/** `202`/`502 slot info`: whether there is a disk, and how long it can record. */
export function readSlot(fields) {
  const out = {};
  if ('slot id' in fields) out.slot = int(fields['slot id']);
  if ('status' in fields) out.status = fields.status;
  if ('volume name' in fields) out.volume = fields['volume name'];
  if ('recording time' in fields) out.recordingTime = int(fields['recording time']);
  return out;
}

/**
 * Where the playhead is in its clip, in seconds either way — or nulls when
 * the deck has not said enough to know. Needs the clip's start in the
 * timeline, which only 1.11+ lists; an older deck gets no countdown and still
 * gets its end detected by the transport stopping.
 */
export function clipPosition(transport, clips) {
  const rate = frameRate(transport.videoFormat);
  const clip = clips.find((c) => c.id === transport.clip);
  if (!clip || !rate) return { elapsed: null, remaining: null, length: null };
  const length = tcSeconds(clip.duration, rate);
  const start = tcSeconds(clip.start, rate);
  const now = tcSeconds(transport.timecode, rate);
  if (length == null || start == null || now == null) return { elapsed: null, remaining: null, length };
  const elapsed = Math.max(0, now - start);
  return { elapsed, remaining: Math.max(0, length - elapsed), length };
}

/* ---------------------------------------------------------------- commands */

/** A clip name as the protocol takes it: one line, no colon to confuse the parser. */
const clean = (s) => String(s ?? '').replace(/[\r\n:]/g, ' ').trim();

/**
 * One command's line for each thing the app asks of a deck. Every builder
 * returns the line without its newline; `link.js` adds it. Null for a
 * request that makes no sense (a clip that is not a positive integer).
 */
export const COMMANDS = {
  play: ({ loop, single } = {}) => {
    const args = [];
    if (single !== undefined) args.push(`single clip: ${!!single}`);
    if (loop !== undefined) args.push(`loop: ${!!loop}`);
    return args.length ? `play: ${args.join(' ')}` : 'play';
  },
  stop: () => 'stop',
  record: ({ name } = {}) => (clean(name) ? `record: name: ${clean(name)}` : 'record'),
  clip: ({ clip } = {}) => (Number.isInteger(Number(clip)) && Number(clip) > 0 ? `goto: clip id: ${Number(clip)}` : null),
  next: () => 'goto: clip id: +1',
  prev: () => 'goto: clip id: -1',
  rewind: () => 'goto: clip: start',
  end: () => 'goto: clip: end',
  /** Show the deck's input rather than its disk: what a recorder shows while armed. */
  preview: ({ enable = true } = {}) => `preview: enable: ${!!enable}`,
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** Commands that only a deck that records may be sent. */
export const RECORD_COMMANDS = new Set(['record', 'preview']);
