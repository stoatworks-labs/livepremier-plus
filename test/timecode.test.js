/*
 * Timecode, decoded from both transports.
 *
 * The LTC tests do not use a recording: they *encode* a timecode into a
 * biphase-mark audio signal and decode it back. A fixture would only prove the
 * decoder still agrees with itself, whereas a round trip through a signal
 * built to the standard's own rules — transition every bit, extra transition
 * mid-bit for a one, sync word last — tests the thing that actually has to
 * hold. The encoder is in this file rather than in `src/`, deliberately: it
 * is a test instrument, and shipping it would invite someone to trust it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MtcReader, LtcReader, TimecodeClock, decodeLtcFrame,
  makeTimecode, toFrames, toSeconds, formatTimecode, advance, sameTimecode
} from '../src/core/timecode.js';
import { TimecodeChase, parseTimecodeString } from '../src/core/chase.js';

/* ------------------------------------------------------------------ *
 * Arithmetic
 * ------------------------------------------------------------------ */

test('a timecode counts frames since midnight', () => {
  assert.equal(toFrames(makeTimecode(0, 0, 0, 0, 25)), 0);
  assert.equal(toFrames(makeTimecode(0, 0, 1, 0, 25)), 25);
  assert.equal(toFrames(makeTimecode(1, 2, 3, 4, 25)), ((1 * 60 + 2) * 60 + 3) * 25 + 4);
});

/*
 * Drop-frame is a labelling scheme, not a rate. Two frame *numbers* are
 * skipped each minute except every tenth, so that the label keeps up with the
 * wall clock on a 29.97 signal. Ignoring it drifts 3.6 seconds an hour — a cue
 * landing visibly late halfway through a show, with nothing to say why.
 */
test('drop-frame skips the labels it is supposed to', () => {
  const dropped = (h, m) =>
    toFrames(makeTimecode(h, m, 0, 0, 30, false)) - toFrames(makeTimecode(h, m, 0, 0, 30, true));
  assert.equal(dropped(1, 0), 108, 'an hour drops 108 frame numbers');
  /* Two per minute, except every tenth — so the tenth minute adds none. */
  assert.equal(dropped(0, 9), 18);
  assert.equal(dropped(0, 10), 18, 'minute ten is exempt');
  assert.equal(dropped(0, 11), 20);
});

/*
 * Drop-frame exists so that the label keeps up with the wall clock on a 29.97
 * signal: one hour of drop-frame timecode really is one hour. The same signal
 * labelled as though it were 30 fps would read 3603.6 seconds, and that 3.6
 * seconds an hour is the drift a chase inherits if this is ignored.
 */
test('drop-frame runs on the slow clock it was invented for', () => {
  assert.ok(Math.abs(toSeconds(makeTimecode(1, 0, 0, 0, 30, true)) - 3600) < 0.01,
    toSeconds(makeTimecode(1, 0, 0, 0, 30, true)));
  assert.ok(Math.abs(toSeconds(makeTimecode(1, 0, 0, 0, 30, false)) - 3600) < 0.01,
    'a non-drop label at a nominal 30 is exactly an hour by its own reckoning');
});

test('a timecode is written the way the industry writes it', () => {
  assert.equal(formatTimecode(makeTimecode(1, 2, 3, 4, 25)), '01:02:03:04');
  /* The semicolon is how drop-frame is spelt, and it is worth showing. */
  assert.equal(formatTimecode(makeTimecode(1, 2, 3, 4, 30, true)), '01:02:03;04');
  assert.equal(formatTimecode(null), '--:--:--:--');
});

test('advancing rolls over the fields and wraps at midnight', () => {
  assert.deepEqual(pick(advance(makeTimecode(0, 0, 0, 24, 25), 1)), [0, 0, 1, 0]);
  assert.deepEqual(pick(advance(makeTimecode(0, 0, 59, 24, 25), 1)), [0, 1, 0, 0]);
  assert.deepEqual(pick(advance(makeTimecode(23, 59, 59, 24, 25), 1)), [0, 0, 0, 0]);
  assert.deepEqual(pick(advance(makeTimecode(0, 0, 1, 0, 25), -1)), [0, 0, 0, 24]);
});

const pick = (tc) => [tc.hours, tc.minutes, tc.seconds, tc.frames];

/* ------------------------------------------------------------------ *
 * MIDI Time Code
 * ------------------------------------------------------------------ */

/** The eight quarter-frame messages for one timecode, in order. */
function quarterFrames(h, m, s, f, rateBits = 1) {
  const hi = (h & 0x1f) | (rateBits << 5);
  const nibbles = [
    f & 0x0f, (f >> 4) & 0x0f,
    s & 0x0f, (s >> 4) & 0x0f,
    m & 0x0f, (m >> 4) & 0x0f,
    hi & 0x0f, (hi >> 4) & 0x0f
  ];
  return nibbles.map((v, i) => [0xf1, (i << 4) | v]);
}

/*
 * Eight quarter-frames span two frames, so a completed set describes the time
 * two frames ago and the reader adds them back. Without this every cue fires
 * two frames late, for ever, with nothing to show for it.
 */
test('a full set of quarter-frames decodes, two frames ahead of where it started', () => {
  const reader = new MtcReader();
  let got = null;
  for (const msg of quarterFrames(1, 2, 3, 4)) got = reader.push(msg) || got;
  assert.ok(got, 'a complete set reports something');
  assert.equal(got.kind, 'quarter');
  assert.deepEqual(pick(got.timecode), [1, 2, 3, 6], 'four plus the standard two');
  assert.equal(got.timecode.rate, 25);
});

test('nothing is reported until the set is complete', () => {
  const reader = new MtcReader();
  const msgs = quarterFrames(1, 2, 3, 4);
  for (const msg of msgs.slice(0, 7)) assert.equal(reader.push(msg), null);
  assert.ok(reader.push(msgs[7]));
});

/*
 * Joining a stream midway is the normal case, not the exception — the reader
 * is started while the generator is already running. A timecode assembled from
 * the tail of one frame and the head of the next would be a plausible-looking
 * wrong answer, so partial sets are dropped.
 */
test('joining midway discards the partial set rather than assembling nonsense', () => {
  const reader = new MtcReader();
  const msgs = quarterFrames(1, 2, 3, 4);
  for (const msg of msgs.slice(4)) assert.equal(reader.push(msg), null, 'the tail alone says nothing');
  let got = null;
  for (const msg of quarterFrames(9, 8, 7, 6)) got = reader.push(msg) || got;
  assert.deepEqual(pick(got.timecode), [9, 8, 7, 8]);
});

test('a dropped message resynchronises instead of shifting every nibble', () => {
  const reader = new MtcReader();
  const msgs = quarterFrames(1, 2, 3, 4);
  for (const [i, msg] of msgs.entries()) if (i !== 3) reader.push(msg);
  let got = null;
  for (const msg of quarterFrames(2, 0, 0, 0)) got = reader.push(msg) || got;
  assert.deepEqual(pick(got.timecode), [2, 0, 0, 2]);
});

test('every frame rate MTC can name is decoded', () => {
  const expect = [[24, false], [25, false], [30, true], [30, false]];
  for (const [bits, [fps, drop]] of expect.entries()) {
    const reader = new MtcReader();
    let got = null;
    for (const msg of quarterFrames(0, 0, 0, 0, bits)) got = reader.push(msg) || got;
    assert.equal(got.timecode.rate, fps, 'rate bits ' + bits);
    assert.equal(got.timecode.dropFrame, drop, 'drop bits ' + bits);
  }
});

/* Full-frame is what a transport sends when it locates: complete in one
   message, and the signal that the time has jumped rather than advanced. */
test('a full-frame SysEx decodes whole, with no two-frame offset', () => {
  const reader = new MtcReader();
  const got = reader.push([0xf0, 0x7f, 0x7f, 0x01, 0x01, (1 << 5) | 10, 20, 30, 12, 0xf7]);
  assert.equal(got.kind, 'full');
  assert.deepEqual(pick(got.timecode), [10, 20, 30, 12]);
  assert.equal(got.timecode.rate, 25);
});

test('a full frame clears any half-collected quarter-frame set', () => {
  const reader = new MtcReader();
  for (const msg of quarterFrames(1, 2, 3, 4).slice(0, 5)) reader.push(msg);
  reader.push([0xf0, 0x7f, 0x7f, 0x01, 0x01, (1 << 5) | 5, 0, 0, 0, 0xf7]);
  const msgs = quarterFrames(6, 0, 0, 0);
  for (const msg of msgs.slice(0, 7)) assert.equal(reader.push(msg), null);
  const got = reader.push(msgs[7]);
  assert.deepEqual(pick(got.timecode), [6, 0, 0, 2]);
});

test('MIDI that is not timecode is ignored', () => {
  const reader = new MtcReader();
  assert.equal(reader.push([0x90, 60, 100]), null, 'a note on');
  assert.equal(reader.push([0xf8]), null, 'a clock tick');
  assert.equal(reader.push([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]), null, 'a different SysEx');
  assert.equal(reader.push([]), null);
});

/* ------------------------------------------------------------------ *
 * Linear Time Code
 * ------------------------------------------------------------------ */

/** The 64 data bits of an LTC frame, little-endian per field as the standard has it. */
function ltcBits(h, m, s, f, dropFrame = false) {
  const bits = new Array(80).fill('0');
  const put = (start, count, value) => {
    for (let i = 0; i < count; i++) bits[start + i] = (value >> i) & 1 ? '1' : '0';
  };
  put(0, 4, f % 10); put(8, 2, Math.floor(f / 10));
  put(16, 4, s % 10); put(24, 3, Math.floor(s / 10));
  put(32, 4, m % 10); put(40, 3, Math.floor(m / 10));
  put(48, 4, h % 10); put(56, 2, Math.floor(h / 10));
  if (dropFrame) bits[10] = '1';
  /* The sync word is the last 16 bits and is what a reader finds the frame by. */
  for (const [i, b] of '0011111111111101'.split('').entries()) bits[64 + i] = b;
  return bits.join('');
}

/**
 * Encode bits as biphase mark, at a given samples-per-bit.
 *
 * Transition at every bit boundary; a `1` gets one more in the middle. Level
 * carries no meaning, which is the whole point of the encoding.
 */
function biphase(bits, samplesPerBit) {
  const out = [];
  let level = 1;
  const half = samplesPerBit / 2;
  for (const bit of bits) {
    level = -level;
    for (let i = 0; i < half; i++) out.push(level);
    if (bit === '1') level = -level;
    for (let i = 0; i < samplesPerBit - half; i++) out.push(level);
  }
  return Float32Array.from(out);
}

test('the 64 data bits decode field by field', () => {
  const tc = decodeLtcFrame(ltcBits(11, 22, 33, 21).slice(0, 64));
  assert.deepEqual(pick(tc), [11, 22, 33, 21]);
  assert.equal(tc.dropFrame, false);
  /* LTC never transmits its rate — only the drop-frame flag. Saying `null`
     rather than guessing is what lets the caller decide honestly. */
  assert.equal(tc.rate, null);
});

test('the drop-frame flag is the one rate hint LTC carries', () => {
  assert.equal(decodeLtcFrame(ltcBits(0, 0, 0, 0, true).slice(0, 64)).dropFrame, true);
});

test('a field that cannot be a timecode is rejected rather than returned', () => {
  const bad = ltcBits(0, 0, 0, 0).slice(0, 64).split('');
  bad[0] = '1'; bad[1] = '1'; bad[2] = '1'; bad[8] = '1'; bad[9] = '1';  /* frames = 37 */
  assert.equal(decodeLtcFrame(bad.join('')), null);
  assert.equal(decodeLtcFrame('0101'), null, 'and a short field is not a frame');
});

/* The real test: a signal built to the standard, decoded back. */
test('LTC decodes out of a biphase-mark audio signal', () => {
  const sampleRate = 48000;
  const samplesPerBit = sampleRate / (25 * 80);
  const reader = new LtcReader({ sampleRate });
  const signal = biphase(ltcBits(1, 2, 3, 4) + ltcBits(1, 2, 3, 5), samplesPerBit);
  const frames = reader.push(signal);
  assert.ok(frames.length >= 1, 'at least one frame came out');
  assert.deepEqual(pick(frames[0]), [1, 2, 3, 4]);
});

test('a stream joined partway still finds the next whole frame', () => {
  const sampleRate = 48000;
  const samplesPerBit = sampleRate / (25 * 80);
  const reader = new LtcReader({ sampleRate });
  const whole = biphase(ltcBits(5, 5, 5, 5) + ltcBits(5, 5, 5, 6) + ltcBits(5, 5, 5, 7), samplesPerBit);
  /* Start halfway through the first frame, as a reader switched on mid-show
     always does. */
  const frames = reader.push(whole.slice(Math.floor(whole.length / 5)));
  assert.ok(frames.length >= 1);
  assert.deepEqual(pick(frames[0]), [5, 5, 5, 6]);
});

/* The interval reference is a running average rather than a fixed rate, so
   the same decoder reads 24, 25 and 30 without being told which — and a deck
   running slightly off speed still decodes. */
test('any frame rate decodes, without being told which', () => {
  for (const fps of [24, 25, 30]) {
    const sampleRate = 48000;
    const reader = new LtcReader({ sampleRate });
    const bits = ltcBits(2, 2, 2, 2) + ltcBits(2, 2, 2, 3) + ltcBits(2, 2, 2, 4);
    const frames = reader.push(biphase(bits, sampleRate / (fps * 80)));
    assert.ok(frames.length >= 1, fps + ' fps produced nothing');
    assert.deepEqual(pick(frames[0]), [2, 2, 2, 2], fps + ' fps');
  }
});

test('silence produces no frames rather than noise', () => {
  const reader = new LtcReader({ sampleRate: 48000 });
  assert.deepEqual(reader.push(new Float32Array(4800)), []);
});

/* ------------------------------------------------------------------ *
 * The clock
 * ------------------------------------------------------------------ */

function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('the clock free-wheels between readings', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now, staleAfterMs: 250 });
  clock.update(makeTimecode(1, 0, 0, 0, 25));
  const at = toSeconds(makeTimecode(1, 0, 0, 0, 25));
  assert.equal(clock.position(), at);
  time.advance(100);
  assert.ok(Math.abs(clock.position() - (at + 0.1)) < 1e-9);
});

/*
 * The thing this class exists for. A stopped generator, a pulled cable and a
 * paused deck all look identical on the wire — the messages simply stop. A
 * chase that trusted its last reading would keep firing cues off a memory.
 */
test('a feed that stops is reported as stopped, not as frozen', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now, staleAfterMs: 250 });
  clock.update(makeTimecode(1, 0, 0, 0, 25), 'midi');
  assert.equal(clock.running, true);

  time.advance(300);
  assert.equal(clock.running, false);
  assert.equal(clock.position(), null, 'and no position is offered');
  assert.ok(clock.reading, 'though the last reading is still there to show');
});

test('stopping is announced once, not on every poll', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now, staleAfterMs: 250 });
  let stops = 0;
  clock.addEventListener('stop', () => stops++);
  clock.update(makeTimecode(1, 0, 0, 0, 25), 'midi');
  time.advance(300);
  clock.poll(); clock.poll(); clock.poll();
  assert.equal(stops, 1);
});

test('starting is announced when a feed appears', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now, staleAfterMs: 250 });
  let starts = 0;
  clock.addEventListener('start', () => starts++);
  clock.update(makeTimecode(1, 0, 0, 0, 25), 'midi');
  clock.update(makeTimecode(1, 0, 0, 1, 25), 'midi');
  assert.equal(starts, 1, 'once, while it keeps arriving');
  time.advance(300);
  clock.poll();
  clock.update(makeTimecode(2, 0, 0, 0, 25), 'midi');
  assert.equal(starts, 2, 'and again after it came back');
});

/* A locate is not the same as time passing, and a stack that treated it as
   time passing would run every cue in between on the way. */
test('a jump is announced separately from ordinary running', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now });
  const jumps = [];
  clock.addEventListener('jump', (ev) => jumps.push(ev.detail.timecode));
  clock.update(makeTimecode(1, 0, 0, 0, 25));
  clock.update(makeTimecode(1, 0, 0, 1, 25));
  assert.equal(jumps.length, 0, 'one frame on is not a jump');
  clock.update(makeTimecode(2, 30, 0, 0, 25));
  assert.equal(jumps.length, 1);
});

/* LTC cannot say its rate, so the clock supplies the one it was configured
   with rather than letting a null rate poison the arithmetic. */
test('a reading with no rate takes the configured one', () => {
  const time = fakeClock();
  const clock = new TimecodeClock({ rate: 30, now: time.now });
  clock.update({ hours: 0, minutes: 0, seconds: 1, frames: 0, rate: null, dropFrame: false });
  assert.equal(clock.reading.rate, 30);
  assert.equal(clock.position(), 1);
});

test('two readings of the same instant compare equal across objects', () => {
  assert.ok(sameTimecode(makeTimecode(1, 2, 3, 4, 25), makeTimecode(1, 2, 3, 4, 25)));
  assert.ok(!sameTimecode(makeTimecode(1, 2, 3, 4, 25), makeTimecode(1, 2, 3, 5, 25)));
  assert.ok(!sameTimecode(makeTimecode(1, 2, 3, 4, 25), makeTimecode(1, 2, 3, 4, 30)));
  assert.ok(!sameTimecode(null, makeTimecode(1, 2, 3, 4, 25)));
});

/* ------------------------------------------------------------------ *
 * The chase
 *
 * A stub stack rather than the real CueStack: what needs pinning is which
 * cues fire and when, and a real stack would drag a transport and a device
 * into a test about arithmetic and edges.
 * ------------------------------------------------------------------ */

function stubStack(cues) {
  return {
    cues: cues.map((c, i) => ({ id: 'c' + i, enabled: true, ...c })),
    fired: [],
    fire(cue) { this.fired.push(cue.number ?? cue.id); return { sent: 1 }; }
  };
}

function chaseAt(cues, startSeconds) {
  const time = fakeClock();
  const clock = new TimecodeClock({ now: time.now, staleAfterMs: 250, rate: 25 });
  const stack = stubStack(cues);
  const chase = new TimecodeChase({ stack, clock, rate: 25 });
  let pos = 0;

  /** Put the clock at a position, however far that is — a locate. */
  const at = (seconds) => {
    pos = seconds;
    const whole = Math.floor(seconds);
    clock.update(makeTimecode(
      Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60,
      Math.round((seconds - whole) * 25), 25));
  };

  /*
   * Play forward to a position, in steps small enough to be running rather
   * than jumping. This matters: the clock calls any move of more than a second
   * a jump, and a jump is *meant* to skip silently — so a test that stepped
   * from 9 to 11 in one go would be testing the locate path while claiming to
   * test the crossing path. Real MTC arrives every couple of frames.
   */
  const runTo = (seconds) => {
    while (pos < seconds - 1e-9) { at(Math.min(seconds, pos + 0.2)); chase.tick(); }
  };

  if (startSeconds !== undefined) at(startSeconds);
  return { chase, stack, clock, time, at, runTo };
}

test('a cue fires when the timecode passes it, and only once', () => {
  const { chase, stack, runTo } = chaseAt([{ number: '1', timecode: '00:00:10:00' }], 5);
  chase.arm();
  chase.tick();
  runTo(9);
  assert.deepEqual(stack.fired, [], 'not before its time');
  runTo(11);
  assert.deepEqual(stack.fired, ['1']);
  /* Its condition stays true for every reading after; it must not repeat. */
  runTo(13);
  assert.deepEqual(stack.fired, ['1']);
});

test('cues with no timecode are left to the GO button', () => {
  const { chase, stack, runTo } = chaseAt([{ number: '1' }, { number: '2', timecode: '00:00:10:00' }], 5);
  chase.arm(); chase.tick();
  runTo(11);
  assert.deepEqual(stack.fired, ['2']);
});

test('a disabled cue is stepped over', () => {
  const { chase, stack, runTo } = chaseAt(
    [{ number: '1', timecode: '00:00:10:00', enabled: false }, { number: '2', timecode: '00:00:11:00' }], 5);
  chase.arm(); chase.tick();
  runTo(12);
  assert.deepEqual(stack.fired, ['2']);
});

/* A rehearsal runs the same three minutes twenty times. */
test('going back re-arms the cues behind', () => {
  const { chase, stack, at, runTo } = chaseAt([{ number: '1', timecode: '00:00:10:00' }], 5);
  chase.arm(); chase.tick();
  runTo(11);
  assert.deepEqual(stack.fired, ['1']);

  /* Back to the top of the scene. The locate itself fires nothing; running
     through again fires it a second time, which is what a rehearsal needs. */
  at(5); chase.tick();
  assert.deepEqual(stack.fired, ['1'], 'the locate itself is silent');
  runTo(11);
  assert.deepEqual(stack.fired, ['1', '1']);
});

/*
 * The one that would do real damage. Locating an hour forward must not run
 * every cue in between as fast as the device will take them.
 */
test('jumping forward skips silently instead of firing everything it passed', () => {
  /* One cue a second, for a minute. */
  const cues = Array.from({ length: 59 }, (_, i) => ({
    number: String(i + 1),
    timecode: `00:00:${String(i + 1).padStart(2, '0')}:00`
  }));
  const { chase, stack, at, runTo } = chaseAt(cues, 0);
  chase.arm(); chase.tick();

  at(45);
  chase.tick();
  assert.deepEqual(stack.fired, [], 'forty-five cues passed over, not one of them fired');

  /* And the show carries on from where it landed. */
  runTo(47.5);
  assert.deepEqual(stack.fired, ['46', '47']);
});

test('arming mid-show catches up rather than firing the past', () => {
  const { chase, stack, runTo } = chaseAt(
    [{ number: '1', timecode: '00:00:01:00' }, { number: '2', timecode: '00:00:02:00' },
      { number: '3', timecode: '00:00:30:00' }], 10);
  chase.arm();
  chase.tick();
  assert.deepEqual(stack.fired, [], 'the two already gone stay gone');
  runTo(31);
  assert.deepEqual(stack.fired, ['3']);
});

/* No position means no firing: a stopped generator, a pulled cable and a
   paused deck are indistinguishable, and none of them is a reason to act. */
test('nothing fires while the feed is stale', () => {
  const { chase, stack, time, at } = chaseAt([{ number: '1', timecode: '00:00:10:00' }], 5);
  chase.arm(); chase.tick();
  time.advance(400);
  assert.deepEqual(chase.tick(), [], 'stale');
  assert.deepEqual(stack.fired, []);

  /* And when it comes back further on, that is a jump, not a run. */
  at(20); chase.tick();
  assert.deepEqual(stack.fired, []);
});

test('a disarmed chase does nothing at all', () => {
  const { chase, stack, runTo } = chaseAt([{ number: '1', timecode: '00:00:10:00' }], 5);
  chase.arm();
  chase.tick();
  chase.disarm();
  runTo(11);
  assert.deepEqual(stack.fired, []);
});

test('several cues on the same reading fire in timecode order', () => {
  const { chase, stack, runTo } = chaseAt([
    { number: 'late', timecode: '00:00:10:20' },
    { number: 'early', timecode: '00:00:10:02' }
  ], 5);
  chase.arm(); chase.tick();
  runTo(11);
  assert.deepEqual(stack.fired, ['early', 'late']);
});

test('the next cue due is reported for a standby readout', () => {
  const { chase, runTo } = chaseAt(
    [{ number: '1', timecode: '00:00:10:00' }, { number: '2', timecode: '00:00:20:00' }], 5);
  chase.arm(); chase.tick();
  const next = chase.next();
  assert.equal(next.cue.number, '1');
  assert.ok(Math.abs(next.inSeconds - 5) < 0.01);
  runTo(11);
  assert.equal(chase.next().cue.number, '2');
});

test('a timecode string is parsed, and a bad one is refused', () => {
  assert.deepEqual(
    pick(parseTimecodeString('01:02:03:04')), [1, 2, 3, 4]);
  assert.equal(parseTimecodeString('01:02:03;04').dropFrame, true);
  assert.equal(parseTimecodeString('01:02:03'), null);
  assert.equal(parseTimecodeString('99:00:00:00'), null);
  /* A frame number the rate cannot produce is a typo, not a timecode. */
  assert.equal(parseTimecodeString('00:00:00:30', { rate: 25 }), null);
  assert.equal(parseTimecodeString(''), null);
  assert.equal(parseTimecodeString(null), null);
});

test('a cue with an unreadable timecode is ignored rather than fired at zero', () => {
  const { chase, stack, runTo } = chaseAt([{ number: 'bad', timecode: 'soon' }], 5);
  chase.arm(); chase.tick();
  runTo(60);
  assert.deepEqual(stack.fired, []);
});
