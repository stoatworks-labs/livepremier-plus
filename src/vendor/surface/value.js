/*
 * Turning control movements into parameter values, and back again.
 *
 * Everything a physical surface produces is normalised to one of three shapes
 * before it reaches here — an absolute position in 0..1, a relative delta in
 * encoder detents, or a button transition — so that a fader on an X-Touch
 * (14-bit pitch bend) and a fader on an APC40 (7-bit CC) are the same event by
 * the time a parameter sees them.
 *
 * The reverse direction matters just as much: with motor faders and LED rings
 * in scope, every parameter must be able to say where a control should sit.
 */

/* --------------------------------------------------------------- clamping */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const isNum = (t) => t === 'int' || t === 'number';

/**
 * The value range a binding actually works over.
 *
 * A parameter's own range is often unusable as a fader throw. `position.posH`
 * runs -2,000,000..2,000,000, so one step of a 7-bit fader would be about
 * 31,500 pixels — the control would be useless. A binding may therefore narrow
 * the range to something an operator can steer, and the narrowed range is
 * clamped to the parameter's own so a profile cannot ask for the impossible.
 */
export function rangeOf(spec, binding = {}) {
  const lo = spec.min ?? 0;
  const hi = spec.max ?? 1;
  const min = binding.min === undefined ? lo : clamp(binding.min, lo, hi);
  const max = binding.max === undefined ? hi : clamp(binding.max, lo, hi);
  return max >= min ? { min, max } : { min: max, max: min };
}

/* ------------------------------------------------------- control -> value */

/**
 * Apply an absolute control position (0..1) to a parameter.
 *
 * Rounding is deliberate for `int`: the device rejects fractional ints, and
 * `opacity` in particular runs 0..256, so a fader at the top must land on 256
 * exactly rather than 255.997.
 */
export function fromAbsolute(spec, norm, binding = {}) {
  const n = clamp(norm, 0, 1);
  if (spec.type === 'bool') return n >= 0.5;
  if (spec.type === 'enum') {
    const vals = binding.values ?? spec.values ?? [];
    if (!vals.length) return undefined;
    return vals[clamp(Math.round(n * (vals.length - 1)), 0, vals.length - 1)];
  }
  if (!isNum(spec.type)) return undefined;
  const { min, max } = rangeOf(spec, binding);
  const raw = min + n * (max - min);
  return spec.type === 'int' ? Math.round(raw) : raw;
}

/**
 * Apply a relative movement — one encoder detent is `delta` of 1.
 *
 * `step` is in parameter units for numbers and in list positions for enums.
 * It defaults to something usable rather than to 1: a single detent moving
 * `position.posH` by one pixel would take 40,000 turns to cross a range.
 */
export function fromRelative(spec, delta, current, binding = {}) {
  if (spec.type === 'enum') {
    const vals = binding.values ?? spec.values ?? [];
    if (!vals.length) return undefined;
    const at = vals.indexOf(current);
    const next = (at < 0 ? 0 : at) + Math.round(delta * (binding.step ?? 1));
    return binding.wrap
      ? vals[((next % vals.length) + vals.length) % vals.length]
      : vals[clamp(next, 0, vals.length - 1)];
  }
  if (spec.type === 'bool') return delta === 0 ? current : delta > 0;
  if (!isNum(spec.type)) return undefined;
  const { min, max } = rangeOf(spec, binding);
  const step = binding.step ?? defaultStep(spec, binding);
  const base = typeof current === 'number' ? current : min;
  const raw = clamp(base + delta * step, min, max);
  return spec.type === 'int' ? Math.round(raw) : raw;
}

/**
 * A detent size that crosses the usable range in a reasonable number of turns.
 *
 * 128 detents is one full sweep of a typical endless encoder's indent count
 * times four, which lands close to how the vendor UI's own drag behaves.
 */
export function defaultStep(spec, binding = {}) {
  const { min, max } = rangeOf(spec, binding);
  const span = max - min;
  if (spec.type === 'int' && span <= 256) return 1;
  const step = span / 128;
  return spec.type === 'int' ? Math.max(1, Math.round(step)) : step;
}

/**
 * Apply a button press.
 *
 * `action` is one of:
 *   toggle    invert a bool, or step an enum by one
 *   set       write `binding.value` outright
 *   momentary `binding.value` while held, `binding.releaseValue` on release
 *   trigger   write true — the device's x-prefixed action properties are
 *             write-true-to-fire and do not need a matching false
 *
 * Returns `undefined` when the press should produce no write at all, which is
 * how a momentary release with nothing to restore stays silent.
 */
export function fromButton(spec, down, current, binding = {}) {
  const action = binding.action ?? (spec.type === 'bool' ? 'toggle' : 'set');
  /*
   * "Put this back where it started" is worth having on a push-encoder, and the
   * only sensible source for that value is the device's own stated default —
   * which the catalogue carries for every parameter. Spelling it out in the
   * binding instead would bake one firmware's defaults into a profile.
   */
  if (binding.resetToDefault) return down && spec.def !== undefined ? spec.def : undefined;
  switch (action) {
    case 'trigger':
      return down ? true : undefined;
    case 'momentary':
      if (down) return binding.value ?? true;
      return binding.releaseValue === undefined ? undefined : binding.releaseValue;
    case 'set':
      return down ? binding.value : undefined;
    case 'toggle': {
      if (!down) return undefined;
      if (spec.type === 'bool') return !current;
      if (spec.type === 'enum') return fromRelative(spec, 1, current, { ...binding, wrap: true });
      const { min, max } = rangeOf(spec, binding);
      return current === max ? min : max;
    }
    default:
      return undefined;
  }
}

/* ------------------------------------------------------- value -> control */

/**
 * Where a control should sit to represent `value`, as 0..1.
 *
 * This is what drives motor faders, LED rings and meter-style feedback. It
 * returns null for values that have no position — an enum member outside the
 * binding's own list, or a parameter that has not been read yet — so that a
 * host can leave the control alone instead of slamming it to zero.
 */
export function toAbsolute(spec, value, binding = {}) {
  if (value === undefined || value === null) return null;
  if (spec.type === 'bool') return value ? 1 : 0;
  if (spec.type === 'enum') {
    const vals = binding.values ?? spec.values ?? [];
    const at = vals.indexOf(value);
    if (at < 0) return null;
    return vals.length > 1 ? at / (vals.length - 1) : 0;
  }
  if (!isNum(spec.type) || typeof value !== 'number') return null;
  const { min, max } = rangeOf(spec, binding);
  if (max === min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/**
 * Whether a button's lamp should be lit for `value`.
 *
 * For a `set` or `momentary` binding this is "does the parameter already hold
 * the value this button writes", which is what makes a bank of source buttons
 * show which source is actually on the layer.
 */
export function toLamp(spec, value, binding = {}) {
  const action = binding.action ?? (spec.type === 'bool' ? 'toggle' : 'set');
  if (value === undefined || value === null) return null;
  if (action === 'trigger') return false;
  if (action === 'set' || action === 'momentary') return value === (binding.value ?? true);
  if (spec.type === 'bool') return !!value;
  const { min, max } = rangeOf(spec, binding);
  return value === max;
}

/* -------------------------------------------------------- soft takeover */

/*
 * A motorised fader always agrees with the parameter, because the parameter
 * moves it. A plain fader does not: after switching layers, a fader sitting at
 * 0 dB is pointing at a value the newly selected layer may not hold, and the
 * first touch would slam the parameter to wherever the fader happens to be.
 *
 * `pickup` suppresses writes until the control passes through the parameter's
 * current position, at which point it latches and tracks normally. This is the
 * standard behaviour of every mixing surface with non-motorised faders, and
 * without it a layer-select button is dangerous on a live output.
 */
export class Pickup {
  constructor(mode = 'pickup', tolerance = 0.02) {
    this.mode = mode;
    this.tolerance = tolerance;
    this.latched = mode === 'jump';
    this.last = null;
  }

  /** Forget the latch — call when the control is re-pointed at a new target. */
  reset(mode = this.mode) {
    this.mode = mode;
    this.latched = mode === 'jump';
    this.last = null;
  }

  /**
   * Should a control at `norm` be allowed to write, given the parameter is
   * currently at `at` (also 0..1, or null if unknown)?
   */
  allows(norm, at) {
    if (this.mode === 'jump' || this.latched || at === null) {
      this.latched = true;
      this.last = norm;
      return true;
    }
    if (Math.abs(norm - at) <= this.tolerance) {
      this.latched = true;
      this.last = norm;
      return true;
    }
    /* Latch on crossing, so a fast sweep past the value is not missed between
       two samples the way a pure proximity test would miss it. */
    if (this.last !== null && (this.last - at) * (norm - at) < 0) {
      this.latched = true;
      this.last = norm;
      return true;
    }
    this.last = norm;
    return false;
  }
}
