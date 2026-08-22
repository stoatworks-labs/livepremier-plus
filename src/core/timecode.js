/*
 * Timecode: MIDI and audio, decoded into one shape.
 *
 * A cue stack that chases timecode needs to know the time and to know when it
 * has stopped being told the time. Both of those are harder than they look,
 * and neither is specific to a transport, so both live here — pure, with no
 * MIDI port, no audio node and no clock of its own beyond what is handed in.
 *
 * ## Two sources, one answer
 *
 * **MTC** (MIDI Time Code) arrives two ways. *Quarter-frame* messages carry
 * one nibble each, eight of them spanning **two frames**, so a whole timecode
 * takes 8 messages and is already two frames old by the time it completes —
 * the standard says the reader adds 2. *Full-frame* messages are a SysEx
 * carrying the whole thing at once, sent on locate rather than continuously.
 *
 * **LTC** (Linear Time Code) is an audio signal: 80 bits per frame,
 * biphase-mark encoded, with a sync word at the end that also says which
 * direction the tape is running.
 *
 * Both end up as `{ hours, minutes, seconds, frames, rate, dropFrame }`.
 *
 * ## The thing that matters more than decoding
 *
 * **Timecode stops without saying so.** A deck paused, a cable pulled and a
 * generator switched off all look identical: the messages simply cease. So a
 * chase that trusts its last reading forever will sit there believing the show
 * is still running. `TimecodeClock` free-wheels for a short, stated window and
 * then declares itself stale, and the difference between "running" and "was
 * running" is the whole reason it exists.
 */

/* ------------------------------------------------------------------ *
 * The value type
 * ------------------------------------------------------------------ */

/** Frame rates MTC can name, in its own two-bit encoding. */
export const MTC_RATES = [
  { fps: 24, dropFrame: false },
  { fps: 25, dropFrame: false },
  { fps: 30, dropFrame: true },   /* 29.97 drop-frame */
  { fps: 30, dropFrame: false }
];

/** A timecode, and the total frame count it corresponds to. */
export function makeTimecode(hours, minutes, seconds, frames, rate = 25, dropFrame = false) {
  return { hours, minutes, seconds, frames, rate, dropFrame };
}

/**
 * Total frames since midnight.
 *
 * Drop-frame is a *labelling* scheme, not a rate: 29.97 fps runs slightly slow
 * against the wall clock, and dropping two frame numbers a minute — except
 * every tenth minute — keeps the label honest over an hour. Ignoring it makes
 * a chase drift by 3.6 seconds an hour, which is a cue landing in the wrong
 * place halfway through a show rather than an error anyone would notice.
 */
export function toFrames(tc) {
  const { hours, minutes, seconds, frames, rate, dropFrame } = tc;
  const total = ((hours * 60 + minutes) * 60 + seconds) * rate + frames;
  if (!dropFrame) return total;
  const totalMinutes = hours * 60 + minutes;
  const dropped = 2 * (totalMinutes - Math.floor(totalMinutes / 10));
  return total - dropped;
}

/** Seconds since midnight, as a float. Drop-frame runs at 30/1.001. */
export function toSeconds(tc) {
  const rate = tc.dropFrame ? tc.rate * 1000 / 1001 : tc.rate;
  return toFrames(tc) / rate;
}

/** `01:02:03:04`, or `01:02:03;04` for drop-frame, which is the convention. */
export function formatTimecode(tc) {
  if (!tc) return '--:--:--:--';
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const sep = tc.dropFrame ? ';' : ':';
  return `${p(tc.hours)}:${p(tc.minutes)}:${p(tc.seconds)}${sep}${p(tc.frames)}`;
}

/** Are two readings the same instant? */
export const sameTimecode = (a, b) =>
  !!a && !!b && a.rate === b.rate && a.dropFrame === b.dropFrame && toFrames(a) === toFrames(b);

/* ------------------------------------------------------------------ *
 * MIDI Time Code
 * ------------------------------------------------------------------ */

const QUARTER_FRAME = 0xf1;

/**
 * Decode MTC from a stream of MIDI messages.
 *
 * Quarter-frame messages are stateful — each carries one nibble and an index
 * saying which — so this holds the eight pieces and only reports a timecode
 * when a complete, in-order set has arrived. Out-of-order or partial sets are
 * discarded rather than half-applied, because a timecode assembled from two
 * different frames is a plausible-looking wrong answer.
 */
export class MtcReader {
  constructor() {
    this.pieces = new Array(8).fill(null);
    this.expect = 0;
  }

  /**
   * Feed one MIDI message.
   *
   * @param {number[]|Uint8Array} bytes
   * @returns {{timecode: object, kind: 'quarter'|'full'}|null}
   */
  push(bytes) {
    if (!bytes || bytes.length === 0) return null;
    if (bytes[0] === QUARTER_FRAME && bytes.length >= 2) return this._quarter(bytes[1]);
    return this._full(bytes);
  }

  _quarter(data) {
    const index = (data >> 4) & 0x07;
    const value = data & 0x0f;

    /* A set has to run 0..7 in order. Anything else means we joined midway or
       lost a message, so start again from whatever this one is. */
    if (index !== this.expect) {
      this.pieces.fill(null);
      if (index !== 0) { this.expect = 0; return null; }
    }
    this.pieces[index] = value;
    this.expect = (index + 1) & 0x07;
    if (index !== 7) return null;
    if (this.pieces.some((p) => p === null)) return null;

    const [f0, f1, s0, s1, m0, m1, h0, h1] = this.pieces;
    const frames = f0 | (f1 << 4);
    const seconds = s0 | (s1 << 4);
    const minutes = m0 | (m1 << 4);
    const hours = h0 | ((h1 & 0x01) << 4);
    const rateBits = (h1 >> 1) & 0x03;
    const { fps, dropFrame } = MTC_RATES[rateBits];

    this.pieces.fill(null);

    /*
     * Eight quarter-frames span two frames, so the set that has just finished
     * describes the time two frames ago. The standard has the reader add them
     * back; not doing so is a constant two-frame lag on every cue.
     */
    const tc = advance(makeTimecode(hours, minutes, seconds, frames, fps, dropFrame), 2);
    return { timecode: tc, kind: 'quarter' };
  }

  /**
   * Full-frame SysEx: `F0 7F <dev> 01 01 hh mm ss ff F7`.
   *
   * Sent when a transport locates rather than continuously, so it is the
   * message that says "we have jumped", and it is complete in one go.
   */
  _full(bytes) {
    if (bytes.length < 10) return null;
    if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f) return null;
    if (bytes[3] !== 0x01 || bytes[4] !== 0x01) return null;
    const hh = bytes[5];
    const rateBits = (hh >> 5) & 0x03;
    const { fps, dropFrame } = MTC_RATES[rateBits];
    const tc = makeTimecode(hh & 0x1f, bytes[6], bytes[7], bytes[8], fps, dropFrame);
    this.pieces.fill(null);
    this.expect = 0;
    return { timecode: tc, kind: 'full' };
  }
}

/** Move a timecode on by n frames, wrapping at 24 hours. */
export function advance(tc, n) {
  const rate = tc.rate;
  let total = toFramesLinear(tc) + n;
  const day = 24 * 60 * 60 * rate;
  total = ((total % day) + day) % day;
  const frames = total % rate;
  const totalSeconds = Math.floor(total / rate);
  return {
    ...tc,
    frames,
    seconds: totalSeconds % 60,
    minutes: Math.floor(totalSeconds / 60) % 60,
    hours: Math.floor(totalSeconds / 3600)
  };
}

/* Frame arithmetic on the *labels*, ignoring drop-frame. Advancing by two
   frames must not renumber the whole timecode, and drop-frame skips labels
   rather than frames, so label arithmetic is the right kind here. */
const toFramesLinear = (tc) =>
  ((tc.hours * 60 + tc.minutes) * 60 + tc.seconds) * tc.rate + tc.frames;

/* ------------------------------------------------------------------ *
 * Linear Time Code, off an audio signal
 * ------------------------------------------------------------------ */

/** The LTC sync word, which ends every frame: 0011 1111 1111 1101. */
const LTC_SYNC = '0011111111111101';

/**
 * Decode LTC from mono PCM.
 *
 * LTC is **biphase mark**: there is a transition at every bit boundary, and a
 * `1` has an extra transition in the middle. So a bit is read from the *time
 * between transitions* rather than from any level — which is why LTC survives
 * being recorded, copied and played back at the wrong level, and why this
 * decoder never looks at amplitude beyond finding the crossings.
 *
 * A long interval is a `0`; two short ones are a `1`. "Long" and "short" are
 * relative to a running average rather than a fixed rate, so a deck running a
 * little off-speed still decodes — and so the same code reads 24, 25 and 30
 * without being told which.
 *
 * The frame is then found by the sync word rather than by counting from the
 * start, because a stream can be joined anywhere.
 */
export class LtcReader {
  /**
   * @param {{sampleRate: number}} opts
   */
  constructor({ sampleRate = 48000 } = {}) {
    this.sampleRate = sampleRate;
    this.bits = '';
    this._lastSign = 0;
    this._sinceTransition = 0;
    /* Half a bit at 30fps/80bits is ~208us; start there and let it settle. */
    this._avgInterval = sampleRate / (30 * 80);
    this._pendingShort = false;
  }

  /**
   * Feed a block of samples. Returns every complete frame found in it.
   *
   * @param {Float32Array|number[]} samples mono, roughly -1..1
   * @returns {Array<object>} decoded timecodes, in order
   */
  push(samples) {
    const out = [];
    for (let i = 0; i < samples.length; i++) {
      const sign = samples[i] >= 0 ? 1 : -1;
      this._sinceTransition++;
      if (sign === this._lastSign || this._lastSign === 0) {
        this._lastSign = sign;
        continue;
      }
      this._lastSign = sign;
      const interval = this._sinceTransition;
      this._sinceTransition = 0;

      /* Nothing sane is more than three half-bits long; treat it as dropout
         and resynchronise rather than emitting a bit from noise. */
      if (interval > this._avgInterval * 3) {
        this._pendingShort = false;
        this._avgInterval = interval / 2;
        continue;
      }

      /*
       * `_avgInterval` tracks the **long** interval, which is one whole bit
       * period; a half-bit is therefore about half of it. Three-quarters is
       * the midpoint with room either side for a deck running off speed.
       *
       * ⚠️ This threshold is the decoder. Set too high — 1.5, say — and every
       * long interval reads as short, every bit becomes a one, and no sync
       * word is ever found: the decoder returns nothing at all rather than
       * returning something wrong, which is a fault that looks like silence.
       */
      const short = interval < this._avgInterval * 0.75;
      /* Track the long interval — one bit period — as the reference. */
      this._avgInterval = short
        ? this._avgInterval * 0.95 + interval * 2 * 0.05
        : this._avgInterval * 0.95 + interval * 0.05;

      if (short) {
        /* Two shorts make a one; a lone short waits for its partner. */
        if (this._pendingShort) { this._pendingShort = false; this._collect(out, '1'); }
        else this._pendingShort = true;
        continue;
      }
      this._pendingShort = false;
      this._collect(out, '0');
    }
    return out;
  }

  /**
   * Add one bit, and take a frame if that bit completed one.
   *
   * Checked per bit rather than once at the end of the block. The buffer is
   * capped, so draining only at the end loses whatever was pushed out of the
   * front — a caller handing over a big block would silently lose the frames
   * at the start of it, and the size of the block a caller happens to use is
   * no business of the decoder's.
   */
  _collect(out, bit) {
    this.bits += bit;
    /* Two frames' worth is plenty of runway to find a sync word in. */
    if (this.bits.length > 200) this.bits = this.bits.slice(-200);
    /* Every frame ends with the sync word, so this is the only moment a new
       one can have become available. */
    if (!this.bits.endsWith(LTC_SYNC)) return;
    const frame = this._takeFrame();
    if (frame) out.push(frame);
  }

  /**
   * Pull one frame out if a complete one has arrived, sync word and all.
   *
   * Loops rather than returning on the first disappointment, because two of
   * the three outcomes here are "that one was no good, try the next" and only
   * the third is "there is nothing more to find". Returning null for all three
   * meant a discarded partial frame stopped the caller's loop dead, and a
   * reader that had joined a stream midway then found **no frames at all** —
   * it threw away the incomplete first one and never looked at the two whole
   * ones behind it.
   */
  _takeFrame() {
    for (;;) {
      const at = this.bits.indexOf(LTC_SYNC);
      if (at < 0) return null;

      if (at < 64) {
        /* Sync found, but the 64 data bits before it are not all here — we
           joined partway through this frame. Drop it and look again. */
        const after = at + LTC_SYNC.length;
        if (after >= this.bits.length) return null;
        this.bits = this.bits.slice(after);
        continue;
      }

      const data = this.bits.slice(at - 64, at);
      this.bits = this.bits.slice(at + LTC_SYNC.length);
      const frame = decodeLtcFrame(data);
      if (frame) return frame;
      /* Sixty-four bits that cannot be a timecode: a glitch, or a sync-shaped
         run inside the data. Keep looking rather than reporting nonsense. */
    }
  }
}

/**
 * Turn 64 data bits into a timecode.
 *
 * LTC is **little-endian per field**: the units digit's bits arrive
 * least-significant first, in groups the standard lays out by bit position.
 * The rate is not transmitted at all — only the drop-frame flag is — so the
 * caller is told `null` and has to decide, which is honest: a 25 fps reader
 * and a 30 fps reader see identical bits.
 */
export function decodeLtcFrame(bits) {
  if (bits.length !== 64) return null;
  const field = (start, count) => {
    let v = 0;
    for (let i = 0; i < count; i++) if (bits[start + i] === '1') v |= 1 << i;
    return v;
  };
  const frames = field(0, 4) + field(8, 2) * 10;
  const seconds = field(16, 4) + field(24, 3) * 10;
  const minutes = field(32, 4) + field(40, 3) * 10;
  const hours = field(48, 4) + field(56, 2) * 10;
  const dropFrame = bits[10] === '1';

  if (frames > 29 || seconds > 59 || minutes > 59 || hours > 23) return null;
  return { hours, minutes, seconds, frames, rate: null, dropFrame };
}

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

/**
 * A timecode reading that knows how old it is.
 *
 * Between messages it free-wheels on the local clock, so a caller asking at
 * any moment gets a sensible answer rather than the last frame boundary. After
 * `staleAfterMs` with nothing new it stops claiming to know — because a
 * stopped generator, a pulled cable and a paused deck are indistinguishable on
 * the wire, and a stack that kept firing cues off a frozen reading would be
 * running a show from a memory of one.
 */
export class TimecodeClock extends EventTarget {
  /**
   * @param {{staleAfterMs?: number, now?: () => number, rate?: number}} opts
   */
  constructor({ staleAfterMs = 250, now = () => Date.now(), rate = 25 } = {}) {
    super();
    this.staleAfterMs = staleAfterMs;
    this.now = now;
    /* What to assume when a source cannot say — LTC never transmits its rate. */
    this.defaultRate = rate;
    this.last = null;
    this.lastAt = 0;
    this.source = null;
  }

  /** Feed a decoded timecode. */
  update(tc, source = null) {
    if (!tc) return;
    const rate = tc.rate ?? this.defaultRate;
    const next = { ...tc, rate };
    const jumped = this.last && Math.abs(toSeconds(next) - toSeconds(this.last)) > 1;
    const wasRunning = this.running;
    this.last = next;
    this.lastAt = this.now();
    this.source = source;
    if (!wasRunning) this.dispatchEvent(new CustomEvent('start', { detail: { timecode: next } }));
    if (jumped) this.dispatchEvent(new CustomEvent('jump', { detail: { timecode: next } }));
    this.dispatchEvent(new CustomEvent('timecode', { detail: { timecode: next } }));
  }

  /** True while readings are still arriving. */
  get running() {
    return this.last !== null && this.now() - this.lastAt <= this.staleAfterMs;
  }

  /**
   * Where the timecode is now, free-wheeled from the last reading.
   *
   * Returns null once stale rather than the last known value, so a caller
   * cannot accidentally treat a stopped feed as a running one.
   */
  position() {
    if (!this.running) return null;
    return toSeconds(this.last) + (this.now() - this.lastAt) / 1000;
  }

  /** The last reading, running or not, for display. */
  get reading() { return this.last; }

  /** Notice a feed that has gone away. Call on a timer. */
  poll() {
    if (this.last && !this.running && this.source !== null) {
      this.source = null;
      this.dispatchEvent(new CustomEvent('stop', { detail: { timecode: this.last } }));
    }
  }

  stop() {
    this.last = null;
    this.source = null;
    this.lastAt = 0;
  }
}
