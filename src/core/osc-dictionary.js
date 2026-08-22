/*
 * The OSC dictionary this app publishes, widened by the device's own catalogue.
 *
 * ## Two halves, from two places, and that is the point
 *
 * The address space itself — `/lp/screen/1/take`, `/lp/master/memory/12/store`,
 * the five rules about triggers, presets and normalised values — belongs to
 * `../vendor/mynah-lang.mjs`. It is the same file the Console parses with, and
 * for the same reason: one statement of the grammar, copied rather than
 * re-derived. Nothing here re-implements any of it.
 *
 * What this file adds is the **parameter table**. Mynah ships the seven layer
 * parameters and ten group parameters it can vouch for from its own model. The
 * control surface's `catalogue.json` holds sixty-seven and nineteen,
 * generated from a switcher's own Web RCS bundle, so every range in it is the
 * device's statement about itself. Passing that in is what turns a small
 * address space into the whole mappable surface of a layer — and it is exactly
 * the set the MIDI mapping already binds to, which is what makes this *the*
 * dictionary rather than a second one.
 *
 * ```text
 *   mynah's built-ins      /lp/screen/1/preset/a/layer/2/opacity/opacity
 *   the catalogue adds     /lp/screen/1/preset/a/layer/2/cropping/classic/left
 *                          /lp/screen/1/preset/a/layer/2/keying/enable
 * ```
 *
 * ## Read-only parameters are carried, not dropped
 *
 * The catalogue marks them; the resolver refuses them by name
 * (`… is read-only on this device`) and the generated document leaves them
 * out. Both behaviours want the flag present, so it is passed through rather
 * than filtered here — a table that had already dropped them could only say
 * "no such parameter", which sends someone looking for a typo that is not
 * there.
 *
 * ## Regenerating the catalogue changes the dictionary
 *
 * That is intended. The ids are structural — a parameter's dotted node path
 * inside a layer, which is its OSC address tail with the dots swapped for
 * slashes — so a catalogue generated against a different firmware produces a
 * document that matches that firmware, with nobody editing prose.
 */

import { layerParams, screenGroupParams, meta } from '../vendor/surface/catalogue.js';
import { BUILTIN_PARAMS } from '../vendor/mynah-lang.mjs';

/**
 * A human sentence for a parameter, where this repo has one worth adding.
 *
 * Only the ones whose behaviour surprises people. The generator falls back to
 * the parameter's id and range for everything else, which is honest: inventing
 * a description for all sixty-seven would mean writing sixty-seven sentences
 * nobody had verified, and a confident wrong sentence in a published
 * dictionary is worse than a bare id.
 */
const NOTES = {
  'source.inputNum': 'Which input the layer shows. An enum name, not a number.',
  'position.posH': 'Horizontal centre of the layer, in pixels. Negative is normal — the anchor is the centre, so a layer half off the canvas has a negative position.',
  'position.posV': 'Vertical centre of the layer, in pixels.',
  'position.sizeH': 'Layer width in pixels.',
  'position.sizeV': 'Layer height in pixels.',
  'position.anchor': 'Which point of the layer its position refers to. The device defaults to MIDDLE_CENTER.',
  'opacity.opacity': 'Layer opacity. The range is 0–256, not 0–100.',
  'control.xTake': 'Transition preview to program.',
  'control.xCut': 'Swap preview and program with no transition.',
  'control.xTakeAbort': 'Stop a transition in progress.',
  'control.xStepBack': 'Undo the last take.',
  'control.xCopyProgramToPreview': 'Copy what is on air back into preview.',
  'control.takeUpTime': 'Transition time towards the up preset, in tenths of a second.',
  'control.takeDownTime': 'Transition time towards the down preset, in tenths of a second.',
  'control.tbarPosition': 'T-bar position. Full throw completes the transition.',
};

/**
 * Merge a catalogue list with mynah's built-ins.
 *
 * The catalogue wins on ranges — it read them off a device — and the built-ins
 * contribute anything the catalogue does not carry, plus the human notes.
 * Mynah's own entries are kept for ids the catalogue lacks rather than
 * dropped, so a catalogue generated against a chassis without some feature
 * cannot silently narrow the published dictionary below what mynah alone
 * already answers.
 */
function merge(catalogue, builtins) {
  const out = new Map();
  for (const spec of builtins) out.set(spec.id, spec);
  for (const spec of catalogue) {
    const prior = out.get(spec.id);
    out.set(spec.id, {
      ...spec,
      summary: NOTES[spec.id] ?? prior?.summary,
      /* The catalogue publishes `values` for an enum; where it does not, a
         built-in's list is better than none, because `/norm` needs something
         to scale onto and the document wants something to show. */
      values: spec.values ?? prior?.values,
    });
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * The parameter table to resolve OSC addresses against.
 *
 * Hand this to `run()` as `{ osc: { params: PARAMS, buffer } }` and to
 * `oscDictionary()` to generate the document. Same table both times — a
 * document generated from a different table than the resolver uses is a
 * document that lies, and that is the failure this whole arrangement exists
 * to make impossible.
 */
export const PARAMS = {
  layer: merge(layerParams, BUILTIN_PARAMS.layer),
  screenGroup: merge(screenGroupParams, BUILTIN_PARAMS.screenGroup),
};

/** Where the catalogue half of the table came from, for the document header. */
export const PROVENANCE = {
  device: meta.device,
  generatedFrom: meta.generatedFrom,
  layerCount: PARAMS.layer.length,
  groupCount: PARAMS.screenGroup.length,
};
