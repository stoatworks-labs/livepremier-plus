/*
 * Controller profiles: what a surface has on it, and what each control does.
 *
 * A profile is plain JSON in two halves, and the split is the point:
 *
 *   controls   the physical surface. Which MIDI message each fader, encoder
 *              and button produces, and what kind of thing it is. This is a
 *              property of the hardware and never changes.
 *   bindings   what those controls are wired to. This is the show, and is what
 *              MIDI-learn edits.
 *
 * Keeping them apart means a user can re-map an APC40 completely without
 * re-describing an APC40, and that a binding set written for one surface can be
 * pointed at another by swapping the control ids.
 */

export const CONTROL_KINDS = ['fader', 'fader14', 'knob', 'encoder', 'button', 'touch'];

/** Control kinds that carry a position rather than a movement or a state. */
export const ABSOLUTE_KINDS = new Set(['fader', 'fader14', 'knob']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Check a profile and report everything wrong with it.
 *
 * Returns a list of problems rather than throwing on the first: a profile is
 * edited by hand and by a UI, and being told about one mistake at a time is
 * miserable. An empty list means the profile is usable.
 */
export function validate(profile) {
  const problems = [];
  const at = (where, msg) => problems.push(`${where}: ${msg}`);

  if (!isObj(profile)) return ['profile is not an object'];
  if (!profile.id) at('profile', 'missing id');
  if (!Array.isArray(profile.controls)) at('profile', 'controls must be an array');
  if (!Array.isArray(profile.bindings)) at('profile', 'bindings must be an array');
  if (problems.length) return problems;

  const seen = new Set();
  for (const [i, c] of profile.controls.entries()) {
    const where = `controls[${i}]`;
    if (!c.id) at(where, 'missing id');
    else if (seen.has(c.id)) at(where, `duplicate control id ${c.id}`);
    else seen.add(c.id);
    if (!CONTROL_KINDS.includes(c.kind)) at(where, `unknown kind ${c.kind}`);
    if (c.kind === 'encoder' && c.relative && !['signed', 'twos', 'offset'].includes(c.relative)) {
      at(where, `unknown relative mode ${c.relative}`);
    }
  }

  for (const [i, b] of profile.bindings.entries()) {
    const where = `bindings[${i}]`;
    if (!b.control) at(where, 'missing control');
    else if (!seen.has(b.control)) at(where, `no such control ${b.control}`);
    if (!isObj(b.target)) { at(where, 'missing target'); continue; }
    const t = b.target;
    if (!['layer', 'screenGroup', 'action'].includes(t.kind)) {
      at(where, `unknown target kind ${t.kind}`);
    }
    if (t.kind === 'action' && !t.action) at(where, 'action target needs an action');
    if (t.kind !== 'action' && !t.param) at(where, `${t.kind} target needs a param`);
  }
  return problems;
}

/** Index a profile's controls by id. */
export const controlIndex = (profile) =>
  new Map((profile.controls ?? []).map((c) => [c.id, c]));

/**
 * Group bindings by the control they belong to.
 *
 * A control may carry more than one binding — a button that both selects a
 * layer and lights to show the selection is two bindings on one note — so this
 * is a multimap, not a lookup.
 */
export function bindingIndex(profile) {
  const out = new Map();
  for (const b of profile.bindings ?? []) {
    if (!out.has(b.control)) out.set(b.control, []);
    out.get(b.control).push(b);
  }
  return out;
}

/** Merge a saved binding set onto a hardware description. */
export const withBindings = (profile, bindings) => ({ ...profile, bindings });
