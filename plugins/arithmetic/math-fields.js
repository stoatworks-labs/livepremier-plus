/*
 * Arithmetic in the vendor's own numeric fields.
 *
 * Type `1080-80` into a layer's width and get 1000, the way you can in every
 * other tool on the desk. Nothing else about the field changes: the vendor
 * still validates it, still clamps it, still decides what to send and whether
 * the aspect lock drags the other axis along. All this does is substitute the
 * number the operator meant, an instant before the vendor reads it.
 *
 * ## Which fields, and how they are recognised
 *
 * Web RCS's numeric fields are `input[type=text]` carrying `min`, `max` and
 * `step` — its geometry fields report `step="1"` with real ranges (X spans
 * -960..2880, width 0..8192). That combination is the whole selector, and it
 * is a good one for two reasons: it is the vendor's own declaration that a
 * field is numeric and bounded, so we never have to recognise a field by a
 * class name that changes every firmware; and it excludes everything we must
 * not touch. Label fields have no `step`. Nor does the transition-time field,
 * whose `00:01.000` would be mangled by anything that treated `:` as maths.
 *
 * ## Number inputs, and Web RCS 6.1.x
 *
 * A number input **discards** anything it cannot parse: after typing
 * `1080-80` the browser reports `value === ""` with `validity.badInput`, and
 * `selectionStart` is null. The expression is on screen and unreadable from
 * script — verified, not assumed. So nothing can be done with one after the
 * fact; the field has to be a text field *while it is typed into*.
 *
 * That used to be a reason to leave number inputs alone: swapping `type` on
 * focus looked like it meant reimplementing the native up/down stepping. Two
 * things changed the trade. An Aquilon RS4 on firmware 6.1.60 (2026-10-16)
 * draws its layer geometry fields as `input[type=number]` with `step`, `min`
 * and `max` — so on 6.1.x, leaving number inputs alone left this plugin
 * doing nothing at all. And the 6.2.73 bundle shows what those fields are:
 * aw-ui's `AwNumberInput`, which renders `type: arithmeticModeEnabled ? 'text'
 * : 'number'` — the vendor swaps this very component to text for an
 * arithmetic mode of its own (on in its slider input from 6.2, evidently not
 * in 6.1.60) — and which steps in script: ArrowUp/Down with preventDefault,
 * the wheel while focused, its own spinner. Native stepping is never used, so
 * a text field loses none of it.
 *
 * Hence the narrow version. A bounded number input — `step`, `min` and `max`,
 * what `AwNumberInput` renders for a bounded value; never one of our own
 * `wru-input`s, whose once-a-second repaint would eat a half-typed expression
 * — is made `type=text` on focus and put back to `number` on blur, and while
 * it is text these rules hold:
 *
 * - **The vendor never sees a string its own number input could not have
 *   held.** On Enter, a field that holds neither a number nor an expression
 *   that evaluates keeps its text and the Enter goes no further (the vendor's
 *   Enter is a blur, which is a commit); it flashes amber with the reason. On
 *   blur — which cannot be held — the field is emptied first, which is what a
 *   number input reports for anything unparseable, so the vendor takes the
 *   path it takes when an operator leaves a stray `-` in the field today. In
 *   6.2.73's `AwNumberInput` that path parses `""` as NaN and puts the old
 *   value back, committing nothing.
 * - **Everything typed reaches React as typed.** The component keeps the
 *   string in its state (its `handleInputChange` stores `data.value` whole),
 *   so a re-render does not overwrite the expression. Holding input events
 *   back instead would leave its state stale, and React's controlled-input
 *   update would then write the stale number over the operator's typing.
 * - **The whole value is selected on the swap**, because making a field
 *   text-selectable moves its caret to the start, and Tab into a number field
 *   selects it all. A click still puts the caret where it lands.
 *
 * ⚠️ 6.1.60's own component has not been read — only its markup on the RS4 —
 * and no expression has been typed into that box. If its arrows stopped
 * stepping, it steps natively after all; on 6.1.x the number fields are all
 * this plugin touches, so its switch is the way out.
 *
 * ## Getting in front of React
 *
 * The vendor commits on blur and on Enter. React attaches its handlers at the
 * root container, so a **capture-phase** listener on `document` runs first —
 * that is the entire timing strategy, and it is why the listeners are where
 * they are. We rewrite the value, let the event carry on, and the vendor's own
 * handler reads the number as though it had been typed. The swap of a number
 * field is on `focusin` for the same reason: the field is text before the
 * vendor's focus handler selects it.
 *
 * Writing it takes the standard controlled-input dance: React overrides the
 * `value` property on the element, so setting it directly is invisible to
 * React's state. The native setter off the prototype, followed by an `input`
 * event, is what makes React's `onChange` fire and its state agree with the DOM.
 *
 * ## Variables
 *
 * With the Variables plugin on, `$S1.width/2` and `@gap*3` are expressions
 * too: `installMathFields` is handed a getter for the `variables` service and
 * asks it per commit — never once at start, because the plugin may be switched
 * off, or start after this one. Its `resolver()` goes to `core/expr.js`, which
 * knows no names itself. Nothing else about the field changes: the vendor
 * still validates, clamps and commits.
 *
 * Switched off, there is no resolver, a variable cannot evaluate, and the
 * field is left exactly as typed — which is what happened before variables
 * existed, when `$` was simply not arithmetic. A variable that *is* known and
 * cannot be read right now — `$S1.PGM.L2.x` mid-take — is refused the same
 * way, with an amber flash and the reason in the field's tooltip for a few
 * seconds, so the operator sees why their number did not land.
 */

import { evaluate, fitToField, isPlainNumber, looksLikeExpression } from '../../src/core/expr.js';
import { isEnter } from '../../src/ui/dom.js';

/* Re-exported: it is part of this module's contract even though it is shared. */
export { isEnter };

const FLASH_MS = 900;
/** How long a refusal's reason stays in the field's tooltip. */
const REASON_MS = 6000;

const CSS = `
@keyframes wru-math-flash {
  from { background-color: rgba(33, 133, 208, 0.45); }
  to   { background-color: transparent; }
}
@keyframes wru-math-refuse {
  from { background-color: rgba(243, 153, 16, 0.45); }
  to   { background-color: transparent; }
}
.wru-math-applied { animation: wru-math-flash ${FLASH_MS}ms ease-out; }
.wru-math-refused { animation: wru-math-refuse ${FLASH_MS}ms ease-out; }
`;

/**
 * React replaces `value` with its own property descriptor, so this reaches past
 * it to the real one.
 *
 * Looked up lazily rather than at import time: every module here has to import
 * cleanly under plain Node, which is what `test/modules.test.js` checks, and a
 * top-level `window` would break that. Memoised on first use.
 */
let nativeValueSetter;
function valueSetter() {
  if (nativeValueSetter === undefined) {
    nativeValueSetter =
      typeof HTMLInputElement === 'undefined'
        ? null
        : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ?? null;
  }
  return nativeValueSetter;
}

/**
 * Is this one of the vendor's numeric fields?
 *
 * `step` is the marker. Web RCS puts it on the inputs it treats as numbers and
 * nowhere else, which makes it a far steadier signal than any class name in a
 * CSS-modules build.
 */
export function isNumericField(el) {
  return !!(
    el &&
    el.tagName === 'INPUT' &&
    el.type === 'text' &&
    el.hasAttribute('step') &&
    !el.disabled &&
    !el.readOnly
  );
}

/**
 * Is this a vendor number input that is made text while it is typed into?
 *
 * The Web RCS 6.1.x shape: `type=number` with `step`, `min` and `max`, which
 * is what `AwNumberInput` renders for a bounded value. Unbounded ones (the
 * canvas zoom box, snap-to-grid sizes) are left alone, and so are our own
 * panels' number inputs — every one of them is a `wru-input`, and a panel's
 * repaint would replace the field under a half-typed expression.
 */
export function isNumberField(el) {
  return !!(
    el &&
    el.tagName === 'INPUT' &&
    el.type === 'number' &&
    el.hasAttribute('step') &&
    el.hasAttribute('min') &&
    el.hasAttribute('max') &&
    !el.disabled &&
    !el.readOnly &&
    !el.classList?.contains('wru-input')
  );
}

/**
 * Could a number input hold this text? The HTML "valid floating-point
 * number", which is what the browser keeps when a field becomes `number` —
 * anything else it sanitises to `""`. Empty counts: it is what a number
 * input reports when it is cleared, or holds something it cannot parse.
 */
export function isNumberText(text) {
  return text === '' || /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(text);
}

/**
 * Work out what a field should become, without touching anything.
 *
 * Split out from the DOM so the decision is testable on its own — this is the
 * part that must never be wrong, and it is pure.
 *
 * `resolve` is the Variables plugin's resolver, or null when it is off — in
 * which case a variable is simply not something this can evaluate.
 *
 * @returns {{apply: false, reason: string} | {apply: true, value: number, text: string}}
 */
export function resolveField(raw, { min = null, max = null, step = null } = {}, resolve = null) {
  if (!looksLikeExpression(raw)) return { apply: false, reason: 'not an expression' };

  const result = evaluate(raw, { resolve });
  if (!result.ok) return { apply: false, reason: result.error };

  const value = fitToField(result.value, { min, max, step });
  const text = String(value);

  /* If it already reads as what we would write, leave the field alone. Nothing
     to gain, and every avoidable write is an avoidable way to be wrong. */
  if (text === String(raw).trim()) return { apply: false, reason: 'unchanged' };

  return { apply: true, value, text };
}

/**
 * Substitute the evaluated value into a field, the way React expects.
 *
 * Returns false rather than throwing if anything is missing: this runs inside
 * the vendor's own event path, and a throw here would break their handler.
 */
function writeValue(el, text) {
  const setter = valueSetter();
  if (!setter) return false;
  try {
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {
    return false;
  }
}

function flash(el) {
  try {
    el.classList.remove('wru-math-applied');
    /* Reading offsetWidth restarts the animation if the same field is used
       twice in quick succession. */
    void el.offsetWidth;
    el.classList.add('wru-math-applied');
    setTimeout(() => el.classList.remove('wru-math-applied'), FLASH_MS + 100);
  } catch { /* cosmetic only */ }
}

/**
 * Say, briefly and in the field, why an expression was not applied — only
 * when a resolver was there to ask, so a field with the plugin off behaves
 * exactly as it did before variables. The field's own tooltip comes back.
 */
function refuse(el, reason) {
  try {
    el.classList.remove('wru-math-refused');
    void el.offsetWidth;
    el.classList.add('wru-math-refused');
    const had = el.getAttribute('title');
    el.setAttribute('title', `Not applied: ${reason}`);
    setTimeout(() => {
      el.classList.remove('wru-math-refused');
      if (el.getAttribute('title') !== `Not applied: ${reason}`) return;
      if (had === null) el.removeAttribute('title'); else el.setAttribute('title', had);
    }, REASON_MS);
  } catch { /* cosmetic only */ }
  console.warn('[LivePremier Plus] maths: not applied —', reason);
}

/**
 * Evaluate a field in place, if it holds an expression.
 *
 * `resolver` is asked only once the field turns out to hold one, so the
 * focusout of every other control on the page costs nothing.
 *
 * `explain` shows a refusal even with no resolver — for a field this made
 * text, where a refusal changes what the vendor is handed.
 *
 * @param {{resolver?: () => (Function|null), explain?: boolean}} [opts]
 * @returns {boolean} whether anything was substituted
 */
export function applyTo(el, { resolver = () => null, explain = false } = {}) {
  if (!isNumericField(el)) return false;
  if (!looksLikeExpression(el.value)) return false;

  const resolve = resolver();
  const decision = resolveField(el.value, {
    min: el.getAttribute('min'),
    max: el.getAttribute('max'),
    step: el.getAttribute('step')
  }, resolve);
  if (!decision.apply) {
    if ((resolve || explain) && decision.reason !== 'unchanged') refuse(el, decision.reason);
    return false;
  }

  if (!writeValue(el, decision.text)) return false;
  flash(el);
  return true;
}

/**
 * Commit a field this made text: evaluate it, and say whether it now holds
 * something its own number input could have held.
 *
 * A plain number in a spelling a number input would not keep — `+960`,
 * `1000.`, ` 12` — is rewritten in the one it would, and left to the vendor
 * to clamp exactly as it clamps a typed number.
 *
 * @returns {boolean} true when the field holds a number, or nothing
 */
export function settleText(el, { resolver = () => null } = {}) {
  applyTo(el, { resolver, explain: true });
  const text = el.value;
  if (isNumberText(text)) return true;
  if (isPlainNumber(text)) return writeValue(el, String(Number(text.trim())));
  if (!looksLikeExpression(text)) refuse(el, 'not a number');
  return false;
}

/**
 * Put a field this made text back to `number`, emptied first if it holds
 * anything a number input could not — so the vendor's blur reads `""`, the
 * value its own field reports for that, and never a string it was not built
 * to parse.
 */
function backToNumber(el) {
  if (!isNumberText(el.value)) writeValue(el, '');
  el.type = 'number';
}

/**
 * Start watching for commits.
 *
 * Every listener is capture-phase and on `document`, which is what puts them
 * in front of React's own handlers. Everything is wrapped: a fault in here
 * must degrade to "expressions do not work", never to a Web RCS whose fields
 * have stopped committing.
 *
 * @param {Document} [doc]
 * @param {{variables?: () => ({resolver: () => Function}|null)}} [opts]
 *        the `variables` service, asked per commit
 * @returns {() => void} an uninstall function
 */
export function installMathFields(doc = document, { variables = () => null } = {}) {
  if (doc.__wruMathFields) return doc.__wruMathFields;

  const resolver = () => {
    try {
      const service = variables();
      return service ? service.resolver() : null;
    } catch {
      return null;
    }
  };

  if (!doc.getElementById('wru-math-styles')) {
    const style = doc.createElement('style');
    style.id = 'wru-math-styles';
    style.textContent = CSS;
    doc.head.append(style);
  }

  /* The number field currently shown as text, if any. Only the focused field
     is ever swapped, so one is enough. */
  let held = null;

  const release = () => {
    const el = held;
    held = null;
    if (el) backToNumber(el);
  };

  const onFocusIn = (ev) => {
    try {
      /* A field removed while focused never sends a focusout. */
      if (held && held !== ev.target) release();
      const el = ev.target;
      if (held === el || !isNumberField(el)) return;
      el.type = 'text';
      held = el;
      try { el.select(); } catch { /* cosmetic only */ }
    } catch (err) { console.warn('[LivePremier Plus] maths', err); }
  };

  const onKeyDown = (ev) => {
    /* Enter is a commit. Tab is not handled here — it produces a focusout,
       which the other listener catches.
       Enter is recognised three ways because `key` is not always populated:
       some synthetic and remote-input paths leave it empty while still
       carrying `code` or the legacy `keyCode`. Missing a commit would silently
       send the vendor an unparseable string. */
    if (!isEnter(ev)) return;
    try {
      if (ev.target !== held) { applyTo(ev.target, { resolver }); return; }
      /* A field made text commits only a number: anything else keeps its
         text for the operator to fix, and the vendor never hears the Enter. */
      if (!settleText(held, { resolver })) {
        ev.preventDefault();
        ev.stopPropagation();
      }
    } catch (err) { console.warn('[LivePremier Plus] maths', err); }
  };

  const onFocusOut = (ev) => {
    if (ev.target !== held) {
      try { applyTo(ev.target, { resolver }); } catch (err) { console.warn('[LivePremier Plus] maths', err); }
      return;
    }
    /* A blur cannot be held, so whatever happens the field goes back. */
    try { settleText(held, { resolver }); } catch (err) { console.warn('[LivePremier Plus] maths', err); }
    try { release(); } catch (err) { console.warn('[LivePremier Plus] maths', err); }
  };

  doc.addEventListener('focusin', onFocusIn, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusout', onFocusOut, true);

  const uninstall = () => {
    doc.removeEventListener('focusin', onFocusIn, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    try { release(); } catch { /* the field is gone */ }
    delete doc.__wruMathFields;
  };
  doc.__wruMathFields = uninstall;
  return uninstall;
}
