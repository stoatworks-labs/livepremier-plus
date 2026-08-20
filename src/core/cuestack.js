/*
 * A timed cue stack for a switcher that has no concept of one.
 *
 * LivePremier thinks in memories and a TAKE button: you recall, you look, you
 * take. Theatre thinks in a numbered list that advances on a single GO, where
 * each cue carries its own fade time and may follow the one before it
 * automatically. This is the second model, driven onto the first.
 *
 * The engine is deliberately ignorant of transport and of DOM. It is handed a
 * `send` function and a clock, and it emits events; the panel draws them and
 * the extension wires `send` to the page socket. The same engine backs a
 * direct-AWJ client with nothing changed but the two callbacks.
 *
 * Two things the device forces on the design:
 *
 *  - Recall and TAKE are silent. Nothing acknowledges them, so a cue is never
 *    reported as "confirmed" - only as sent, with device status watched
 *    separately. No method here collapses those two ideas.
 *  - Transition times are a property of the screen, not of the take. A cue
 *    with its own fade has to write the time first and then trigger, and any
 *    other client that changes the time between those two writes wins. The
 *    engine writes times immediately before the trigger to keep that window
 *    as small as it can be, and does not pretend the race is closed.
 */

import { CMD } from './paths.js';

let uid = 0;
const nextId = () => 'c' + (++uid) + '-' + Math.random().toString(36).slice(2, 7);

/** Seconds to the device's tenths-of-a-second transition units. */
export const toTenths = (seconds) => Math.max(0, Math.round(seconds * 10));

/**
 * Gap between a preset recall and the TAKE in the same cue, in milliseconds.
 *
 * Recalls are silent and take a non-zero time to land. A TAKE issued in the
 * same breath can overtake its own preset load, in which case the device
 * transitions the *previous* preview contents to air: wrong picture, on air,
 * and no error anywhere to explain it. This gap is a floor, not a guarantee -
 * it makes the common case right and does not pretend to close the race.
 *
 * Established independently by the standalone webrcs-timeline engine, which
 * hit it against the simulator and settled on the same figure.
 */
export const SETTLE_MS = 150;

export const ACTION_KINDS = {
  SCREEN_PRESET: 'screenPreset',
  MASTER_PRESET: 'masterPreset',
  TAKE: 'take',
  CUT: 'cut'
};

export function makeCue(partial = {}) {
  return {
    id: partial.id || nextId(),
    number: partial.number ?? '',
    label: partial.label ?? '',
    notes: partial.notes ?? '',
    enabled: partial.enabled !== false,
    /* Seconds of transition for takes in this cue. null leaves whatever the
       screen is already set to, which is what you want for a cut-only cue. */
    fade: partial.fade ?? null,
    /* Seconds to wait before firing, once this cue is reached. */
    delay: partial.delay ?? 0,
    /* When true the following cue fires automatically after `followTime`. */
    follow: partial.follow === true,
    followTime: partial.followTime ?? 0,
    actions: (partial.actions || []).map((a) => ({ ...a }))
  };
}

export class CueStack extends EventTarget {
  /**
   * @param {object} opts
   * @param {(cmd:{path:string[],value:*}) => boolean} opts.send
   * @param {object} [opts.clock] injectable timers, for tests
   */
  constructor({ send, clock } = {}) {
    super();
    this.send = send || (() => false);
    this.clock = clock || {
      setTimeout: (...a) => setTimeout(...a),
      clearTimeout: (id) => clearTimeout(id),
      now: () => Date.now()
    };
    this.name = 'Untitled stack';
    this.cues = [];
    this.pointer = 0;      // index of the standby cue, the one GO will fire
    this.running = false;  // a follow chain is in flight
    this._timer = null;
    this._log = [];
  }

  /* ----------------------------- editing ----------------------------- */

  add(partial, atIndex = null) {
    const cue = makeCue(partial);
    if (atIndex == null || atIndex >= this.cues.length) this.cues.push(cue);
    else this.cues.splice(atIndex, 0, cue);
    this._changed();
    return cue;
  }

  update(id, patch) {
    const cue = this.cues.find((c) => c.id === id);
    if (!cue) return null;
    Object.assign(cue, patch);
    this._changed();
    return cue;
  }

  remove(id) {
    const i = this.cues.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.cues.splice(i, 1);
    if (this.pointer > i) this.pointer--;
    if (this.pointer >= this.cues.length) this.pointer = Math.max(0, this.cues.length - 1);
    this._changed();
    return true;
  }

  move(id, delta) {
    const i = this.cues.findIndex((c) => c.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.cues.length) return false;
    const [cue] = this.cues.splice(i, 1);
    this.cues.splice(j, 0, cue);
    this._changed();
    return true;
  }

  /* ---------------------------- navigation --------------------------- */

  get standby() { return this.cues[this.pointer] || null; }

  goto(index) {
    this.stop();
    this.pointer = Math.max(0, Math.min(index, Math.max(0, this.cues.length - 1)));
    this._changed();
  }

  gotoId(id) {
    const i = this.cues.findIndex((c) => c.id === id);
    if (i >= 0) this.goto(i);
  }

  /**
   * Fire the standby cue and advance.
   *
   * A cue with a delay is scheduled rather than fired now, and GO during a
   * pending delay cancels it and fires immediately - a desk behaves that way
   * and an operator hitting GO twice means "now".
   */
  go() {
    if (this._timer) { this._cancelTimer(); this._fireStandby(); return; }
    const cue = this.standby;
    if (!cue) return;
    if (cue.delay > 0) {
      this._emit('armed', { cue, inSeconds: cue.delay });
      this._timer = this.clock.setTimeout(() => {
        this._timer = null;
        this._fireStandby();
      }, cue.delay * 1000);
      this.running = true;
      this._changed();
      return;
    }
    this._fireStandby();
  }

  /** Step the pointer back one cue without firing anything. */
  back() {
    this.stop();
    this.pointer = Math.max(0, this.pointer - 1);
    this._changed();
  }

  /**
   * Ask the device to step back on the given screens.
   *
   * This is the device's own xStepBack, not a re-run of the previous cue -
   * the switcher remembers its previous state and we do not. Which means a
   * stack whose cues do more than recall-and-take cannot be perfectly undone,
   * and the UI says so rather than implying otherwise.
   */
  deviceStepBack(targets) {
    for (const t of targets) this._send(CMD.stepBack(t));
  }

  /** Cancel any pending delay or follow. Fired cues are not undone. */
  stop() {
    this._cancelTimer();
    if (this.running) { this.running = false; this._emit('stopped', {}); this._changed(); }
  }

  _cancelTimer() {
    if (this._timer) { this.clock.clearTimeout(this._timer); this._timer = null; }
  }

  _fireStandby() {
    const cue = this.standby;
    if (!cue) { this.running = false; return; }
    this.fire(cue);
    const wasFollow = cue.follow;
    const followTime = cue.followTime || 0;
    this.pointer = Math.min(this.pointer + 1, this.cues.length);
    if (this.pointer >= this.cues.length) {
      this.running = false;
      this._changed();
      this._emit('end', {});
      return;
    }
    if (wasFollow) {
      this.running = true;
      this._emit('armed', { cue: this.standby, inSeconds: followTime });
      this._timer = this.clock.setTimeout(() => {
        this._timer = null;
        this._fireStandby();
      }, followTime * 1000);
    } else {
      this.running = false;
    }
    this._changed();
  }

  /**
   * Execute one cue's actions now, regardless of the pointer.
   *
   * Order matters: recalls go out before transition times, and times before
   * triggers, so that a preset which itself carries a transition time cannot
   * overwrite the cue's own.
   */
  fire(cue) {
    if (!cue || !cue.enabled) return { sent: 0, skipped: true };
    let sent = 0;
    let recalled = false;
    const takeTargets = new Set();

    for (const a of cue.actions) {
      switch (a.kind) {
        case ACTION_KINDS.SCREEN_PRESET:
          recalled = true;
          for (const target of a.targets || []) {
            if (this._send(CMD.recallScreenPreset(a.slot, target, a.mode || 'PREVIEW'))) sent++;
          }
          break;
        case ACTION_KINDS.MASTER_PRESET:
          recalled = true;
          if (this._send(CMD.recallMasterPreset(a.slot, a.mode || 'PREVIEW'))) sent++;
          break;
        case ACTION_KINDS.TAKE:
        case ACTION_KINDS.CUT:
          for (const target of a.targets || []) takeTargets.add(target + ' ' + a.kind);
          break;
        default:
          this._emit('warning', { cue, message: 'Unknown action kind: ' + a.kind });
      }
    }

    if (cue.fade != null) {
      const tenths = toTenths(cue.fade);
      for (const entry of takeTargets) {
        const target = entry.split(' ')[0];
        if (this._send(CMD.takeUpTime(target, tenths))) sent++;
        if (this._send(CMD.takeDownTime(target, tenths))) sent++;
      }
    }

    const trigger = () => {
      let fired = 0;
      for (const entry of takeTargets) {
        const [target, kind] = entry.split(' ');
        if (this._send(kind === ACTION_KINDS.CUT ? CMD.cut(target) : CMD.take(target))) fired++;
      }
      if (fired) {
        record.sent += fired;
        this._emit('took', { cueId: cue.id, sent: fired });
      }
    };

    const record = {
      at: this.clock.now(),
      cueId: cue.id,
      number: cue.number,
      label: cue.label,
      sent,
      settled: recalled && takeTargets.size > 0
    };
    this._log.push(record);
    if (this._log.length > 500) this._log.shift();
    this._emit('fired', record);

    /* Only wait when this cue recalled something. A cut-only cue has nothing
       in flight to overtake, and delaying it would just make it feel late. */
    if (record.settled) this.clock.setTimeout(trigger, SETTLE_MS);
    else trigger();

    return record;
  }

  get log() { return this._log.slice(); }

  _send(cmd) {
    const ok = this.send(cmd);
    if (!ok) this._emit('sendFailed', { cmd });
    return ok;
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  _changed() { this._emit('changed', { pointer: this.pointer, running: this.running }); }

  /* --------------------------- persistence --------------------------- */

  toJSON() {
    return { version: 1, name: this.name, cues: this.cues.map((c) => ({ ...c })) };
  }

  load(data) {
    if (!data || !Array.isArray(data.cues)) return false;
    this.stop();
    this.name = data.name || 'Untitled stack';
    this.cues = data.cues.map(makeCue);
    this.pointer = 0;
    this._changed();
    return true;
  }
}
