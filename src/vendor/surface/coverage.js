/*
 * Profile coverage — the bring-up checklist.
 *
 * Every shipped controller profile was transcribed from documentation rather
 * than from hardware, and a MIDI implementation chart is exactly the kind of
 * document that is quietly wrong: a note number off by one, a channel that is
 * 1-based in the manual and 0-based on the wire, an encoder that turns out to
 * send notes instead of a CC.
 *
 * So the first thing anyone does with a new surface is touch every control and
 * see what comes out. This turns that into a checklist with an answer at the
 * end, rather than a scroll of hex.
 *
 * Pure, and deliberately so: it runs in the browser, in the server and in the
 * tests without knowing where the observations came from.
 */

import { controlIndex } from './profile.js';

/**
 * Compare what a profile claims exists against what the surface has actually
 * sent.
 *
 * `seen` maps a control id to `{count, kind, last}`. Anything the profile
 * declares but has never sent is `missing`; anything sent that the profile has
 * never heard of is `unexpected`. Both matter, and they mean different things:
 * missing usually means a wrong number, unexpected usually means the surface
 * has controls nobody wrote down.
 */
export function coverage(profile, seen) {
  const controls = controlIndex(profile);
  const bound = new Set((profile.bindings ?? []).map((b) => b.control));

  const expected = [];
  for (const control of controls.values()) {
    const hit = seen.get(control.id);
    expected.push({
      id: control.id,
      label: control.label ?? control.id,
      kind: control.kind,
      strip: control.strip,
      bound: bound.has(control.id),
      count: hit?.count ?? 0,
      seen: !!hit
    });
  }

  const unexpected = [];
  for (const [id, hit] of seen) {
    if (controls.has(id)) continue;
    unexpected.push({ id, count: hit.count, kind: hit.kind ?? null, last: hit.last ?? null });
  }

  const missing = expected.filter((c) => !c.seen);
  return {
    expected,
    unexpected: unexpected.sort((a, b) => b.count - a.count),
    missing,
    stats: {
      declared: expected.length,
      confirmed: expected.length - missing.length,
      missing: missing.length,
      unexpected: unexpected.length
    }
  };
}

/**
 * Guess what an unexpected control probably is, from how it behaved.
 *
 * Only ever a hint for a human deciding what to add to a profile — the whole
 * point of bring-up is that nothing here is trusted. The interesting case is
 * the third one: a CC whose values cluster at the two ends of the
 * sign-magnitude split is an encoder being read as a fader, which is the
 * single most common way a transcribed profile is wrong.
 */
export function classify(observations) {
  if (!observations?.length) return { kind: null, why: 'nothing observed' };
  const kinds = new Set(observations.map((o) => o.type));

  if (kinds.has('noteOn') || kinds.has('noteOff')) {
    return { kind: 'button', why: 'sends note on/off' };
  }
  if (kinds.has('pitchBend')) {
    return { kind: 'fader14', why: '14-bit pitch bend, so a Mackie-style fader' };
  }

  /*
   * OSC carries no hint of what a control IS — the same address is a fader or a
   * button depending only on how it is declared. All that is available is the
   * shape of the values, and the only reliable split is that a button sends
   * nothing but the two ends while anything that slides visits the middle.
   */
  if (kinds.has('osc')) {
    const args = observations.filter((o) => o.type === 'osc').map((o) => o.value);
    if (args.every((v) => v === undefined || typeof v === 'boolean')) {
      return { kind: 'button', why: 'sends booleans, or no argument at all' };
    }
    const numeric = args.filter((v) => typeof v === 'number');
    if (numeric.length && numeric.every((v) => v === 0 || v === 1)) {
      return { kind: 'button', why: 'only ever 0 or 1' };
    }
    if (numeric.length) {
      const span = Math.max(...numeric) - Math.min(...numeric);
      return {
        kind: 'fader',
        why: span > 0 ? 'continuous values between the ends — a position' : 'a single held value'
      };
    }
    return { kind: 'button', why: 'no numeric argument' };
  }

  const values = observations.filter((o) => o.type === 'cc').map((o) => o.value);
  if (!values.length) return { kind: null, why: 'no usable messages' };

  const distinct = new Set(values);
  /* A sign-magnitude encoder only ever emits small values and values just
     above 0x40. A fader sweeps through the middle; an encoder never does. */
  const lowOnly = values.every((v) => v <= 0x08 || (v >= 0x41 && v <= 0x48));
  if (lowOnly && distinct.size <= 6 && values.length >= 4) {
    return { kind: 'encoder', relative: 'signed', why: 'values cluster either side of 0x40 — relative, not a position' };
  }
  const nearCentre = values.every((v) => Math.abs(v - 64) <= 8);
  if (nearCentre && distinct.size <= 6 && values.length >= 4) {
    return { kind: 'encoder', relative: 'offset', why: 'values sit around 64 — binary-offset relative' };
  }
  if (distinct.size > 8 && Math.max(...values) - Math.min(...values) > 40) {
    return { kind: 'fader', why: 'sweeps a wide range of values — absolute' };
  }
  return { kind: 'fader', why: 'control change, too few samples to tell fader from encoder' };
}

/** A short human summary, for a CLI or a status line. */
export function summarise({ stats }) {
  const parts = [`${stats.confirmed}/${stats.declared} controls confirmed`];
  if (stats.missing) parts.push(`${stats.missing} never seen`);
  if (stats.unexpected) parts.push(`${stats.unexpected} not in the profile`);
  return parts.join(', ');
}
