/*
 * A very small arithmetic evaluator.
 *
 * This exists so an operator can type `1080-80` into a layer's width field and
 * get 1000, the way they can in every other tool on the desk — and, since the
 * Variables plugin, `$S1.width/2` or `@gap*3`. That is the whole feature.
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
 *   expr     := term (('+' | '-') term)*
 *   term     := factor (('*' | '/') factor)*
 *   factor   := ('+' | '-') factor | primary
 *   primary  := number | variable | '(' expr ')'
 *   variable := ('$' | '@') name ('.' segment)*
 *
 * Deliberately absent:
 *
 *   %   ambiguous. In a layout tool it reads as "percent" at least as often as
 *       "modulo", and guessing wrong changes a number on air.
 *   ^   not worth the surface area; nobody sizes a layer with an exponent.
 *   e   scientific notation would make `1e3` valid and `1e` a parse error in a
 *       field where a bare `e` is just a typo. Plain decimals only.
 *
 * ## Variables, and why this module still knows none
 *
 * `$name` is a **system** variable — read off the switcher's store — and
 * `@name` a **user** one, defined by the operator. The module stays pure: the
 * caller injects `resolve(name, kind)`, the name without its sigil and as
 * typed, `kind` `'system'` or `'user'`, answering `{ ok: true, value }`,
 * `{ ok: false, error }` for a name it knows and cannot answer now (a role
 * mid-take), or `undefined` for one it has never heard of. That is the shape
 * mynah's `vars` takes too, so one resolver — the Variables plugin's — serves
 * the Console and the fields, and `docs/VARIABLES.md` lists the names.
 *
 * A variable is a failure, naming it, when there is no resolver, when it is
 * unknown, when the resolver refuses it, and when its value is text (a label
 * is something to read, not to add). Never zero, never NaN, never a guess.
 *
 * mynah's `evaluateExpression` (vendored, `src/vendor/mynah-lang.mjs`) is an
 * independent implementation of the same grammar and the same refusals;
 * `test/expr.test.js` checks the two agree, because two derivations agreeing
 * is the evidence either is right.
 */

/**
 * Anything longer than this is not someone doing arithmetic in a size field.
 * 160, up from 120 when variables arrived: `($S1.PGM.L2.x + $S1.PGM.L2.w / 2)`
 * is an honest expression and already a third of the old budget.
 */
const MAX_LENGTH = 160;
/** Depth guard. The grammar recurses on parentheses; this bounds the stack. */
const MAX_DEPTH = 24;

const isDigit = (c) => c >= '0' && c <= '9';
const NAME_FIRST = /[A-Za-z_]/;
const NAME_REST = /[A-Za-z0-9_]/;
const OPERATORS = new Set(['+', '-', '*', '/', '(', ')']);

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
 * The end of a variable's name, starting just after its sigil — the same rule
 * mynah's lexer applies: a letter or underscore, then letters, digits and
 * underscores, in dot-separated segments (`S1.PGM.L2.x`). A dot belongs to the
 * name only when a name character follows it. Returns `start` for no name.
 */
function nameEnd(src, start) {
  if (start >= src.length || !NAME_FIRST.test(src[start])) return start;
  let i = start + 1;
  for (;;) {
    while (i < src.length && NAME_REST.test(src[i])) i++;
    if (src[i] === '.' && i + 1 < src.length && NAME_REST.test(src[i + 1])) { i++; continue; }
    return i;
  }
}

/**
 * The string as tokens, or null when any character is outside the closed set.
 *
 * `{ type: 'num', value }`, `{ type: 'var', sigil, name, text }` and
 * `{ type: 'op', value }`. Spaces separate and are dropped.
 */
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ') { i++; continue; }
    if (OPERATORS.has(c)) { out.push({ type: 'op', value: c }); i++; continue; }
    if (c === '$' || c === '@') {
      const end = nameEnd(src, i + 1);
      if (end === i + 1) return null;
      out.push({ type: 'var', sigil: c, name: src.slice(i + 1, end), text: src.slice(i, end) });
      i = end;
      continue;
    }
    if (isDigit(c) || c === '.') {
      const start = i;
      while (isDigit(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (isDigit(src[i])) i++;
      }
      const raw = src.slice(start, i);
      if (raw === '.') return null;
      out.push({ type: 'num', value: Number(raw) });
      continue;
    }
    return null;
  }
  return out;
}

/**
 * The variables a string names, in order, without evaluating anything — for
 * a panel that shows what a line will read before it is run.
 *
 * @returns {Array<{sigil: '$'|'@', name: string, text: string}>}
 */
export function variablesIn(text) {
  const src = String(text ?? '');
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '$' && c !== '@') continue;
    const end = nameEnd(src, i + 1);
    if (end === i + 1) continue;
    out.push({ sigil: c, name: src.slice(i + 1, end), text: src.slice(i, end) });
    i = end - 1;
  }
  return out;
}

/**
 * Does this look like arithmetic at all?
 *
 * A cheap gate before parsing, and the thing that keeps us away from every
 * other kind of field value. It requires the whole string to be made of the
 * closed token set — digits, the four operators, parentheses, dots, spaces and
 * `$`/`@` names — so `00:01.000`, `1920x1080` and `Main LED` are all rejected
 * before the parser ever sees them. A bare `$S1.width` counts: there is
 * something to substitute.
 */
export function looksLikeExpression(text) {
  const s = String(text).trim();
  if (!s || s.length > MAX_LENGTH) return false;
  if (isPlainNumber(s)) return false;
  const tokens = tokenize(s);
  if (!tokens) return false;
  return tokens.some((t) => t.type !== 'num');
}

/**
 * Evaluate an arithmetic string.
 *
 * @param {string} text
 * @param {{resolve?: (name: string, kind: 'system'|'user') =>
 *   ({ok: true, value: number|string} | {ok: false, error: string} | undefined)}} [opts]
 * @returns {{ok: true, value: number} | {ok: false, error: string}}
 */
export function evaluate(text, { resolve = null } = {}) {
  const src = String(text).trim();
  if (!src) return fail('empty');
  if (src.length > MAX_LENGTH) return fail('too long');
  const tokens = tokenize(src);
  if (!tokens) return fail('unexpected character');

  let i = 0;
  let depth = 0;

  const peek = () => tokens[i];
  const isOp = (t, ...ops) => t !== undefined && t.type === 'op' && ops.includes(t.value);

  function parseExpr() {
    if (++depth > MAX_DEPTH) throw new SyntaxError('too deeply nested');
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (!isOp(t, '+', '-')) break;
      i++;
      const right = parseTerm();
      left = t.value === '+' ? left + right : left - right;
    }
    depth--;
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    for (;;) {
      const t = peek();
      if (!isOp(t, '*', '/')) break;
      i++;
      const right = parseFactor();
      if (t.value === '*') {
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
    const t = peek();
    if (isOp(t, '-')) { i++; return -parseFactor(); }
    if (isOp(t, '+')) { i++; return parseFactor(); }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t === undefined) throw new SyntaxError('unexpected end');
    if (isOp(t, '(')) {
      i++;
      const value = parseExpr();
      if (!isOp(peek(), ')')) throw new SyntaxError('unclosed bracket');
      i++;
      return value;
    }
    if (t.type === 'num') { i++; return t.value; }
    if (t.type === 'var') { i++; return variable(t); }
    throw new SyntaxError(`unexpected "${t.value}"`);
  }

  /* A variable's value, or a sentence naming it. Never a zero standing in for
     a name nobody knows, and never text quietly turned into NaN. */
  function variable(t) {
    if (typeof resolve !== 'function') throw new SyntaxError(`${t.text}: variables are not available here`);
    let answer;
    try {
      answer = resolve(t.name, t.sigil === '$' ? 'system' : 'user');
    } catch (err) {
      throw new SyntaxError(`${t.text}: ${err && err.message ? err.message : 'could not be read'}`);
    }
    if (answer === undefined || answer === null) throw new SyntaxError(`unknown variable ${t.text}`);
    if (!answer.ok) throw new SyntaxError(`${t.text}: ${answer.error}`);
    if (typeof answer.value === 'string') throw new SyntaxError(`${t.text} is text ("${answer.value}"), not a number`);
    if (typeof answer.value !== 'number' || !Number.isFinite(answer.value)) {
      throw new SyntaxError(`${t.text} is not a finite number`);
    }
    return answer.value;
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
