/*
 * Keeping the operator's place across a repaint, against a stand-in DOM.
 *
 * Same approach as the shell and tab tests: what needs pinning is the policy —
 * which field counts as "the same field" in the next repaint, that typed text
 * beats the redrawn value, that the wrong field is never focused, and that an
 * open dropdown holds the repaint — and none of that needs a layout engine.
 * The browser half was measured on the simulator, 2026-09-23: with this in,
 * every panel kept a focused field through six to forty repaints where every
 * one of them used to drop it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureFocus, restoreFocus, repaint, trackFields } from '../src/ui/keep-focus.js';

/** Just enough of a document: a tree of fields, focus, selection, events. */
function stubDoc() {
  const listeners = {};
  const doc = {
    activeElement: null,
    body: null,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type, target, extra = {}) { for (const fn of listeners[type] || []) fn({ type, target, ...extra }); }
  };
  class El {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase();
      this.attrs = { ...attrs };
      this.children = [];
      this.parent = null;
      this.ownerDocument = doc;
      this.className = attrs.class || '';
      this.type = attrs.type || (this.tagName === 'INPUT' ? 'text' : '');
      this.defaultValue = attrs.value ?? '';
      this.value = this.defaultValue;
      this.selectionStart = null;
      this.selectionEnd = null;
      this.selectionDirection = 'none';
      this.focusCalls = 0;
    }
    getAttribute(n) { return n === 'class' ? this.className : (this.attrs[n] ?? null); }
    append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
    set textContent(v) { for (const c of this.children) c.parent = null; this.children = []; }
    get isConnected() { let n = this; while (n.parent) n = n.parent; return n === doc.body; }
    contains(el) { for (let n = el; n; n = n.parent) if (n === this) return true; return false; }
    matches(sel) { return sel.split(',').map((s) => s.trim().toUpperCase()).includes(this.tagName); }
    closest(sel) { for (let n = this; n; n = n.parent) if (n.matches && n.matches(sel)) return n; return null; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    focus() { this.focusCalls++; doc.activeElement = this; }
    setSelectionRange(a, b, d) { this.selectionStart = a; this.selectionEnd = b; this.selectionDirection = d; }
  }
  doc.body = new El('body');
  return { doc, El };
}

/** A panel: a label field, a port field and a dropdown, drawn fresh each time. */
function drawPanel(El, { host = '', port = '8000', extraFirst = false } = {}) {
  const panel = new El('div');
  if (extraFirst) panel.append(new El('input', { placeholder: 'Machine room', class: 'wru-input' }));
  panel.append(
    new El('input', { placeholder: 'Machine room', class: 'wru-input', value: host }),
    new El('input', { placeholder: '9990', class: 'wru-input wru-input--narrow', value: port }),
    new El('select', { class: 'wru-input' })
  );
  return panel;
}

test('nothing of ours focused is nothing to keep', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  assert.equal(captureFocus(root), null);
  const outside = new El('input');
  doc.body.append(outside);
  outside.focus();
  assert.equal(captureFocus(root), null, 'a field outside the panel is not ours to move');
});

test('a redrawn field gets back the caret, the selection and what was typed', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  const field = root.querySelectorAll('input')[1];
  field.focus();
  field.value = '99901';                 /* typed; the panel keeps no draft */
  field.setSelectionRange(2, 4, 'forward');

  const place = captureFocus(root);
  root.textContent = '';
  root.append(drawPanel(El));            /* redrawn from state: 8000 again */
  restoreFocus(root, place);

  const now = doc.activeElement;
  assert.equal(now, root.querySelectorAll('input')[1], 'the port field, not the name field');
  assert.notEqual(now, field, 'a new element — the old one is gone');
  assert.equal(now.value, '99901', 'typed text beats the redrawn value');
  assert.deepEqual([now.selectionStart, now.selectionEnd, now.selectionDirection], [2, 4, 'forward']);
});

test('typed text is kept until it is committed, across every repaint in between', () => {
  const { doc, El } = stubDoc();
  trackFields(doc);
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  const field = root.querySelectorAll('input')[0];
  field.focus();
  field.value = 'Rack';
  doc.dispatch('input', field);

  for (let i = 0; i < 3; i++) {
    const place = captureFocus(root);
    root.textContent = '';
    root.append(drawPanel(El));             /* the panel keeps no draft */
    restoreFocus(root, place);
    assert.equal(doc.activeElement.value, 'Rack', `still typed after repaint ${i + 1}`);
  }
});

test('Enter commits: the panel’s own value wins, and the caret stays', () => {
  /* The Console clears its line when it runs it. Before this rule the line
     came straight back, because it was still "typed" in a focused field. */
  const { doc, El } = stubDoc();
  trackFields(doc);
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El, { host: '' }));
  const field = root.querySelectorAll('input')[0];
  field.focus();
  field.value = '/hello/ping';
  doc.dispatch('input', field);
  doc.dispatch('keydown', field, { key: 'Enter' });

  const place = captureFocus(root);
  root.textContent = '';
  root.append(drawPanel(El, { host: '' }));   /* redrawn from a cleared line */
  restoreFocus(root, place);
  assert.equal(doc.activeElement.value, '', 'cleared, as the panel drew it');
  assert.equal(doc.activeElement.getAttribute('placeholder'), 'Machine room', 'and still the field with the caret');
});

test('a committed value the switcher changed shows as the switcher has it', () => {
  const { doc, El } = stubDoc();
  trackFields(doc);
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El, { port: '8000' }));
  const field = root.querySelectorAll('input')[1];
  field.focus();
  field.value = '99999';
  doc.dispatch('input', field);
  doc.dispatch('change', field);              /* committed; the device clamps it */

  const place = captureFocus(root);
  root.textContent = '';
  root.append(drawPanel(El, { port: '65535' }));
  restoreFocus(root, place);
  assert.equal(doc.activeElement.value, '65535', 'not the typed 99999');
});

test('an untouched field takes the redrawn value, and its caret', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El, { port: '8000' }));
  const field = root.querySelectorAll('input')[1];
  field.focus();
  field.setSelectionRange(1, 1);
  const place = captureFocus(root);
  root.textContent = '';
  root.append(drawPanel(El, { port: '9000' }));   /* the stored value changed underneath */
  restoreFocus(root, place);
  assert.equal(doc.activeElement.value, '9000', 'nothing typed, so nothing to protect');
  assert.equal(doc.activeElement.selectionStart, 1);
});

test('a key beats the shape, so a field in a list keeps its own row', () => {
  const { doc, El } = stubDoc();
  const row = (id) => new El('input', { class: 'wru-input', 'data-lpp-key': `cue-${id}-label` });
  const root = new El('div');
  doc.body.append(root);
  root.append(row('a'), row('b'), row('c'));
  root.querySelectorAll('input')[1].focus();
  const place = captureFocus(root);
  root.textContent = '';
  root.append(row('new'), row('a'), row('b'), row('c'));   /* a cue added above */
  restoreFocus(root, place);
  assert.equal(doc.activeElement.getAttribute('data-lpp-key'), 'cue-b-label');
});

test('the shape and position find the field when nothing above it moved', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  root.querySelectorAll('input')[0].focus();
  const place = captureFocus(root);
  root.textContent = '';
  root.append(drawPanel(El));
  restoreFocus(root, place);
  assert.equal(doc.activeElement.getAttribute('placeholder'), 'Machine room');
});

test('no counterpart means nothing focused — never the wrong field', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  root.querySelectorAll('input')[1].focus();
  const place = captureFocus(root);
  root.textContent = '';
  const bare = new El('div');
  bare.append(new El('input', { placeholder: 'something else entirely' }));
  root.append(bare);
  doc.activeElement = doc.body;
  restoreFocus(root, place);
  assert.equal(doc.activeElement, doc.body);
});

test('a field that survived the repaint is left exactly as it is', () => {
  const { doc, El } = stubDoc();
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  const field = root.querySelectorAll('input')[0];
  field.focus();
  const calls = field.focusCalls;
  restoreFocus(root, captureFocus(root));   /* a panel that redrew in place */
  assert.equal(field.focusCalls, calls, 'not re-focused, so its caret is untouched');
});

test('an open dropdown holds the repaint, and the choice lets it go', () => {
  const { doc, El } = stubDoc();
  trackFields(doc);
  const root = new El('div');
  doc.body.append(root);
  root.append(drawPanel(El));
  const select = root.querySelectorAll('select')[0];

  select.focus();
  assert.equal(captureFocus(root).hold, false, 'focused but not opened: redraw as usual');

  doc.dispatch('mousedown', select);
  assert.equal(captureFocus(root).hold, true, 'opened: redrawing would close it under the pointer');

  let built = 0;
  assert.equal(repaint(root, () => { built++; return drawPanel(El); }), false);
  assert.equal(built, 0, 'nothing was even built');
  assert.equal(select.isConnected, true);

  doc.dispatch('change', select);
  assert.equal(captureFocus(root).hold, false);
  assert.equal(repaint(root, () => { built++; return drawPanel(El); }), true);
  assert.equal(built, 1);
  assert.equal(doc.activeElement.tagName, 'SELECT', 'and focus is back on the new dropdown');

  /* Escape closes it too, and so does leaving it. */
  const again = root.querySelectorAll('select')[0];
  doc.dispatch('mousedown', again);
  doc.dispatch('keydown', again, { key: 'Escape' });
  assert.equal(captureFocus(root).hold, false);
  doc.dispatch('mousedown', again);
  doc.dispatch('focusout', again);
  assert.equal(captureFocus(root).hold, false);
});

test('repaint swaps the contents and keeps the place in one step', () => {
  const { doc, El } = stubDoc();
  const host = new El('div');
  doc.body.append(host);
  host.append(drawPanel(El));
  host.querySelectorAll('input')[0].focus();
  host.querySelectorAll('input')[0].value = 'Rack';
  assert.equal(repaint(host, () => drawPanel(El)), true);
  assert.equal(doc.activeElement.value, 'Rack');
  assert.equal(host.children.length, 1);
});
