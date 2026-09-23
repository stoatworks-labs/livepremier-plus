/*
 * The vendor's own PGM/PRW padlocks, and the policy built on them.
 *
 * The stub reproduces the shape read off a running Web RCS on 2026-09-21
 * (LivePremier Simulator 6.2.73), screen by screen:
 *
 *   button "PGM" + use#locked-12      the master pair, over the Sources panel
 *   .aw-preset-view > h2 "S1"         one screen card
 *     [class*="screen-overview-container__c__preset___"]
 *       button "PGM"                  the buffer's own label button
 *       button + use#locked-12        its padlock, aria-pressed
 *
 * The hashes here are deliberately not the live ones — nothing may match on
 * them. What is real is the sprite ids and `aria-pressed`, because those are
 * what the reader actually keys on.
 *
 * What is being pinned is the **fallback ladder**, which is the part with
 * consequences: a screen's own card, then the master pair, then locked. The
 * last rung is the one worth a test of its own — a screen the operator has
 * not got on screen is a screen whose guard rail cannot be seen, and reading
 * that as "open" would make the one unverifiable case also the one that never
 * asks.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readCardLocks, readMasterLocks, lockedFor, ROLE_LABEL } from '../src/ui/preset-lock.js';

/* ------------------------------------------------------------- stub DOM */

function stubDom() {
  class El {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this._text = '';
      this._classes = new Set();
    }
    get classList() {
      const s = this._classes;
      return { add: (...c) => c.forEach((x) => s.add(x)), contains: (c) => s.has(c) };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    append(...kids) { for (const k of kids) { k.parentElement = this; this.children.push(k); } }
    _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
    querySelectorAll(sel) { return this._all().filter((e) => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  /* The four forms `preset-lock.js` uses, and no more. A stub that quietly
     matched something it was not asked about would hide a real selector bug. */
  function matches(el, sel) {
    if (/^[a-z0-9]+$/.test(sel)) return el.tagName === sel.toUpperCase();
    if (sel.startsWith('.')) return el._classes.has(sel.slice(1));
    const attr = /^\[class\*="(.+)"\]$/.exec(sel);
    if (attr) return el.className.includes(attr[1]);
    throw new Error('stub does not implement selector: ' + sel);
  }

  const doc = new El('document');
  return { doc, El };
}

/** A padlock button: the sprite says which state, `aria-pressed` agrees. */
function padlock(El, shut) {
  const btn = new El('button');
  btn.setAttribute('aria-pressed', String(shut));
  const i = new El('i');
  const svg = new El('svg');
  const use = new El('use');
  use.setAttribute('href', '#' + (shut ? 'locked-12' : 'unlocked-12'));
  svg.append(use);
  i.append(svg);
  btn.append(i);
  return btn;
}

function labelled(El, text) {
  const btn = new El('button');
  const content = new El('div');
  content.textContent = text;
  btn.append(content);
  return btn;
}

/** The master pair over the Sources panel. */
function master(doc, El, { pgm, prw }) {
  for (const [role, shut] of [['PGM', pgm], ['PRW', prw]]) {
    const btn = padlock(El, shut);
    const content = new El('div');
    content.textContent = role;
    btn.append(content);
    doc.append(btn);
  }
}

/** One screen card with its two buffers. */
function card(doc, El, id, { pgm, prw, hashed = true }) {
  const view = new El('div');
  view.className = 'aw-flex-item aw-flex-col aw-preset-view aw-preset-view--selected';
  const h2 = new El('h2');
  h2.textContent = id;
  view.append(h2);

  for (const [role, shut] of [['PGM', pgm], ['PRW', prw]]) {
    const block = new El('div');
    if (hashed) block.className = 'aw-flex-row screen-overview-container__c__preset___STUB1';
    block.append(labelled(El, role), padlock(El, shut));
    view.append(block);
  }
  doc.append(view);
  return view;
}

/* ---------------------------------------------------------------- tests */

test('the master pair is read off its two buttons', () => {
  const { doc, El } = stubDom();
  master(doc, El, { pgm: true, prw: false });
  assert.deepEqual(readMasterLocks(doc), { PGM: true, PRW: false });
});

test('a PGM button with no padlock is not the master lock', () => {
  const { doc, El } = stubDom();
  /* The page has several: an eye toggle in the Edit View bar, a caret
     dropdown on each buffer. Matching on the label alone would take one. */
  const decoy = labelled(El, 'PGM');
  doc.append(decoy);
  assert.deepEqual(readMasterLocks(doc), {});
});

test('each screen card reports its own two buffers', () => {
  const { doc, El } = stubDom();
  card(doc, El, 'S1', { pgm: true, prw: false });
  card(doc, El, 'A2', { pgm: false, prw: false });
  assert.deepEqual(readCardLocks(doc), {
    S1: { PGM: true, PRW: false },
    A2: { PGM: false, PRW: false }
  });
});

test('a card with no hashed block still yields its padlocks, in drawn order', () => {
  const { doc, El } = stubDom();
  card(doc, El, 'S1', { pgm: true, prw: false, hashed: false });
  assert.deepEqual(readCardLocks(doc), { S1: { PGM: true, PRW: false } });
});

test('a card whose heading is not a destination is skipped, not guessed at', () => {
  const { doc, El } = stubDom();
  const view = card(doc, El, 'S1', { pgm: true, prw: false });
  view.querySelector('h2').textContent = 'Screen one';
  assert.deepEqual(readCardLocks(doc), {});
});

test('the card wins over the master pair', () => {
  const { doc, El } = stubDom();
  master(doc, El, { pgm: true, prw: true });
  card(doc, El, 'S1', { pgm: false, prw: false });
  assert.deepEqual(lockedFor(['S1'], 'PROGRAM', doc), { locked: [], reason: null });
});

test('a screen with no card falls back to the master pair', () => {
  const { doc, El } = stubDom();
  master(doc, El, { pgm: true, prw: false });
  card(doc, El, 'S1', { pgm: false, prw: false });

  /* S1 is on screen and open; S2 is not on screen, so the master answers. */
  assert.deepEqual(lockedFor(['S1', 'S2'], 'PROGRAM', doc), { locked: ['S2'], reason: 'master' });
  assert.deepEqual(lockedFor(['S1', 'S2'], 'PREVIEW', doc), { locked: [], reason: null });
});

test('with nothing to read at all, a screen counts as locked', () => {
  const { doc } = stubDom();
  const out = lockedFor(['S1', 'S4'], 'PROGRAM', doc);
  assert.deepEqual(out.locked, ['S1', 'S4']);
  assert.equal(out.reason, 'unknown', 'and the caller can say why it is asking');
});

test('a literal buffer letter is not a role, so there is no lock to respect', () => {
  const { doc, El } = stubDom();
  master(doc, El, { pgm: true, prw: true });
  /* The operator named the buffer rather than program or preview, and the
     vendor draws its padlocks per role. Nothing to check. */
  assert.deepEqual(lockedFor(['S1'], 'B', doc), { locked: [], reason: null });
});

test('the roles are spelled the way the vendor spells them', () => {
  assert.deepEqual(ROLE_LABEL, { PROGRAM: 'PGM', PREVIEW: 'PRW' });
});

/*
 * The popover is not an `aw-card`.
 *
 * The house rule everywhere else is "reach for an `aw-` class first", and
 * following it here produced a menu that went see-through under the pointer:
 * `.aw-card:hover` replaces the background with a translucent white highlight,
 * which is right for a card lying on the page and wrong for a popover floating
 * over one. It also wins on specificity (0-2-0 against `.wru-sendto`'s 0-1-0),
 * so no amount of ordering in our own stylesheet would have held it off.
 *
 * Pinned rather than merely commented because the next person to read the rule
 * will reach for the same class for the same good reason.
 */
test('the send-to popover does not wear the vendor card class', async () => {
  const { SENDTO_MENU_CLASS } = await import('../plugins/send-to/send-to.js');
  const classes = SENDTO_MENU_CLASS.split(/\s+/);
  assert.ok(classes.includes('wru-sendto'), 'it still carries its own class');
  assert.ok(!classes.includes('aw-card'),
    'aw-card lightens on hover, which turns a floating surface transparent');
});
