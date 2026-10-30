/*
 * Desk control the other way: the switcher firing the desk.  ** PREVIEW **
 * No I/O.
 *
 * A take on the switcher — its front panel, the Web RCS, a T-bar, another
 * console — fires triggers in the Triggers plugin (OSC, MIDI, MSC, Art-Net,
 * sACN), which is how a lighting desk is told to go to its "VT state" when a
 * VT goes to air. A rule says which: "when S1 takes memory 12, fire VT
 * state", or any memory, or any screen. The supervisor reads the screens and
 * sends; this decides.
 *
 * ## What counts as a take
 *
 * The switcher pushes nothing, so each watched screen's transition and the
 * memory each buffer holds are read about ten times a second:
 *
 * - **A transition leaving its resting end for `EFFECT_FROM_…` is a take
 *   starting.** The memory going to air is the preview buffer's, and it fires
 *   then, so the desk's cue runs alongside the switcher's transition.
 * - **The resting end flipping (`AT_DOWN` to `AT_UP`) with no start seen** is
 *   a cut, a take shorter than a read, or a switcher that does not report the
 *   state in between — the 6.2.73 simulator reports the old resting end for
 *   the whole take. It fires then, with the memory now on program.
 * - **A start and its landing are one take**, fired once. A T-bar pulled part
 *   way and back has fired already, and nothing takes that back.
 * - **A memory recalled straight to program** (the program buffer's memory
 *   changing at rest) is a load, and fires like a take.
 * - `COPY_FROM_…` is not a take.
 *
 * ## Never an echo
 *
 * A take the desk itself asked for through desk control is not fired back to
 * it: the supervisor says which screens it has just taken, and the next take
 * seen on one of them is that one. Otherwise the first desk cue that both
 * takes the switcher and is fired by its take is a loop. And a rule fires at
 * most once in `COOLDOWN_MS`, so a take seen twice cannot fire twice.
 */

export const COOLDOWN_MS = 500;
const RESTING = new Set(['AT_DOWN', 'AT_UP']);

export class TakeWatch {
  #last = new Map();   /* id → { end, flight, onAir } */

  clear() { this.#last.clear(); }

  /**
   * One reading of a screen — `resolve()`'s letters plus `memories`, the slot
   * each buffer holds by letter (null for none) — or null when it could not be
   * read. Returns the take it shows, `{ destination, memory, how }` with `how`
   * 'start' | 'land' | 'load', or null. The first reading of a screen is a
   * baseline and shows nothing.
   */
  observe(id, r) {
    const prev = this.#last.get(id);
    if (!r) { this.#last.delete(id); return null; }
    const resting = RESTING.has(r.transition);
    const onAir = resting ? (r.memories[r.program] ?? null) : null;
    if (!prev) {
      this.#last.set(id, { end: resting ? r.transition : null, flight: null, onAir });
      return null;
    }
    if (!resting) {
      /* Only from a known resting end, and once: the next reading is still mid-take. */
      const starts = /^EFFECT_FROM_/.test(r.transition || '') && prev.end !== null && prev.flight === null;
      this.#last.set(id, { ...prev, flight: starts ? r.preview : prev.flight });
      return starts ? { destination: id, memory: r.memories[r.preview] ?? null, how: 'start' } : null;
    }
    this.#last.set(id, { end: r.transition, flight: null, onAir });
    if (prev.end !== null && r.transition !== prev.end) {
      return prev.flight === null ? { destination: id, memory: onAir, how: 'land' } : null;
    }
    /* Back to the end it left is a take abandoned, fired already at its start. */
    if (prev.flight === null && onAir !== null && onAir !== prev.onAir) return { destination: id, memory: onAir, how: 'load' };
    return null;
  }
}

/**
 * The triggers a take fires: every rule for its screen (or any screen) and
 * its memory (or any memory) with a trigger chosen, once each, skipping a
 * rule fired within `COOLDOWN_MS`. `fired` (rule index → time) is updated.
 */
export function matchRules(rules, take, now, fired) {
  const ids = [];
  rules.forEach((rule, i) => {
    if (!rule.trigger) return;
    if (rule.destination && rule.destination !== take.destination) return;
    if (rule.memory !== null && rule.memory !== take.memory) return;
    if (now - (fired.get(i) ?? -Infinity) < COOLDOWN_MS) return;
    fired.set(i, now);
    if (!ids.includes(rule.trigger)) ids.push(rule.trigger);
  });
  return ids;
}

/** What a take was, for the history. */
export function describeTake(take) {
  const what = take.memory ? `memory ${take.memory}` : 'a look from no memory';
  return `${take.destination} ${take.how === 'start' ? 'taking' : take.how === 'load' ? 'loaded' : 'took'} ${what}`;
}
