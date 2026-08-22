/*
 * Firing cues off timecode.
 *
 * A cue may carry a timecode. When the incoming timecode passes it, the cue
 * fires. That sentence hides four decisions, and every one of them is the
 * difference between a chase that runs a show and one that ruins it.
 *
 * ## 1. A cue fires once per pass, not once per reading
 *
 * Timecode arrives many times a second. "Position is past the cue" is true for
 * every one of those readings, so firing on the condition would fire the cue
 * continuously. The chase remembers what it has fired and only fires a cue on
 * the reading that *crosses* it.
 *
 * ## 2. Going backwards re-arms
 *
 * A rehearsal runs the same three minutes twenty times. Once the timecode is
 * back before a cue, that cue is due again — otherwise the second run of the
 * scene does nothing and the operator is left pressing GO by hand while
 * wondering what is wrong.
 *
 * ## 3. Jumping forward does NOT run everything it skipped
 *
 * This is the one that would do damage. Locating from 00:01:00 to 01:30:00
 * must not fire every cue in between as fast as the device will take them —
 * that is a hundred takes in a second, on air. On a jump the chase *catches
 * up*: everything before the new position is marked as already done, silently,
 * and the show continues from there.
 *
 * A jump is any move the clock reports as one, which it does when the
 * position moves by more than a second between readings. Ordinary running
 * never does that.
 *
 * ## 4. Nothing fires while the feed is stale
 *
 * A stopped generator and a paused deck look identical, and the clock reports
 * a stale feed as having no position at all. No position, no firing.
 */

import { toSeconds } from './timecode.js';

/** Parse `01:02:03:04` or `01:02:03;04`. Returns null for anything else. */
export function parseTimecodeString(text, { rate = 25 } = {}) {
  const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})([:;.])(\d{1,2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const tc = {
    hours: +m[1], minutes: +m[2], seconds: +m[3], frames: +m[5],
    rate, dropFrame: m[4] === ';'
  };
  if (tc.hours > 23 || tc.minutes > 59 || tc.seconds > 59 || tc.frames >= rate) return null;
  return tc;
}

/** Seconds since midnight for a cue's timecode string, or null. */
export function cueTime(cue, rate) {
  if (!cue || !cue.timecode) return null;
  const tc = parseTimecodeString(cue.timecode, { rate });
  return tc ? toSeconds(tc) : null;
}

export class TimecodeChase extends EventTarget {
  /**
   * @param {{stack: object, clock: object, rate?: number}} opts
   */
  constructor({ stack, clock, rate = 25 }) {
    super();
    this.stack = stack;
    this.clock = clock;
    this.rate = rate;
    this.enabled = false;
    /* Cue ids already fired on this pass. Cleared when the timecode goes back
       behind them, or wholesale on a jump. */
    this.fired = new Set();
    this.lastPosition = null;
    this._onJump = () => this.catchUp();
    this._onStop = () => { this.lastPosition = null; };
    /*
     * Fire on arrival, not on a timer.
     *
     * A reading is the only moment new information exists, so a timer between
     * readings can only repeat what the last one already said. It is also the
     * only approach that survives the browser: `setInterval` is throttled to
     * about once a second in a background tab — measured at **two ticks a
     * second** in a hidden window — and a show-critical chase must not depend
     * on the operator keeping the right tab in front.
     *
     * Accuracy is bounded by how often timecode arrives either way, which for
     * MTC is every two frames.
     */
    this._onReading = () => this.tick();
  }

  /**
   * Start chasing.
   *
   * Catching up first, deliberately: arming a chase mid-show must not fire
   * every cue whose time has already gone. The operator armed it to catch what
   * is *coming*.
   */
  arm() {
    if (this.enabled) return;
    this.enabled = true;
    this.clock.addEventListener('jump', this._onJump);
    this.clock.addEventListener('stop', this._onStop);
    this.clock.addEventListener('timecode', this._onReading);
    this.catchUp();
    this.dispatchEvent(new CustomEvent('armed'));
  }

  disarm() {
    if (!this.enabled) return;
    this.enabled = false;
    this.clock.removeEventListener('jump', this._onJump);
    this.clock.removeEventListener('stop', this._onStop);
    this.clock.removeEventListener('timecode', this._onReading);
    this.lastPosition = null;
    this.dispatchEvent(new CustomEvent('disarmed'));
  }

  /** Every cue that carries a readable timecode, earliest first. */
  timed() {
    return this.stack.cues
      .map((cue) => ({ cue, at: cueTime(cue, this.rate) }))
      .filter((c) => c.at !== null && c.cue.enabled !== false)
      .sort((a, b) => a.at - b.at);
  }

  /**
   * Treat everything before the current position as already done.
   *
   * Called when the chase is armed and whenever the clock reports a jump. The
   * silence is the point: no cue fires, and the show simply continues from
   * where the timecode now is.
   */
  catchUp() {
    const now = this.clock.position();
    this.fired.clear();
    if (now === null) { this.lastPosition = null; return; }
    for (const { cue, at } of this.timed()) if (at <= now) this.fired.add(cue.id);
    this.lastPosition = now;
    this.dispatchEvent(new CustomEvent('caught-up', { detail: { at: now, skipped: this.fired.size } }));
  }

  /**
   * Fire whatever the timecode has just passed.
   *
   * Called for every reading while armed; safe to call at any time, and
   * returns nothing when there is nothing new to cross.
   *
   * @returns {Array<object>} the cues fired, in order
   */
  tick() {
    if (!this.enabled) return [];
    const now = this.clock.position();
    if (now === null) { this.lastPosition = null; return []; }

    const previous = this.lastPosition;
    this.lastPosition = now;
    /* First reading after arming or after a stale patch: nothing to compare
       against, so nothing has been *crossed* yet. */
    if (previous === null) return [];

    const fired = [];
    for (const { cue, at } of this.timed()) {
      /* Behind us again — a rehearsal going round twice. Re-arm it. */
      if (at > now) { this.fired.delete(cue.id); continue; }
      if (this.fired.has(cue.id)) continue;
      /*
       * Only cues in the window just travelled through. A cue further back
       * than that was missed while the feed was away, and firing it now would
       * be acting on a time that has gone.
       */
      if (at <= previous) { this.fired.add(cue.id); continue; }
      this.fired.add(cue.id);
      this.stack.fire(cue);
      fired.push(cue);
      this.dispatchEvent(new CustomEvent('fired', { detail: { cue, at, position: now } }));
    }
    return fired;
  }

  /** The next cue due, for a standby readout. */
  next() {
    const now = this.clock.position();
    if (now === null) return null;
    for (const { cue, at } of this.timed()) {
      if (at > now) return { cue, at, inSeconds: at - now };
    }
    return null;
  }
}
