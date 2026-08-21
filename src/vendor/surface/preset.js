/*
 * Resolving PREVIEW and PROGRAM to a preset letter.
 *
 * A screen holds three preset memories, keyed 'A', 'B' and 'C'. Nothing in a
 * layer path says "preview" — you address a letter. Which letter is on air is
 * device state, and it changes every time somebody presses TAKE.
 *
 * The mechanism, confirmed on a simulator by firing TAKE and re-reading:
 *
 *   control/pp/presetUp        'B'        these three DO NOT MOVE
 *   control/pp/presetDown      'A'
 *   control/pp/presetPrevious  'C'
 *   status/pp/transition       'AT_DOWN'  <- this is what flips
 *
 * After a TAKE the letters were unchanged and `transition` became 'AT_UP'.
 * So the T-bar's resting end names the program preset:
 *
 *   AT_DOWN -> program = presetDown, preview = presetUp
 *   AT_UP   -> program = presetUp,   preview = presetDown
 *
 * This matters more for a control surface than it looks. A fader bound to
 * "layer 3 opacity on preview" addresses a different letter after every take.
 * Binding it to a letter instead would silently turn a preview fader into a
 * live one halfway through a show.
 */

export const PREVIEW = 'PREVIEW';
export const PROGRAM = 'PROGRAM';

/*
 * The six values `status/transition` can take, from the device's own
 * SCREENGROUP_STATUS enum:
 *
 *   AT_DOWN            resting, down preset on air
 *   AT_UP              resting, up preset on air
 *   EFFECT_FROM_DOWN   mid-transition, having started from down
 *   EFFECT_FROM_UP     mid-transition, having started from up
 *   COPY_FROM_DOWN     copying down onto up
 *   COPY_FROM_UP       copying up onto down
 *
 * Every one of them names the end the T-bar is at or came from, so the whole
 * rule is the suffix. Testing only for AT_UP would get all four in-flight
 * states backwards, which would silently point a "preview" fader at the output
 * for the length of a transition.
 */
const AT_DOWN = 'AT_DOWN';
const AT_UP = 'AT_UP';
const RESTING = new Set([AT_DOWN, AT_UP]);

/**
 * Work out which preset letter is program and which is preview.
 *
 * `group` is the screenAuxGroup item: `{control: {pp}, status: {pp}}`.
 * Returns null when the group has not been read yet, so callers can hold off
 * rather than write to a guessed letter.
 */
export function resolve(group) {
  const control = group?.control?.pp;
  const status = group?.status?.pp;
  if (!control || !status) return null;
  const { presetUp, presetDown, presetPrevious } = control;
  if (!presetUp || !presetDown) return null;

  /*
   * Mid-transition the T-bar is at neither end and the device is showing a mix
   * of both presets, so there is no honest answer to "which one is program".
   * Reporting the end it started from keeps a surface pointing at the letter it
   * had before the take began, rather than flipping halfway through the fade.
   * `settled` is exported so a caller that needs certainty can wait.
   */
  const settled = RESTING.has(status.transition);
  const down = String(status.transition ?? AT_DOWN).endsWith('DOWN');

  return {
    program: down ? presetDown : presetUp,
    preview: down ? presetUp : presetDown,
    previous: presetPrevious ?? null,
    settled,
    transition: status.transition ?? null
  };
}

/**
 * Turn a binding's preset selector into a literal letter.
 *
 * Accepts 'PREVIEW', 'PROGRAM', or a literal 'A' | 'B' | 'C' — a literal is
 * passed through untouched, which is what an operator wants when they are
 * deliberately editing a memory that is neither on air nor cued.
 *
 * Returns null when a symbolic selector cannot be resolved yet.
 */
export function letterFor(selector, group) {
  if (selector !== PREVIEW && selector !== PROGRAM) return selector;
  const r = resolve(group);
  if (!r) return null;
  return selector === PREVIEW ? r.preview : r.program;
}
