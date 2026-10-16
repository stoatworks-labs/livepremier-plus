/*
 * Field arithmetic in a Web RCS 6.1.x number field.
 *
 * An Aquilon RS4 on 6.1.60 (2026-10-16) draws its layer geometry fields as
 * `input[type=number]` with step 1 and real ranges — X -960..2880, Y
 * -540..1620, width and height 0..8192 — where 6.2.73 draws text fields. No
 * 6.1.x Web RCS is available to drive, and the box is a live show, so the
 * field is modelled here from two things that are known:
 *
 * - **The browser's half.** A number input reports `""` for anything it
 *   cannot parse, and sanitises its value to `""` when it becomes `number`
 *   holding something that is not a valid floating-point number.
 * - **The vendor's half,** read off aw-ui's `AwNumberInput` in the 6.2.73
 *   bundle — the component that renders `type: arithmeticModeEnabled ? 'text'
 *   : 'number'`, i.e. the RS4's fields with the vendor's own arithmetic off:
 *   it keeps the typed string in its state, Enter is a `blur()`, the blur
 *   parses the state with `tryParseNumber` (`+value`, with `""` as NaN),
 *   commits only a number that differs from the one it was given, and puts
 *   that one back otherwise. Arrows and the wheel step in script. React's
 *   controlled update for a `type: 'number'` prop writes the DOM whenever the
 *   DOM value is not loosely equal to the state.
 *
 * 6.1.60's own copy of that component has not been read; that is what is
 * modelled rather than proven, and `math-fields.js` says so.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/;

/* ---------------------------------------------------------------- the DOM */

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  contains(c) { return this.set.has(c); }
}

/* `HTMLInputElement` before the module asks for its native `value` setter. */
class FakeInput {
  constructor(doc, { type, attrs = {}, className = '' }) {
    this.ownerDocument = doc;
    this.tagName = 'INPUT';
    this._type = type;
    this._value = '';
    this.attrs = { ...attrs };
    this.disabled = false;
    this.readOnly = false;
    this.classList = new FakeClassList();
    for (const c of className.split(/\s+/).filter(Boolean)) this.classList.add(c);
    this.selection = 'none';
    this.isConnected = true;
  }
  get type() { return this._type; }
  set type(next) {
    /* The value sanitisation algorithm for the new state, and a field that
       becomes text-selectable gets its caret at the start. */
    this._type = next;
    if (next === 'number' && !FLOAT.test(this._value)) this._value = '';
    this.selection = 'start';
  }
  get value() { return this._value; }
  set value(v) {
    const s = String(v);
    this._value = this._type === 'number' && !FLOAT.test(s) ? '' : s;
  }
  hasAttribute(n) { return n in this.attrs; }
  getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  removeAttribute(n) { delete this.attrs[n]; }
  select() { this.selection = 'all'; }
  blur() { this.ownerDocument.blur(this); }
  dispatchEvent(ev) { return this.ownerDocument.dispatch(this, ev); }
}
globalThis.HTMLInputElement = FakeInput;

/*
 * A document with one capture listener list — where the plugin listens — and,
 * after it, "React's root": each mounted component's own handlers. An event
 * stopped at the document never reaches them, as in a browser.
 */
class FakeDoc {
  constructor() {
    this.capture = {};
    this.components = new Map();
    this.activeElement = null;
    this.head = { append() {} };
  }
  getElementById() { return null; }
  createElement() { return {}; }
  addEventListener(type, fn, capture) {
    assert.equal(capture, true, 'the plugin listens in the capture phase');
    (this.capture[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.capture[type] = (this.capture[type] || []).filter((f) => f !== fn);
  }
  listenerCount() { return Object.values(this.capture).reduce((n, l) => n + l.length, 0); }
  dispatch(target, init) {
    const ev = {
      type: init.type, key: init.key, code: init.code, keyCode: init.keyCode, target,
      defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { this.stopped = true; }
    };
    for (const fn of [...(this.capture[ev.type] || [])]) fn(ev);
    if (!ev.stopped) this.components.get(target)?.handle(ev);
    return !ev.defaultPrevented;
  }
  focus(el) {
    if (this.activeElement && this.activeElement !== el) this.blur(this.activeElement);
    this.activeElement = el;
    this.dispatch(el, { type: 'focusin' });
  }
  blur(el) {
    if (this.activeElement !== el) return;
    this.activeElement = null;
    this.dispatch(el, { type: 'focusout' });
  }
}

/* ------------------------------------------------------ the vendor's field */

/* aw-utils `convert_tryParseNumber`, as in the 6.2.73 bundle. */
function tryParseNumber(value) {
  const result = +value;
  if (result === 0 && parseFloat(value) !== 0) return NaN;
  return result;
}

/* aw-utils `roundTo` and `clampNumber`. */
const roundTo = (v, p = 1) => (v < 0 ? Math.ceil(v / p - 0.5) : Math.floor(v / p + 0.5)) / (1 / p);
const clamp = (v, min, max) => Math.max(Math.min(v, max), min);

/**
 * `AwNumberInput` with its arithmetic mode off — the RS4's geometry field.
 * `committed` is what it handed to its `onChange`, which is what reaches the
 * switcher; `parsedAtBlur` is every state string its blur had to parse.
 */
class VendorNumberInput {
  constructor(doc, { value, min, max, step = 1, type = 'number', className = '' }) {
    this.props = { value, min, max, step };
    this.state = { value };
    this.committed = [];
    this.parsedAtBlur = [];
    this.el = new FakeInput(doc, {
      type,
      className,
      attrs: { step: String(step), min: String(min), max: String(max) }
    });
    this.el.value = String(value);
    doc.components.set(this.el, this);
  }
  /* React's controlled update for a `type: 'number'` prop — `ReactDOMInput`
     `updateWrapper`, which compares loosely so `1.0` survives being 1. */
  render() {
    const c = this.state.value;
    if ((c === 0 && this.el.value === '') || this.el.value != c) this.el.value = String(c); // eslint-disable-line eqeqeq
  }
  setState(patch) { Object.assign(this.state, patch); this.render(); }
  resetValue() { this.setState({ value: this.props.value }); }
  checkValue(v) { return clamp(roundTo(v, this.props.step), this.props.min, this.props.max); }
  setInputValueState(value) {
    if (Number.isNaN(value) || value === this.props.value) { this.resetValue(); return; }
    this.committed.push(value);
    this.props.value = value; // the switcher's echo
    this.setState({ value });
  }
  handle(ev) {
    switch (ev.type) {
      case 'input': this.setState({ value: ev.target.value }); break; // handleInputChange: the string, whole
      case 'focusin': this.el.select(); break; // the slider input's handleInputFocus
      case 'focusout':
        this.parsedAtBlur.push(this.state.value);
        this.setInputValueState(this.checkValue(tryParseNumber(this.state.value)));
        break;
      case 'keydown':
        if (ev.key === 'Enter') this.el.blur();
        else if (ev.key === 'Escape') this.resetValue();
        else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
          ev.preventDefault();
          const step = ev.key === 'ArrowUp' ? this.props.step : -this.props.step;
          this.setInputValueState(this.checkValue(tryParseNumber(this.state.value) + step));
        }
        break;
    }
  }
}

/* ------------------------------------------------------------ the operator */

/** Type over the selection, a keystroke at a time, as the browser reports it. */
function typeInto(el, text) {
  if (text === '') { el.value = ''; el.dispatchEvent({ type: 'input' }); return; }
  for (let i = 1; i <= text.length; i++) {
    el.value = text.slice(0, i); // a number input reports "" for what it cannot parse
    el.dispatchEvent({ type: 'input' });
  }
}
const press = (el, key) => el.dispatchEvent({ type: 'keydown', key });

/* -------------------------------------------------------------- the setup */

const { installMathFields, isNumberField, isNumberText, isNumericField } =
  await import('../plugins/arithmetic/math-fields.js');

/* The flash and the refusal's tooltip clear themselves on timers; nothing
   here needs them to, and a six-second timer would hold the suite open. */
const realSetTimeout = globalThis.setTimeout;
const realWarn = console.warn;
test.before(() => {
  globalThis.setTimeout = () => 0;
  console.warn = () => {};
});
test.after(() => {
  globalThis.setTimeout = realSetTimeout;
  console.warn = realWarn;
});

/* The RS4's geometry fields, with the values a layer might hold. */
const X = { value: 0, min: -960, max: 2880 };
const WIDTH = { value: 1080, min: 0, max: 8192 };

function rig({ variables, ...field } = WIDTH) {
  const doc = new FakeDoc();
  const vendor = new VendorNumberInput(doc, field);
  const uninstall = installMathFields(doc, variables ? { variables } : {});
  return { doc, vendor, el: vendor.el, uninstall };
}

/* ---------------------------------------------------------------- tests */

test('the RS4 geometry fields are recognised, and nothing unbounded or of ours is', () => {
  const doc = new FakeDoc();
  const input = (type, attrs, className) => new FakeInput(doc, { type, attrs, className });

  for (const [min, max] of [['-960', '2880'], ['-540', '1620'], ['0', '8192']]) {
    assert.ok(isNumberField(input('number', { step: '1', min, max })), `${min}..${max}`);
  }

  assert.equal(isNumberField(input('number', { step: '1', max: '8192' })), false, 'no min');
  assert.equal(isNumberField(input('number', { step: '1', min: '0' })), false, 'no max');
  assert.equal(isNumberField(input('number', { step: '100' })), false,
    'the canvas zoom box carries a step and no bounds');
  assert.equal(isNumberField(input('number', { min: '0', max: '8192' })), false, 'no step');
  assert.equal(isNumberField(input('number', { step: '1', min: '0', max: '8192' }, 'wru-input')), false,
    'our own panels repaint under the caret — their number fields stay number fields');
  assert.equal(isNumberField(input('text', { step: '1', min: '0', max: '8192' })), false,
    'a 6.2.73 text field is already text');

  const disabled = input('number', { step: '1', min: '0', max: '8192' });
  disabled.disabled = true;
  assert.equal(isNumberField(disabled), false);
  const readOnly = input('number', { step: '1', min: '0', max: '8192' });
  readOnly.readOnly = true;
  assert.equal(isNumberField(readOnly), false);
  assert.equal(isNumberField({ ...input('number', { step: '1', min: '0', max: '8192' }), tagName: 'TEXTAREA' }), false);
  assert.equal(isNumberField(null), false);

  /* The text-field test is unchanged: a number input is still not one. */
  assert.equal(isNumericField(input('number', { step: '1', min: '0', max: '8192' })), false);
});

test('isNumberText is what a number input would keep', () => {
  for (const s of ['', '1000', '-960', '0', '0.5', '.5', '-.5', '1e3', '1E-3']) assert.ok(isNumberText(s), s);
  for (const s of ['1080-80', '1080-', '+960', '1000.', ' 12', '12 ', '12abc', 'NaN', 'Infinity', '-', '$S1.width']) {
    assert.equal(isNumberText(s), false, s);
  }
});

test('without the plugin, a 6.1.x number field swallows an expression and commits nothing', () => {
  /* Why the plugin was inert on the RS4, and why that was harmless. */
  const doc = new FakeDoc();
  const vendor = new VendorNumberInput(doc, WIDTH);
  doc.focus(vendor.el);
  typeInto(vendor.el, '1080-80');
  assert.equal(vendor.el.value, '', 'the browser reports nothing it can read');
  press(vendor.el, 'Enter');
  assert.deepEqual(vendor.committed, []);
  assert.equal(vendor.el.value, '1080');
});

test('1080-80 and Enter commits 1000 on a 6.1.x number field', () => {
  const { doc, vendor, el } = rig();

  doc.focus(el);
  assert.equal(el.type, 'text', 'text while it is typed into');
  assert.equal(el.selection, 'all', 'selected whole, as Tab into a number field would');

  typeInto(el, '1080-80');
  assert.equal(el.value, '1080-80');
  press(el, 'Enter');

  assert.deepEqual(vendor.committed, [1000]);
  assert.deepEqual(vendor.parsedAtBlur, ['1000'], 'the vendor parsed the answer, not the sum');
  assert.equal(el.type, 'number', 'back to number once it is left');
  assert.equal(el.value, '1000');
  assert.ok(el.classList.contains('wru-math-applied'));
});

test('leaving the field commits too, and the result is fitted to the field', () => {
  const tab = (field, typed) => {
    const { doc, vendor, el } = rig(field);
    doc.focus(el);
    typeInto(el, typed);
    doc.blur(el);
    assert.equal(el.type, 'number');
    return vendor.committed;
  };
  assert.deepEqual(tab(WIDTH, '(1920-40)/2'), [940]);
  assert.deepEqual(tab(WIDTH, '9000+1000'), [8192], 'clamped to the width field\'s max');
  assert.deepEqual(tab(X, '-960-100'), [-960], 'clamped to X\'s min');
  assert.deepEqual(tab(X, '2880/2'), [1440]);
});

test('a repaint while typing does not overwrite the expression', () => {
  /* The typed string reaches React whole, so its controlled update finds the
     DOM already agreeing. Held back instead, the state would still be 1080
     and the repaint would write it over the operator's typing. */
  const { doc, vendor, el } = rig();
  doc.focus(el);
  typeInto(el, '1080-8');
  vendor.render();
  assert.equal(el.value, '1080-8');
  typeInto(el, '1080-80');
  press(el, 'Enter');
  assert.deepEqual(vendor.committed, [1000]);
});

test('an expression that does not evaluate keeps its text on Enter, and the vendor never hears it', () => {
  const { doc, vendor, el } = rig();
  doc.focus(el);
  typeInto(el, '1080-');
  assert.equal(press(el, 'Enter'), false, 'the Enter goes no further');

  assert.deepEqual(vendor.committed, []);
  assert.equal(doc.activeElement, el, 'the vendor\'s Enter is a blur, and it did not happen');
  assert.equal(el.type, 'text');
  assert.equal(el.value, '1080-', 'left for the operator to finish');
  assert.ok(el.classList.contains('wru-math-refused'));
  assert.match(el.getAttribute('title'), /^Not applied: /);

  /* Finished, it goes. */
  typeInto(el, '1080-80');
  press(el, 'Enter');
  assert.deepEqual(vendor.committed, [1000]);
});

test('leaving a field that is not a number hands the vendor what its own field would — nothing', () => {
  for (const typed of ['1080-', '12abc', '1920/0', '$S1.width/2']) {
    const { doc, vendor, el } = rig();
    doc.focus(el);
    typeInto(el, typed);
    doc.blur(el);

    assert.deepEqual(vendor.committed, [], typed);
    assert.deepEqual(vendor.parsedAtBlur, [''], `${typed}: the vendor parsed "", never the text`);
    assert.equal(el.type, 'number', typed);
    assert.equal(el.value, '1080', `${typed}: the vendor put its value back`);
    assert.ok(el.classList.contains('wru-math-refused'), typed);
  }
});

test('a plain number is the vendor\'s to commit, in a spelling its field would keep', () => {
  const enter = (typed) => {
    const { doc, vendor, el } = rig();
    doc.focus(el);
    typeInto(el, typed);
    press(el, 'Enter');
    return { vendor, el };
  };

  const plain = enter('960');
  assert.deepEqual(plain.vendor.committed, [960]);
  assert.equal(plain.el.classList.contains('wru-math-applied'), false, 'nothing of ours to show');

  assert.deepEqual(enter('+960').vendor.committed, [960]);
  assert.deepEqual(enter('960.').vendor.committed, [960]);
  assert.deepEqual(enter('9000').vendor.committed, [8192], 'clamped by the vendor, as a typed number is');

  /* Clearing the field is what it always was: the vendor puts its value back. */
  const cleared = enter('');
  assert.deepEqual(cleared.vendor.committed, []);
  assert.equal(cleared.el.value, '1080');
});

test('Escape and the arrows stay the vendor\'s', () => {
  const { doc, vendor, el } = rig();
  doc.focus(el);
  typeInto(el, '1080-8');
  press(el, 'Escape');
  assert.equal(el.value, '1080', 'the vendor reset it');
  assert.equal(el.type, 'text', 'still being edited');

  /* Its stepping is script, and the field's type does not enter into it. */
  press(el, 'ArrowUp');
  assert.deepEqual(vendor.committed, [1081]);
  doc.blur(el);
  assert.equal(el.type, 'number');
  assert.deepEqual(vendor.committed, [1081]);
});

test('variables work in a 6.1.x number field while the Variables plugin is on', () => {
  const resolve = (name, kind) => (kind === 'system' && name === 'S1.width' ? { ok: true, value: 1920 } : undefined);
  const { doc, vendor, el } = rig({ ...WIDTH, variables: () => ({ resolver: () => resolve }) });
  doc.focus(el);
  typeInto(el, '$S1.width/2');
  press(el, 'Enter');
  assert.deepEqual(vendor.committed, [960]);
});

test('fields it must not touch keep their type', () => {
  const doc = new FakeDoc();
  const ours = new VendorNumberInput(doc, { ...WIDTH, className: 'wru-input' });
  const zoom = new VendorNumberInput(doc, WIDTH);
  delete zoom.el.attrs.min;
  delete zoom.el.attrs.max;
  installMathFields(doc);

  for (const { el } of [ours, zoom]) {
    doc.focus(el);
    assert.equal(el.type, 'number');
    doc.blur(el);
  }
});

test('a 6.2.73 text field takes the path it always took', () => {
  const doc = new FakeDoc();
  const vendor = new VendorNumberInput(doc, { ...WIDTH, type: 'text' });
  installMathFields(doc);
  doc.focus(vendor.el);
  assert.equal(vendor.el.type, 'text');
  typeInto(vendor.el, '1080-');
  press(vendor.el, 'Enter');
  /* Not held: a text field's refusal is the vendor's to make, as before. */
  assert.equal(doc.activeElement, null);
  assert.deepEqual(vendor.committed, []);
  assert.equal(vendor.el.type, 'text');
});

test('a field is never left text', () => {
  /* Removed while focused — no focusout — and then another field focused. */
  const doc = new FakeDoc();
  const gone = new VendorNumberInput(doc, WIDTH);
  const next = new VendorNumberInput(doc, X);
  installMathFields(doc);
  doc.focus(gone.el);
  typeInto(gone.el, '1080-');
  doc.activeElement = null; // React unmounted it
  doc.focus(next.el);
  assert.equal(gone.el.type, 'number');
  assert.equal(next.el.type, 'text');

  /* Switched off mid-edit. */
  const { doc: d2, el, uninstall } = rig();
  d2.focus(el);
  assert.equal(el.type, 'text');
  uninstall();
  assert.equal(el.type, 'number');
  assert.equal(d2.listenerCount(), 0);
});
