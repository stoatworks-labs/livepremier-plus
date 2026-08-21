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
 * ## Why not `input[type=number]`
 *
 * The opacity and zoom fields are real `type="number"` inputs, and they are
 * deliberately left alone. A number input **discards** anything it cannot
 * parse: after typing `1080-80` the browser reports `value === ""` with
 * `validity.badInput`, and `selectionStart` throws. The expression is visible
 * on screen and unreadable from script — verified, not assumed.
 *
 * Supporting them would mean swapping `type` to `text` on focus and back on
 * blur, which also means reimplementing the native up/down stepping those
 * fields have and that operators use. Mutating a vendor element's `type` on
 * every focus, in a UI driving a live show, to win arithmetic on an opacity
 * field is not a good trade. If it is ever wanted, that is the argument to
 * beat, and it belongs behind a switch.
 *
 * ## Getting in front of React
 *
 * The vendor commits on blur and on Enter. React attaches its handlers at the
 * root container, so a **capture-phase** listener on `document` runs first —
 * that is the entire timing strategy, and it is why the listeners are where
 * they are. We rewrite the value, let the event carry on, and the vendor's own
 * handler reads the number as though it had been typed.
 *
 * Writing it takes the standard controlled-input dance: React overrides the
 * `value` property on the element, so setting it directly is invisible to
 * React's state. The native setter off the prototype, followed by an `input`
 * event, is what makes React's `onChange` fire and its state agree with the DOM.
 */

import { evaluate, fitToField, looksLikeExpression } from '../core/expr.js';
import { isEnter } from './dom.js';

/* Re-exported: it is part of this module's contract even though it is shared. */
export { isEnter };

const FLASH_MS = 900;

const CSS = `
@keyframes wru-math-flash {
  from { background-color: rgba(33, 133, 208, 0.45); }
  to   { background-color: transparent; }
}
.wru-math-applied { animation: wru-math-flash ${FLASH_MS}ms ease-out; }
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
 * Work out what a field should become, without touching anything.
 *
 * Split out from the DOM so the decision is testable on its own — this is the
 * part that must never be wrong, and it is pure.
 *
 * @returns {{apply: false, reason: string} | {apply: true, value: number, text: string}}
 */
export function resolveField(raw, { min = null, max = null, step = null } = {}) {
  if (!looksLikeExpression(raw)) return { apply: false, reason: 'not an expression' };

  const result = evaluate(raw);
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
 * Evaluate a field in place, if it holds an expression.
 *
 * @returns {boolean} whether anything was substituted
 */
export function applyTo(el) {
  if (!isNumericField(el)) return false;

  const decision = resolveField(el.value, {
    min: el.getAttribute('min'),
    max: el.getAttribute('max'),
    step: el.getAttribute('step')
  });
  if (!decision.apply) return false;

  if (!writeValue(el, decision.text)) return false;
  flash(el);
  return true;
}

/**
 * Start watching for commits.
 *
 * Both listeners are capture-phase and on `document`, which is what puts them
 * in front of React's own handlers. Everything is wrapped: a fault in here
 * must degrade to "expressions do not work", never to a Web RCS whose fields
 * have stopped committing.
 *
 * @returns {() => void} an uninstall function
 */
export function installMathFields(doc = document) {
  if (doc.__wruMathFields) return doc.__wruMathFields;

  if (!doc.getElementById('wru-math-styles')) {
    const style = doc.createElement('style');
    style.id = 'wru-math-styles';
    style.textContent = CSS;
    doc.head.append(style);
  }

  const onKeyDown = (ev) => {
    /* Enter is a commit. Tab is not handled here — it produces a focusout,
       which the other listener catches.
       Enter is recognised three ways because `key` is not always populated:
       some synthetic and remote-input paths leave it empty while still
       carrying `code` or the legacy `keyCode`. Missing a commit would silently
       send the vendor an unparseable string. */
    if (!isEnter(ev)) return;
    try { applyTo(ev.target); } catch (err) { console.warn('[LivePremier Plus] maths', err); }
  };

  const onFocusOut = (ev) => {
    try { applyTo(ev.target); } catch (err) { console.warn('[LivePremier Plus] maths', err); }
  };

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('focusout', onFocusOut, true);

  const uninstall = () => {
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('focusout', onFocusOut, true);
    delete doc.__wruMathFields;
  };
  doc.__wruMathFields = uninstall;
  return uninstall;
}
