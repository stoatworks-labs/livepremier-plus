/*
 * Names for layers, which the switcher does not have.
 *
 * ## ⚠️ Read this before wondering where the device keeps them
 *
 * It does not. A LivePremier labels a great many things — inputs, stills,
 * outputs, screens, auxiliaries, EDIDs, Dante channels, and every memory slot
 * in every bank, including the *layer memory* bank whose slots are called
 * things like "Lower third look". Thirty-seven distinct label-bearing paths
 * were mapped out of a live store on 2026-09-22, and **not one of them is on a
 * layer**. A layer's own node carries `freeze`, `capability`, `scope` and the
 * rest, and nothing a human could write a word into.
 *
 * So a layer name is *ours*. It is kept beside the cue stack and the layer
 * groups, keyed by device for the same reason they are — `S1/2` means a layer
 * slot on one box's preconfig and means something else, or nothing, on
 * another. And it follows that:
 *
 * - **Nothing that talks to the switcher can see it.** A second operator's
 *   own browser, a Companion module on the vendor's WebSocket, an AWJ client
 *   — none of them have anywhere to read it from. `GET /__lpp/layer-names` is
 *   the only way in, and anything using it depends on this app running.
 * - **It cannot be made to appear in the vendor's UI by writing a property**,
 *   because there is no property. Where names show up in Web RCS's own pages,
 *   they are put there by `plugins/layer-names/labels.js` reaching into the DOM — which
 *   is why that file is careful and why this one is not.
 *
 * ## The key
 *
 * `S1/2`, exactly as `core/groups.js` spells a member, because the two are the
 * same idea — a destination and a layer slot — and having two spellings for
 * one address is how they drift. `memberKey` is re-exported rather than
 * redefined so that stays true by construction.
 */

import { memberKey } from './groups.js';

/** The stored shape's version, so a later change can migrate rather than guess. */
export const NAMES_VERSION = 1;

/** How long a name may be. Long enough for "Presenter IMAG", short enough to fit a row. */
export const MAX_NAME = 32;

export { memberKey };

const isKey = (v) => typeof v === 'string' && /^[SA]\d+$/.test(v);

/**
 * Coerce whatever was on disk into a name map that cannot misbehave.
 *
 * Nothing is rejected outright, for the reason `core/groups.js` gives: a
 * stored file may have been hand-edited and refusing to start over one bad row
 * would cost an operator their names on a show day. A row that cannot be made
 * sense of is dropped.
 *
 * ⚠️ Names are trimmed and **collapsed to one line**. They are drawn into
 * single-row table cells and into the vendor's own layer list, and a newline
 * would either break that layout or be silently swallowed depending on where
 * it landed — so it is removed here, once, rather than in each of the five
 * places a name is rendered.
 */
export function normalise(raw) {
  const source = raw && typeof raw === 'object'
    ? (raw.names && typeof raw.names === 'object' ? raw.names : raw)
    : {};
  const names = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'version' || key === 'names') continue;
    if (typeof value !== 'string') continue;
    const parsed = parseKey(key);
    if (!parsed) continue;
    const name = clean(value);
    if (!name) continue;
    names[memberKey(parsed)] = name;
  }
  return { version: NAMES_VERSION, names };
}

/** One name, as it will be stored. Empty means "no name", which is how one is cleared. */
export function clean(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME);
}

/** `S1/2` -> `{id: 'S1', layer: '2'}`, or null for anything that is not one. */
export function parseKey(key) {
  const m = /^([SA]\d+)\/(.+)$/.exec(String(key ?? ''));
  if (!m) return null;
  const layer = String(m[2]).trim().toUpperCase();
  if (!isKey(m[1]) || !layer) return null;
  return { id: m[1], layer };
}

/** The name of one layer, or null. */
export function nameOf(names, id, layer) {
  if (!names) return null;
  return names[memberKey({ id, layer })] || null;
}

/**
 * How a layer is written wherever a person reads it.
 *
 * The slot always leads and the name follows, never the other way round and
 * never the name alone. An operator addresses layer 2 of screen 1 — in a
 * console line, in a MIDI mapping, over OSC — and a row that said only
 * "IMAG" would have hidden the one part of the label that is also the
 * address. The name is the annotation, not the identifier.
 */
export function layerLabel(names, id, layer, { short = false } = {}) {
  const slot = layer === 'NATIVE' ? (short ? 'NAT' : 'NATIVE') : 'L' + layer;
  const name = nameOf(names, id, layer);
  return name ? `${slot} — ${name}` : slot;
}

/**
 * Set or clear one name, returning a new map.
 *
 * An empty or whitespace-only value **removes** the entry rather than storing
 * an empty string, so "no name" has one representation and a file cannot
 * accumulate blanks that read as named layers to anything checking presence.
 */
export function withName(names, id, layer, value) {
  const key = memberKey({ id, layer });
  const next = { ...(names || {}) };
  const name = clean(value);
  if (name) next[key] = name; else delete next[key];
  return next;
}

/**
 * Find a layer by name, for a caller that was handed one by a person.
 *
 * Case- and space-insensitive, because a name typed at a console will not
 * match the capitalisation it was stored with, and matching exactly would
 * make the feature useless at the one keyboard it is most wanted at.
 *
 * ⚠️ Returns **all** matches rather than the first. Nothing stops two screens
 * having a layer called "IMAG" — it is in fact the likely case, since that is
 * what a layer group is for — so a caller that wants one has to say which
 * screen, and a caller that wants them all can have them. Picking the first
 * would put a source on one screen and look like it had worked.
 */
export function findByName(names, wanted, { id = null } = {}) {
  const needle = clean(wanted).toLowerCase();
  if (!needle) return [];
  const out = [];
  for (const [key, name] of Object.entries(names || {})) {
    if (name.toLowerCase() !== needle) continue;
    const parsed = parseKey(key);
    if (!parsed) continue;
    if (id && parsed.id !== id) continue;
    out.push(parsed);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })
    || String(a.layer).localeCompare(String(b.layer), undefined, { numeric: true }));
}
