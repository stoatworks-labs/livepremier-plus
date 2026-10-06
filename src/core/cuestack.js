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
 *    with its own fade has to write the time and then trigger, and any other
 *    client that changes the time between those two writes wins. The engine
 *    writes the time immediately before the trigger to keep that window as
 *    small as it can be, and does not pretend the race is closed.
 *
 *    The other client is usually the device itself: a PRESET RECALL overwrites
 *    the screen's `takeUpTime` with whatever the preset was saved with. So the
 *    write has to come AFTER the recall has landed, not before it — recall,
 *    settle, fade, trigger. Measured on an Aquilon C, 2026-08-21.
 *
 * And one thing the device does that a quick operator walks into: **a recall
 * into PREVIEW made while a take is running loads the buffer that is fading
 * up**, because PREVIEW is resolved against the transition state. GO, then GO
 * again before the first take has landed, and the second cue's look rides the
 * first cue's take onto program. With a `hold` (the Preview lock plugin's
 * service) the engine waits instead — see `fire`. Without one nothing here
 * changes: no hold, no queue, the same synchronous fire as always.
 */

import { commandsFor } from './commands.js';
import { NLC } from './dialect.js';

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

/**
 * The destinations a cue loads into PREVIEW — what a hold is asked about.
 * A master memory names none and covers the screens it was saved with, so
 * it is `*`. A recall into PROGRAM is not held: it is not the case that
 * rides a take, and it is the operator saying "on air, now".
 */
export function previewTargets(cue) {
  const ids = new Set();
  for (const a of (cue && cue.actions) || []) {
    if ((a.mode || 'PREVIEW') !== 'PREVIEW') continue;
    if (a.kind === ACTION_KINDS.SCREEN_PRESET) for (const t of a.targets || []) ids.add(t);
    else if (a.kind === ACTION_KINDS.MASTER_PRESET) ids.add('*');
  }
  return [...ids];
}

/*
 * Every other kind is a plugin's — a `cueAction` contribution, see
 * `core/contributions.js`. Matrix Routing's two, `matrixFeed` and `matrixSend`,
 * used to be listed here and special-cased in `fire`; they are contributed now,
 * like anybody else's would be.
 */

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
    /*
     * `hh:mm:ss:ff`, and this cue is fired by the clock reaching it rather
     * than by the GO button. Held as the operator typed it rather than as a
     * number of seconds: it is read back into the same field, it is what they
     * see on the generator, and turning it into seconds would need a frame
     * rate that the cue itself has no business knowing.
     *
     * null for an ordinary GO cue, which is most of them.
     */
    timecode: partial.timecode || null,
    actions: (partial.actions || []).map((a) => ({ ...a }))
  };
}

export class CueStack extends EventTarget {
  /**
   * @param {object} opts
   * @param {(cmd:{path:string[],value:*}) => boolean} opts.send
   * @param {object} [opts.clock] injectable timers, for tests
   * @param {object|Function} [opts.commands] the command table to spell cues
   *   with — `commandsFor(dialect)` — or a function returning one. A function,
   *   because which switcher is on the other end is only known once the store
   *   has arrived, and may change when the operator re-points at a backup
   *   frame. Defaults to the LivePremier table.
   * @param {(kind: string) => ({run: Function, label?: string} | null)} [opts.actions]
   *   who handles a kind the engine does not do itself — the `cueAction`
   *   contributions. Asked at fire time, because plugins load after the stack
   *   is built.
   * @param {(ids: string[]) => (Promise<{ok:boolean, message?:string}>|null)} [opts.hold]
   *   asked before a cue recalls into PREVIEW: null to fire now, or a promise
   *   that the destinations' takes have landed (`['*']` for a master memory).
   *   `ok: false` means the take did not land in time and the cue must not
   *   fire. Asked at fire time, like `actions`, because the plugin that
   *   answers it may load after the stack, or be off.
   */
  constructor({ send, clock, commands, actions, hold } = {}) {
    super();
    this.send = send || (() => false);
    /*
     * Where any other kind of action goes. Injected exactly as `send` is, and
     * for the same reason: this engine knows no transport, and no router, and
     * no plugin. A kind nobody handles is reported on the cue rather than
     * dropped silently — see `fire`.
     */
    this._action = typeof actions === 'function' ? actions : () => null;
    this._commands = typeof commands === 'function' ? commands : () => (commands || commandsFor(NLC));
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
    this._hold = typeof hold === 'function' ? hold : null;
    /* Only used with a hold. The last cue still to finish (waiting, or
       inside its settle before the take), so the next one queues behind
       it; and a count bumped by stop() that cancels whatever is queued. */
    this._pending = null;
    this._epoch = 0;
    this._waiting = new Map(); // cue id -> destinations it is waiting on
  }

  /** Cues waiting for a take to land before they fire: `[{cueId, ids}]`. */
  get waiting() {
    return [...this._waiting].map(([cueId, ids]) => ({ cueId, ids }));
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
    const cmd = this._commands();
    for (const t of targets) this._send(cmd.stepBack(t));
  }

  /**
   * Cancel any pending delay or follow, and any cue still waiting for a take
   * to land — it has not touched the switcher yet. Fired cues are not undone.
   */
  stop() {
    this._cancelTimer();
    const hadWaiting = this._waiting.size > 0;
    this._epoch++;
    if (hadWaiting) {
      for (const cueId of this._waiting.keys()) this._emit('cancelled', { cueId });
      this._waiting.clear();
    }
    if (this.running) { this.running = false; this._emit('stopped', {}); this._changed(); }
    else if (hadWaiting) this._changed();
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
   * Order matters, and it is recall → SETTLE → fade → trigger.
   *
   * The fade write has to come after the settle, not before it. A preset
   * recall OVERWRITES the screen's `takeUpTime` with whatever the preset was
   * saved with, and that write lands whenever the recall finishes landing —
   * measured on an Aquilon C, 2026-08-21. Sending the cue's fade first, as
   * this used to, meant the recall's own value arrived on top of it: a cue
   * sheet saying 1.0 s and a five-second fade on the screen, with nothing
   * reporting the difference. "Any fade written BEFORE a recall is silently
   * discarded."
   *
   * The settle is a floor, not a guarantee — see SETTLE_MS. It is the same
   * gap that was already being waited before the trigger; this moves the fade
   * write to the far side of it rather than lengthening anything.
   *
   * ## With a hold: in order, and never into a take
   *
   * - **A cue that recalls into PREVIEW on a destination mid-take waits** for
   *   that take to land, then fires whole — recalls, actions, fade and take
   *   together, in the usual order. Holding only the recall would let the
   *   cue's own TAKE go first and take the previous preview to air.
   * - **Cues fire in the order GO was pressed.** One fired while an earlier
   *   cue is waiting, or is inside its settle with its TAKE not yet sent,
   *   queues behind it, and asks the hold only once that cue's TAKE has gone
   *   — which is what puts its destination mid-take. Asked any earlier, it
   *   would see a destination at rest, recall at once, and overwrite the
   *   look the earlier cue was about to take.
   * - **A hold that gives up means the cue does not fire**, with a warning
   *   that says so. Firing late into the arriving buffer is the failure this
   *   prevents, so there is no "fire anyway".
   * - `stop()` cancels whatever is still waiting.
   *
   * A cue that waits returns `{waiting: true}` now and emits `waiting`, then
   * `fired` when it goes, exactly as an immediate one does.
   */
  fire(cue) {
    if (!cue || !cue.enabled) return { sent: 0, skipped: true };
    if (!this._hold) return this._fireNow(cue).record;

    const ids = previewTargets(cue);
    if (!this._pending) {
      const wait = ids.length ? this._hold(ids) : null;
      if (!wait) {
        const { record, done } = this._fireNow(cue);
        if (done) this._track(done);
        return record;
      }
      return this._queue(cue, ids, null, wait);
    }
    return this._queue(cue, ids, this._pending, null);
  }

  /** Fire `cue` once `ahead` has finished and its own hold has let it go. */
  _queue(cue, ids, ahead, wait) {
    const epoch = this._epoch;
    const run = (async () => {
      if (ahead) await ahead;
      if (epoch !== this._epoch) return;
      const hold = wait || (ids.length ? this._hold(ids) : null);
      if (hold) {
        this._waiting.set(cue.id, ids);
        this._emit('waiting', { cue, ids });
        this._changed();
        let result;
        try { result = await hold; } catch (err) { result = { ok: false, message: err && err.message ? err.message : String(err) }; }
        if (epoch !== this._epoch) return;
        this._waiting.delete(cue.id);
        this._changed();
        if (!result || !result.ok) {
          this._emit('warning', {
            cue,
            message: `Cue ${cue.number || cue.label || cue.id} was not fired: ${(result && result.message) || 'the take did not land'}. `
              + 'Step back and GO it again.'
          });
          return;
        }
      }
      const { done } = this._fireNow(cue);
      if (done) await done;
    })();
    this._track(run);
    return { cueId: cue.id, sent: 0, waiting: true };
  }

  /** Remember the last cue still to finish, so the next one queues behind it. */
  _track(promise) {
    const tracked = promise.then(() => {}, () => {});
    this._pending = tracked;
    tracked.then(() => { if (this._pending === tracked) this._pending = null; });
  }

  /**
   * The cue's writes, now: recall → settle → fade → trigger. Returns the
   * record, and `done` — a promise that the trigger has run — when the
   * trigger waits behind the settle; null when it has already run.
   */
  _fireNow(cue) {
    /* Asked once per cue, so every write in it is spelled for one switcher
       even if the operator re-points mid-fire. */
    const cmd = this._commands();
    let sent = 0;
    let recalled = false;
    const takeTargets = new Set();

    for (const a of cue.actions) {
      switch (a.kind) {
        case ACTION_KINDS.SCREEN_PRESET:
          recalled = true;
          for (const target of a.targets || []) {
            if (this._send(cmd.recallScreenPreset(a.slot, target, a.mode || 'PREVIEW'))) sent++;
          }
          break;
        case ACTION_KINDS.MASTER_PRESET:
          recalled = true;
          if (this._send(cmd.recallMasterPreset(a.slot, a.mode || 'PREVIEW'))) sent++;
          break;
        case ACTION_KINDS.TAKE:
        case ACTION_KINDS.CUT:
          for (const target of a.targets || []) takeTargets.add(target + ' ' + a.kind);
          break;

        /*
         * Any other kind is a plugin's: sent immediately and outside the settle.
         *
         * Immediately — in this loop, alongside the recalls — which puts it
         * ahead of the take whatever order the actions are listed in, because
         * the take is deferred to `trigger()`. That is the ordering a router
         * crosspoint, the first of these, needs: a signal has to be present on
         * an input before anything switches to it, or the old source is on air
         * for the length of the transition.
         *
         * Outside the settle, because the settle exists to stop a TAKE
         * overtaking its own preset recall, and a plugin's action is not a
         * recall. Waiting for it would delay every cue that uses one for a
         * reason that does not apply.
         *
         * ⚠️ **Nothing here waits for what the action started to finish.** A
         * router acknowledges receipt of a crosspoint, not the lock of the
         * signal: an HDMI or HDCP handshake can take a second or more, and a
         * cue that routes and takes in the same breath can take to black. Put
         * the route in an earlier cue when the format may change.
         */
        default: {
          const handler = this._action(a.kind);
          if (!handler) {
            this._emit('warning', {
              cue, message: `Nothing handles “${a.kind}” — the plugin that adds it may be switched off.`
            });
            break;
          }
          const failed = (err) => this._emit('warning', {
            cue, message: `${handler.label || a.kind} failed: ${err && err.message ? err.message : err}`
          });
          try {
            /* Fire-and-forget, exactly like every other write here: a promise
               is not awaited, and one that rejects is reported, not thrown. */
            const out = handler.run(a, { cue });
            if (out && typeof out.then === 'function') out.then(null, failed);
            sent++;
          } catch (err) {
            failed(err);
          }
        }
      }
    }

    /* Writes the cue's own fade. Called after the settle when this cue
       recalled anything, so the recall's stored transition time has already
       landed and this goes on top of it rather than under it. */
    const writeFade = () => {
      if (cue.fade == null) return;
      const tenths = toTenths(cue.fade);
      let written = 0;
      for (const entry of takeTargets) {
        const target = entry.split(' ')[0];
        /* One write per direction on LivePremier, one for both on Midra —
           the table says how many, and each is counted. */
        for (const write of cmd.fade(target, tenths)) if (this._send(write)) written++;
      }
      if (written) record.sent += written;
    };

    const trigger = () => {
      let fired = 0;
      for (const entry of takeTargets) {
        const [target, kind] = entry.split(' ');
        if (this._send(kind === ACTION_KINDS.CUT ? cmd.cut(target) : cmd.take(target))) fired++;
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
       in flight to overtake, and delaying it would just make it feel late —
       and with no recall there is nothing that can overwrite the fade, so it
       can go out immediately. */
    if (record.settled) {
      let finished;
      const done = new Promise((resolve) => { finished = resolve; });
      this.clock.setTimeout(() => {
        writeFade();
        trigger();
        finished();
      }, SETTLE_MS);
      return { record, done };
    }
    writeFade();
    trigger();
    return { record, done: null };
  }

  get log() { return this._log.slice(); }

  _send(cmd) {
    /* A builder that returned null had no command to build — no platform yet,
       or none this platform has. Reported as a failed send rather than sent
       as `null`, because the transport would refuse it anyway and the panel
       should say why nothing happened. */
    const ok = !!cmd && this.send(cmd);
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
