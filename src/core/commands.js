/*
 * The device commands, spelled for whichever platform is on the other end.
 *
 * `core/paths.js` keeps `CMD`, the LivePremier table, because two things pin
 * it byte for byte: the tests, and the parity check against mynah's compiler
 * (two independent derivations agreeing is the evidence either is right).
 * This is the same table built over a `core/dialect.js` dialect instead, so
 * the cue engine can fire at a Midra 4K without knowing it is one.
 *
 * Every builder returns `{path, value}` or `null`, and `null` means "there is
 * no such command on this platform, or no platform yet". The cue engine's
 * `_send` treats a null as a send that failed, which is the right outcome: a
 * cue fired before the store has said which switcher this is must not go out
 * spelled for the wrong one.
 *
 * `fade` is the one builder that returns a *list*. LivePremier takes a time
 * per direction and Midra one time for both, and the difference is not the
 * engine's business.
 */

/**
 * @param {import('./dialect.js').NLC|import('./dialect.js').MNG|null} dialect
 */
export function commandsFor(dialect) {
  if (!dialect) return NONE;
  const trigger = (prop) => (id) => ({ path: dialect.takeControl(id, prop), value: true });
  return {
    take: trigger('xTake'),
    cut: trigger('xCut'),
    stepBack: trigger('xStepBack'),
    abort: trigger('xTakeAbort'),
    copyProgramToPreview: trigger('xCopyProgramToPreview'),

    /** Transition time, in tenths of a second, as one or more writes. */
    fade: (id, tenths) => dialect.fadeCmds(id, tenths),

    /**
     * Recall a screen or aux memory. `mode` defaults to PREVIEW, as every
     * other recall in the cue path does: a recall that lands on air by
     * accident is the worst thing this tool could do.
     */
    recallScreenPreset: (slot, id, mode = 'PREVIEW') => dialect.recall('screen', slot, { mode, id }),
    recallMasterPreset: (slot, mode = 'PREVIEW') => dialect.recall('master', slot, { mode })
  };
}

/** No platform known yet: every command declines to be built. */
const NONE = Object.freeze({
  take: () => null,
  cut: () => null,
  stepBack: () => null,
  abort: () => null,
  copyProgramToPreview: () => null,
  fade: () => [],
  recallScreenPreset: () => null,
  recallMasterPreset: () => null
});
