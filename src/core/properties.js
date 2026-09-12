/*
 * Layer properties, read and written through the vendored catalogue.
 *
 * ## Why there is a catalogue and not a form
 *
 * A layer has 67 properties across twelve groups, every one with its own type,
 * range and enum. Hand-writing a form for that is a transcription job that is
 * wrong the moment a firmware adds a flag — and it is exactly the job
 * `vendor/surface/catalogue.json` already did, generated from a device's own
 * Web RCS bundle and store dump for the MIDI mapper. So this file renders
 * *nothing*: it turns the catalogue into groups, addresses, and validated
 * writes, and the panel draws whatever comes out. Regenerate the catalogue
 * against a new firmware and the panel grows the new properties on its own.
 *
 * ## What the vendor's own Properties tab does that this cannot
 *
 * It follows the layer you have selected by clicking it. That selection is
 * React state inside the vendor bundle — there is no `isSelected` anywhere in
 * the device store, and nothing in the catalogue — so a second window has no
 * way to read it. This addresses a layer explicitly instead: destination,
 * preset buffer, layer key. For a window living on a second monitor that is
 * arguably the better behaviour, because it stays where you put it.
 *
 * ## The one that will bite
 *
 * You do not address PROGRAM and PREVIEW here, you address a LETTER — A, B or
 * C — and which letter is on air changes on every take. `bankLetter()` is the
 * only sanctioned way to turn one into the other, and it refuses mid-take
 * rather than guessing, because a write to the wrong letter during a
 * transition lands on the output. See `vendor/surface/preset.js`.
 */

import { presetBanks } from './screens.js';
import { dialectFor } from './dialect.js';
import { layerParams, enums } from '../vendor/surface/catalogue.js';
import { layerParam, auxLayerParam } from '../vendor/surface/paths.js';

/**
 * The twelve groups a layer's properties fall into, in the order the vendor's
 * own panel shows them — source first, then where it sits, then what it looks
 * like, then how it moves. Anything the catalogue grows that is not named here
 * still appears; it just sorts to the end under its own raw name.
 */
const GROUP_LABELS = {
  source: 'Source',
  position: 'Position and size',
  opacity: 'Opacity',
  cropping: 'Cropping and mask',
  border: 'Border',
  effects: 'Effects',
  keying: 'Keying',
  cutNFill: 'Cut and fill',
  transition: 'Transition',
  flying: 'Flying curve',
  timing: 'Timing',
  speed: 'Speed'
};

const GROUP_ORDER = Object.keys(GROUP_LABELS);

/**
 * The catalogue, grouped for display.
 *
 * Read-only parameters are kept rather than filtered out: `source.status.
 * inputNum` is the device reporting what the layer is *actually* showing as
 * against what it has been told to show, and during a load those differ. That
 * disagreement is worth being able to see, so the panel renders them disabled.
 */
export function layerSections() {
  const groups = new Map();
  for (const spec of layerParams) {
    const head = String(spec.id).split('.')[0];
    if (!groups.has(head)) groups.set(head, []);
    groups.get(head).push(spec);
  }
  const rank = (id) => {
    const i = GROUP_ORDER.indexOf(id);
    return i === -1 ? GROUP_ORDER.length : i;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([id, params]) => ({ id, label: GROUP_LABELS[id] || id, params }));
}

/** The member list for a spec's enum, whichever way the catalogue spelled it. */
export const valuesFor = (spec) =>
  (Array.isArray(spec && spec.values) && spec.values) ||
  (spec && spec.enum && enums[spec.enum]) || [];

/* ------------------------------------------------------------- addressing */

/**
 * The store path for one property of one layer.
 *
 * `target` is `{id, bank, layer}` — a destination key, a preset LETTER, and a
 * layer key. Screens and auxiliaries live in different collections, so the id
 * decides which addresser is used; everything below that is identical.
 */
export function paramPath(target, spec) {
  if (!target || !target.id || !target.bank || target.layer == null) return null;
  const build = String(target.id).startsWith('A') ? auxLayerParam : layerParam;
  return build(target.id, target.bank, target.layer, spec.path);
}

/** Read one property's current value, or undefined if it is not in the mirror. */
export function readValue(store, target, spec) {
  const path = paramPath(target, spec);
  return path ? store.get(path) : undefined;
}

/* ---------------------------------------------------------------- writing */

/**
 * Coerce a value the way the device would, and say so when it had to.
 *
 * Returns `{ok, value, note}`. `ok: false` means refuse — do not send anything
 * — which is the right answer for a number field someone is halfway through
 * typing. A clamp is not a refusal: the device clamps too, and reporting the
 * clamp is friendlier than either silently sending an out-of-range value or
 * blocking the edit.
 *
 * Ints are rounded because the device rejects fractional ints outright. That
 * is the same rule `vendor/surface/value.js` applies to fader movements, for
 * the same reason.
 */
export function coerce(spec, raw) {
  if (!spec) return { ok: false, note: 'unknown parameter' };
  if (spec.readOnly) return { ok: false, note: 'read-only' };

  switch (spec.type) {
    case 'bool':
      return { ok: true, value: raw === true || raw === 'true' || raw === 1 };

    case 'enum': {
      const values = valuesFor(spec);
      const value = String(raw);
      if (values.length && !values.includes(value)) {
        return { ok: false, note: `not a member of ${spec.enum || 'the list'}` };
      }
      return { ok: true, value };
    }

    case 'map': {
      /* A flag set. The device wants the whole array every time — this is a
         write of the new set, not a toggle of one member — so a caller that
         sends only the flag it just ticked silently clears the rest. */
      const values = valuesFor(spec);
      const list = Array.isArray(raw) ? raw.map(String) : [];
      const bad = list.find((f) => values.length && !values.includes(f));
      if (bad) return { ok: false, note: `${bad} is not a member of ${spec.enum || 'the list'}` };
      if (spec.capacity && list.length > spec.capacity) {
        return { ok: false, note: `at most ${spec.capacity} at once` };
      }
      return { ok: true, value: [...new Set(list)] };
    }

    case 'int':
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(n)) return { ok: false, note: 'not a number' };
      let value = spec.type === 'int' ? Math.round(n) : n;
      let note = null;
      if (Number.isFinite(spec.min) && value < spec.min) { value = spec.min; note = `clamped to ${spec.min}`; }
      if (Number.isFinite(spec.max) && value > spec.max) { value = spec.max; note = `clamped to ${spec.max}`; }
      return { ok: true, value, note };
    }

    default:
      return { ok: false, note: `unsupported type ${spec.type}` };
  }
}

/**
 * The write for one property, or null when the value is not sendable.
 *
 * The `note` from `coerce` rides along so a caller can report a clamp without
 * having to redo the arithmetic.
 */
export function writeCmd(target, spec, raw) {
  const path = paramPath(target, spec);
  if (!path) return null;
  const result = coerce(spec, raw);
  if (!result.ok) return null;
  return { path, value: result.value, note: result.note || null };
}

/* ------------------------------------------------------------- addressing */

/**
 * The layers a destination actually has.
 *
 * The gate is the platform's fitted-layer list, not the preset's: a preset
 * carries geometry for every slot whether or not the hardware has them, and
 * drawing from the preset alone invents layers. `core/screens.js` learned this
 * the hard way; both now ask `core/dialect.js`, which knows where each
 * platform keeps the answer.
 *
 * NATIVE sorts last. It is a real, addressable layer slot, but it is the
 * background plane rather than a layer someone put a source on, so it does not
 * belong at the top of a picker above layer 1.
 */
export function fittedLayers(store, id) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  /* The gate itself lives with the platform's other spellings: capability on
     a LivePremier's layer list, the applied preconfig's layer mode on a
     Midra. See `core/dialect.js`. */
  return dialect.fittedLayers(store, id)
    .map((l) => ({ key: l.key, capability: l.capability }))
    .sort((a, b) => {
      if (a.key === 'NATIVE') return 1;
      if (b.key === 'NATIVE') return -1;
      return Number(a.key) - Number(b.key);
    });
}

/**
 * Turn PROGRAM or PREVIEW into the letter that means it right now.
 *
 * Returns `{letter, live, settled}`. `settled` is false while a take is in
 * flight, when there is no honest answer to "which buffer is preview" — a
 * caller about to WRITE should refuse rather than pick one, because the wrong
 * choice during a transition lands on the output. A caller only READING can
 * carry on; the letter it gets is the one the take started from.
 *
 * A literal letter is passed straight through, with `live` still answered,
 * because deliberately editing the buffer that is on air is a legitimate thing
 * an operator does — it just should not happen by accident.
 */
export function bankLetter(store, id, mode) {
  const banks = presetBanks(store, id);
  if (mode === 'PROGRAM' || mode === 'PREVIEW') {
    const letter = mode === 'PROGRAM' ? banks.program : banks.preview;
    return { letter, live: mode === 'PROGRAM', settled: banks.settled, reported: banks.reported };
  }
  return {
    letter: mode,
    live: mode === banks.program,
    settled: banks.settled,
    reported: banks.reported
  };
}
