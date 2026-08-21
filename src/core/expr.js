/*
 * A very small arithmetic evaluator.
 *
 * This exists so an operator can type `1080-80` into a layer's width field and
 * get 1000, the way they can in every other tool on the desk. That is the
 * whole feature.
 *
 * **No `eval`, no `new Function`, no regex-driven shortcuts.** The strings this
 * parses come from a field that writes to a live switcher, so the evaluator is
 * a hand-written recursive-descent parser over a closed token set. It cannot
 * reach anything outside itself, cannot be made to run, and returns a failure
 * rather than a guess for anything it does not fully understand. A tool that
 * silently mis-parses a width is worse than one that has no expressions at all.
 *
 * Grammar, in full:
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := ('+' | '-') factor | primary
 *   primary := number | '(' expr ')'
 *
 * Deliberately absent:
 *
 *   %   ambiguous. In a layout tool it reads as "percent" at least as often as
 *       "modulo", and guessing wrong changes a number on air.
 *   ^   not worth the surface area; nobody sizes a layer with an exponent.
 *   e   scientific notation would make `1e3` valid and `1e` a parse error in a
 *       field where a bare `e` is just a typo. Plain decimals only.
 */

/** Anything longer than this is not someone doing arithmetic in a size field. */
const MAX_LENGTH = 120;
/** Depth guard. The grammar recurses on parentheses; this bounds the stack. */
const MAX_DEPTH = 24;

const isDigit = (c) => c >= '0' && c <= '9';

/**
 * Is this string already a plain number?
 *
 * Callers use this to leave ordinary input completely alone. It matters most
 * for negatives: `-960` is a perfectly good X position and must not be treated
 * as an expression, evaluated, and written back — even though evaluating it
 * would give the same answer, anything that rewrites a field it did not need to
 * is a chance to be wrong.
 */
export function isPlainNumber(text) {
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(String(text).trim());
}

/**
 * Does this look like arithmetic at all?
 *
 * A cheap gate before parsing, and the thing that keeps us away from every
 * other kind of field value. It requires the whole string to be made of digits,
 * the four operators, parentheses, dots and spaces — so `00:01.000`, `1920x1080`
 * and `Main LED` are all rejected before the parser ever sees them.
 */
export function looksLikeExpression(text) {
  const s = String(text).trim();
  if (!s || s.length > MAX_LENGTH) return false;
  if (!/^[0-9+\-*/(). ]+$/.test(s)) return false;
  if (isPlainNumber(s)) return false;
  return /[+\-*/]/.test(s) || s.includes('(');
}

/**
 * Evaluate an arithmetic string.
 *
 * @param {string} text
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function evaluate(text) {
  const src = String(text).trim();
  if (!src) return fail('empty');
  if (src.length > MAX_LENGTH) return fail('too long');
  if (!/^[0-9+\-*/(). ]+$/.test(src)) return fail('unexpected character');

  let i = 0;
  let depth = 0;

  const peek = () => {
    while (src[i] === ' ') i++;
    return src[i];
  };

  function parseExpr() {
    if (++depth > MAX_DEPTH) throw new SyntaxError('too deeply nested');
    let left = parseTerm();
    for (;;) {
      const op = peek();
      if (op !== '+' && op !== '-') break;
      i++;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    depth--;
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    for (;;) {
      const op = peek();
      if (op !== '*' && op !== '/') break;
      i++;
      const right = parseFactor();
      if (op === '*') {
        left *= right;
      } else {
        /* Division by zero yields Infinity in JS, which would sail through to
           a clamp and land as a min or max value — a plausible-looking wrong
           answer, which is the failure mode this module exists to avoid. */
        if (right === 0) throw new SyntaxError('division by zero');
        left /= right;
      }
    }
    return left;
  }

  function parseFactor() {
    const c = peek();
    if (c === '-') { i++; return -parseFactor(); }
    if (c === '+') { i++; return parseFactor(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const c = peek();
    if (c === '(') {
      i++;
      const value = parseExpr();
      if (peek() !== ')') throw new SyntaxError('unclosed bracket');
      i++;
      return value;
    }
    if (c === undefined) throw new SyntaxError('unexpected end');
    if (!isDigit(c) && c !== '.') throw new SyntaxError(`unexpected "${c}"`);

    const start = i;
    while (isDigit(src[i])) i++;
    if (src[i] === '.') {
      i++;
      while (isDigit(src[i])) i++;
    }
    const raw = src.slice(start, i);
    if (raw === '.' || raw === '') throw new SyntaxError('malformed number');
    return Number(raw);
  }

  try {
    const value = parseExpr();
    if (peek() !== undefined) throw new SyntaxError('trailing input');
    if (!Number.isFinite(value)) return fail('not a finite number');
    return { ok: true, value };
  } catch (err) {
    return fail(err instanceof SyntaxError ? err.message : 'could not parse');
  }
}

/**
 * Fit a value to a field's declared range and precision.
 *
 * The vendor puts `min`, `max` and `step` on its own numeric inputs, so this
 * uses the device's own declared limits rather than any assumption of ours.
 * Rounding follows `step`'s decimal places: `step="1"` gives integers, which is
 * what every geometry field on a LivePremier uses.
 */
export function fitToField(value, { min = null, max = null, step = null } = {}) {
  let out = value;

  const decimals = (() => {
    if (step === null || step === '' || !Number.isFinite(Number(step))) return null;
    const s = String(step);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : s.length - dot - 1;
  })();

  if (decimals !== null) out = Number(out.toFixed(decimals));

  const lo = min === null || min === '' ? null : Number(min);
  const hi = max === null || max === '' ? null : Number(max);
  if (lo !== null && Number.isFinite(lo) && out < lo) out = lo;
  if (hi !== null && Number.isFinite(hi) && out > hi) out = hi;

  /* -0 formats as "-0", which looks like a bug in a position field. */
  if (Object.is(out, -0)) out = 0;
  return out;
}

function fail(error) {
  return { ok: false, error };
}
