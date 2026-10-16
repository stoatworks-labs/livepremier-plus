/*
 * The tab host, against a stand-in for the vendor's strip.
 *
 * These run without a browser, on a hand-built DOM stub, because what needs
 * pinning is the *policy* — which tab is active, whose pane is visible, what
 * happens when React re-renders the strip out from under us — and none of that
 * needs a real layout engine.
 *
 * The stub reproduces the shape read off a running Web RCS on 2026-08-21:
 * a `.ui.tabular.menu` of anchors, each holding an icon and an `h5`, over a
 * single sibling content pane.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

/* A DOM small enough to reason about, large enough for the host to run on. */
function stubDom() {
  const listeners = new Map();
  /*
   * A text node, because Midra's tabs carry their label as one — a bare
   * string beside the icon — and `_cloneTab` has to find it to replace it.
   */
  class Text {
    constructor(text) { this.nodeType = 3; this._text = text; this.parentElement = null; this.children = []; }
    get textContent() { return this._text; }
    set textContent(v) { this._text = String(v); }
    get offsetWidth() { return this._text.length * 8; }
    replaceWith(node) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) { this.parentElement.children[i] = node; node.parentElement = this.parentElement; }
    }
    remove() {
      const p = this.parentElement;
      const i = p ? p.children.indexOf(this) : -1;
      if (i >= 0) p.children.splice(i, 1);
    }
    cloneNode() { return new Text(this._text); }
    _all() { return []; }
  }
  class El {
    constructor(tag) {
      this.nodeType = 1;
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.parentElement = null;
      this.attributes = new Map();
      this.style = {};
      this.dataset = {};
      this._text = '';
      this._classes = new Set();
      this._handlers = {};
      this.hidden = false;
    }
    get classList() {
      const s = this._classes;
      return {
        add: (...c) => c.forEach((x) => s.add(x)),
        remove: (...c) => c.forEach((x) => s.delete(x)),
        contains: (c) => s.has(c),
        toggle: (c, on) => (on === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : (on ? s.add(c) : s.delete(c)))
      };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    /*
     * Just enough layout to exercise the fit ladder.
     *
     * There is no layout engine here, so widths are modelled the way the real
     * ones were measured on a running Web RCS at 1280px: a tab is 16px of
     * padding, a 24px icon when one is shown, and 8px per character of label.
     * `display: none` on a part removes it, which is exactly what `_applyMode`
     * does. The numbers only have to be in proportion for the policy — pick
     * the widest rung that fits — to be worth pinning.
     */
    get offsetWidth() {
      if (this.style.display === 'none') return 0;
      if (this.tagName === 'I') return 24;
      if (this.tagName === 'H5' || this.tagName === 'SPAN') return this.textContent.length * 8;
      if (this.tagName === 'A') return 16 + this.children.reduce((n, c) => n + c.offsetWidth, 0);
      return 0;
    }
    get childNodes() { return this.children.slice(); }
    /* Set by a test to say how much room the panel has. */
    get clientWidth() { return this._clientWidth || 0; }
    set clientWidth(v) { this._clientWidth = v; }
    /* The strip is a nowrap flex row: its content width is its shown children
       plus a 1px gap between them, whatever its own box has been squeezed to. */
    get scrollWidth() {
      const kids = this.children.filter((c) => c.tagName === 'A' && c.style.display !== 'none');
      return kids.reduce((n, c) => n + c.offsetWidth, 0) + Math.max(0, kids.length - 1);
    }
    /* Where an element is: `_rect` where `stubDom` lays one out, a tab level
       with the strip's row, and nothing for the rest. */
    getBoundingClientRect() {
      if (this._rect) return this._rect();
      if (this.tagName === 'A') return { left: 0, right: this.offsetWidth, top: 8, bottom: 48, width: this.offsetWidth, height: 40 };
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    }
    contains(node) {
      for (let n = node; n; n = n.parentElement) if (n === this) return true;
      return false;
    }
    get textContent() {
      return this._text || this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) { this._text = String(v); this.children = []; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    /* The icon helper builds real SVG, so the stub has to answer the
       namespaced setter too. */
    setAttributeNS(_ns, k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) { this.attributes.delete(k); }
    hasAttribute(k) { return this.attributes.has(k); }
    append(...kids) { for (const k of kids) { if (k == null) continue; k.parentElement = this; this.children.push(k); } }
    remove() {
      const p = this.parentElement;
      if (!p) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
      this.parentElement = null;
    }
    get isConnected() { return this.parentElement !== null || this.tagName === 'DOCUMENT'; }
    addEventListener(t, fn) { (this._handlers[t] ||= []).push(fn); }
    click() { for (const fn of this._handlers.click || []) fn({ preventDefault() {}, stopPropagation() {}, target: this }); }
    replaceWith(node) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) { this.parentElement.children[i] = node; node.parentElement = this.parentElement; }
    }
    cloneNode() {
      const c = new El(this.tagName);
      c.className = this.className;
      c._text = this._text;
      for (const [k, v] of this.attributes) c.attributes.set(k, v);
      for (const kid of this.children) { const k2 = kid.cloneNode(true); k2.parentElement = c; c.children.push(k2); }
      return c;
    }
    _all() { return this.children.filter((c) => c.nodeType === 1).flatMap((c) => [c, ...c._all()]); }
    querySelectorAll(sel) { return this._all().filter((e) => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  function matches(el, sel) {
    if (sel === 'a') return el.tagName === 'A';
    if (sel === 'h5') return el.tagName === 'H5';
    if (sel === 'i.icon') return el.tagName === 'I' && el.classList.contains('icon');
    if (sel.startsWith('[') && sel.endsWith(']')) return el.hasAttribute(sel.slice(1, -1));
    if (sel.startsWith('.')) return sel.slice(1).split('.').every((c) => el.classList.contains(c));
    if (/^[a-z0-9]+$/.test(sel)) return el.tagName === sel.toUpperCase();
    return false;
  }

  const doc = new El('document');
  doc.createElement = (t) => new El(t);
  doc.createTextNode = (t) => new Text(String(t));
  doc.createElementNS = (_ns, t) => new El(t);
  doc.addEventListener = (t, fn) => (listeners.set(t, [...(listeners.get(t) || []), fn]));
  doc.removeEventListener = () => {};

  const container = new El('div');
  container.className = 'preset-setup-panels-container__c__tab___3L0xl aw-flex-col';
  const strip = new El('div');
  strip.className = 'ui tabular aw-gap-col-mini menu';
  for (const [label, active] of [['Properties', true], ['Memories', false]]) {
    const a = new El('a');
    a.className = 'item aw-padding-extra-large' + (active ? ' active' : '');
    const i = new El('i'); i.className = 'icon medium aw-block-medium';
    const h5 = new El('h5'); h5.textContent = label;
    a.append(i, h5);
    strip.append(a);
  }
  const pane = new El('div');
  pane.className = 'ui bottom attached segment active tab aw-full-height';
  pane.append(Object.assign(new El('span'), { _text: 'vendor content' }));
  container.append(strip, pane);

  /*
   * The panel around them, laid out as Web RCS 6.2.73 lays it out (measured
   * 2026-10-16): the strip is lifted into the panel's header row and centred
   * over the container — `left: 50%`, `translateX(-50%)` — so whatever its
   * width it spills off both sides equally. The header's collapse button is
   * left out unless a test adds it with `addCollapse`.
   */
  const panel = new El('div');
  panel.className = 'aw-panel';
  const header = new El('div');
  header.className = 'aw-panel__header';
  panel.append(header, container);
  container._rect = () => ({ left: 0, right: container.clientWidth, top: 40, bottom: 600, width: container.clientWidth, height: 560 });
  strip._rect = () => {
    const width = strip.scrollWidth;
    const left = (container.clientWidth - width) / 2;
    return { left, right: left + width, top: 0, bottom: 48, width, height: 48 };
  };
  strip.offsetParent = panel;
  doc.append(panel);
  doc.body = new El('body');
  doc.append(doc.body);
  return { doc, strip, pane, container, header, El, Text };
}

/* The panel's own `»`, 24px at the right of the header, level with the tabs. */
function addCollapse({ header, container, El }) {
  const button = new El('button');
  button._rect = () => {
    const right = container.clientWidth;
    return { left: right - 24, right, top: 8, bottom: 32, width: 24, height: 24 };
  };
  header.append(button);
  return button;
}

async function withDom(fn) {
  const stub = stubDom();
  const g = globalThis;
  const prevDoc = g.document;
  const prevNode = g.Node;
  g.document = stub.doc;
  /* `h()` asks `instanceof Node` of each child, which the ⋯ menu's rows are. */
  g.Node = { [Symbol.hasInstance]: (x) => Boolean(x) && typeof x.nodeType === 'number' };
  try { return await fn(stub); } finally { g.document = prevDoc; g.Node = prevNode; }
}

const tabsOf = (strip) =>
  strip.querySelectorAll('a').map((a) => ({
    label: (a.querySelector('h5') || a).textContent,
    ours: a.hasAttribute('data-lpp-tab'),
    active: a.classList.contains('active')
  }));

test('our tabs are appended to the vendor strip, cloned from a real one', async () => {
  await withDom(async ({ doc, strip }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [
        { id: 'console', label: 'Console', icon: 'mini-list-14', render: () => doc.createElement('div') },
        { id: 'timeline', label: 'Timeline', icon: 'timer-14', render: () => doc.createElement('div') }
      ]
    });
    host._mount();

    const t = tabsOf(strip);
    assert.deepEqual(t.map((x) => x.label), ['Properties', 'Memories', 'Console', 'Timeline']);
    assert.deepEqual(t.map((x) => x.ours), [false, false, true, true]);
    /* Cloned, so the vendor's own padding class comes along. */
    const ours = strip.querySelectorAll('[data-lpp-tab]')[0];
    assert.ok(ours.classList.contains('aw-padding-extra-large'), 'inherits vendor classes');
    assert.equal(ours.classList.contains('active'), false, 'and not its template\'s state');
  });
});

test('showing one of ours hides the vendor pane, and only one tab is active', async () => {
  await withDom(async ({ doc, strip, pane }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => { const d = doc.createElement('div'); d.textContent = 'ours'; return d; } }]
    });
    host._mount();
    host.show('console');

    assert.equal(pane.style.display, 'none', 'vendor pane hidden, not removed');
    const t = tabsOf(strip);
    assert.equal(t.find((x) => x.label === 'Console').active, true);
    assert.equal(t.find((x) => x.label === 'Properties').active, false,
      'the vendor tab must not stay lit while ours is open');
  });
});

test('hiding restores the vendor pane exactly as it was', async () => {
  await withDom(async ({ doc, strip, pane }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    pane.style.display = 'flex';   // the vendor had its own value
    const host = new TabHost({ tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => doc.createElement('div') }] });
    host._mount();
    host.show('console');
    assert.equal(pane.style.display, 'none');
    host.hide();
    assert.equal(pane.style.display, 'flex', 'restored, not blanked');
    assert.equal(host.active, null);
  });
});

test('toggling the open tab closes it', async () => {
  await withDom(async ({ doc }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({ tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => doc.createElement('div') }] });
    host._mount();
    host.toggle('console');
    assert.equal(host.active, 'console');
    host.toggle('console');
    assert.equal(host.active, null);
  });
});

test('clicking a rendered tab activates it', async () => {
  await withDom(async ({ doc, strip }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({ tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => doc.createElement('div') }] });
    host._mount();
    strip.querySelectorAll('[data-lpp-tab]')[0].click();
    assert.equal(host.active, 'console');
  });
});

test('a re-render puts the tabs back without duplicating them', async () => {
  await withDom(async ({ doc, strip }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({ tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => doc.createElement('div') }] });
    host._mount();
    assert.equal(strip.querySelectorAll('[data-lpp-tab]').length, 1);

    /* Mounting again is what the observer does; it must be idempotent. */
    host._mount();
    assert.equal(strip.querySelectorAll('[data-lpp-tab]').length, 1, 'no duplicates');

    /* React blowing the strip away and rebuilding it. */
    strip.children = strip.children.filter((c) => !c.hasAttribute('data-lpp-tab'));
    host._mount();
    assert.equal(strip.querySelectorAll('[data-lpp-tab]').length, 1, 'restored after a re-render');
  });
});

test('a page with no tab strip is simply left alone', async () => {
  await withDom(async ({ doc, container }) => {
    const { TabHost } = await import('../src/ui/tabs.js');
    container.children = [];   // e.g. the Virtual RC400T page
    const host = new TabHost({ tabs: [{ id: 'console', label: 'Console', icon: 'x', render: () => doc.createElement('div') }] });
    assert.equal(host._mount(), false, 'reports it did nothing');
    assert.equal(host.active, null);
  });
});

/*
 * Preconfig heads its page with a strip built from the same Semantic UI
 * classes as the per-screen tab strip, and it comes first in the document.
 * The difference is what the anchors are: icon links to other routes, not
 * tabs over a pane. Ours belong on the pane switcher and nowhere else — this
 * shipped wrong, putting the words "Console" and "Timeline" in a row of
 * glyphs on a page they have nothing to do with.
 */
function withNavStrip(stub) {
  const { doc, El, container } = stub;
  const nav = new El('div');
  nav.className = 'ui tabular aw-gap-col-mini aw-margin-horizontal-huge floating center menu';
  for (const href of ['/preconfig/system', '/preconfig/multiviewers']) {
    const a = new El('a');
    a.className = 'icon item aw-padding-none';
    a.setAttribute('href', href);
    const i = new El('i'); i.className = 'icon large aw-block-big';
    a.append(i);
    nav.append(a);
  }
  /* Before the real strip, so "first match wins" would pick the wrong one. */
  doc.children = [nav, ...doc.children.filter((c) => c !== nav)];
  nav.parentElement = doc;
  container.parentElement = doc;
  return nav;
}

test('a strip of route links is not mistaken for a tab strip', async () => {
  await withDom(async (stub) => {
    const nav = withNavStrip(stub);
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'console', label: 'Console', icon: 'mini-list-14', render: () => stub.doc.createElement('div') }]
    });
    host._mount();

    assert.equal(nav.querySelectorAll('[data-lpp-tab]').length, 0, 'nothing added to the route links');
    assert.equal(stub.strip.querySelectorAll('[data-lpp-tab]').length, 1, 'added to the pane switcher');
  });
});

test('a page with only route links gets no tabs at all', async () => {
  await withDom(async (stub) => {
    /* Take the pane switcher away: this is the Preconfig page. */
    stub.container.children = stub.container.children.filter((c) => c !== stub.strip);
    const nav = withNavStrip(stub);
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'console', label: 'Console', icon: 'mini-list-14', render: () => stub.doc.createElement('div') }]
    });
    assert.equal(host._mount(), false);
    assert.equal(nav.querySelectorAll('[data-lpp-tab]').length, 0);
  });
});

/*
 * The EDID page heads its bank column with a pane switcher of its own —
 * Default EDIDS, EDID Bank: labelled anchors, no href, each an `h3` and no
 * icon. Before the icon rule, Console, Timeline, Layer and Groups were appended
 * to it (read off LivePremier Simulator 6.2.73, 2026-09-23).
 */
function withEdidStrip(stub, { alone = false } = {}) {
  if (alone) stub.container.children = stub.container.children.filter((c) => c !== stub.strip);
  const section = new stub.El('div');
  section.className = 'banks-section__c___v8oWs aw-flex-col';
  const strip = new stub.El('div');
  strip.className = 'ui tabular aw-gap-col-mini menu';
  for (const label of ['Default EDIDS', 'EDID Bank']) {
    const a = new stub.El('a');
    a.className = 'item aw-padding-big';
    const h3 = new stub.El('h3'); h3.textContent = label;
    a.append(h3);
    strip.append(a);
  }
  section.append(strip);
  /* First in the document, so a rule that only counted labelled anchors would take it. */
  stub.doc.children.unshift(section);
  section.parentElement = stub.doc;
  return strip;
}

test('the EDID page’s strip is not taken for the per-screen one', async () => {
  await withDom(async (stub) => {
    const edid = withEdidStrip(stub);
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'console', label: 'Console', icon: 'mini-list-14', render: () => stub.doc.createElement('div') }]
    });
    host._mount();
    assert.equal(edid.querySelectorAll('[data-lpp-tab]').length, 0, 'nothing added to Default EDIDS / EDID Bank');
    assert.equal(stub.strip.querySelectorAll('[data-lpp-tab]').length, 1, 'added to the per-screen strip');
  });
});

test('the EDID page on its own gets no per-screen tabs at all', async () => {
  await withDom(async (stub) => {
    const edid = withEdidStrip(stub, { alone: true });
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'console', label: 'Console', icon: 'mini-list-14', render: () => stub.doc.createElement('div') }]
    });
    assert.equal(host._mount(), false);
    assert.equal(edid.querySelectorAll('[data-lpp-tab]').length, 0);
  });
});

/*
 * Midra 4K and Alta 4K build the same strip from the same Semantic UI
 * `Menu.Item`, but hand it `content` as a string: the label is a bare text
 * node beside the icon, and there is no `h5`. Read off a Pulse 4K's bundle on
 * 2026-09-12. The first version of the pane-switcher test required the `h5`
 * and so never found this strip at all.
 */
function asMidraStrip(stub) {
  const { El, Text, strip } = stub;
  strip.children = [];
  for (const [label, active] of [['Properties', true], ['Memories', false]]) {
    const a = new El('a');
    a.className = 'item' + (active ? ' active' : '');
    const i = new El('i'); i.className = 'medium icon';
    a.append(i, new Text(label));
    strip.append(a);
  }
  return strip;
}

test('a strip whose labels are bare text nodes is a pane switcher too', async () => {
  await withDom(async (stub) => {
    const strip = asMidraStrip(stub);
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'timeline', label: 'Timeline', short: 'Cues', icon: 'timer-14', render: () => stub.doc.createElement('div') }]
    });
    assert.equal(host._mount(), true);
    const ours = strip.querySelectorAll('[data-lpp-tab]');
    assert.equal(ours.length, 1);
    /* The label went into an inline span, not a heading — an h5 here would
       render larger than the vendor's own label and on its own line. */
    assert.equal(ours[0].querySelector('h5'), null);
    const label = ours[0].querySelector('[data-lpp-label]');
    assert.equal(label.tagName, 'SPAN');
    assert.equal(label.textContent, 'Timeline');
    assert.equal(ours[0].textContent, 'Timeline', 'and the cloned vendor text is gone');
    /* The fit ladder finds the same label element. */
    host._applyMode(strip, 'short');
    assert.equal(label.textContent, 'Cues');
    host._applyMode(strip, 'icon');
    assert.equal(label.style.display, 'none');
  });
});

test('a page of one-tab strips gets no tabs — a lone tab is a heading', async () => {
  await withDom(async (stub) => {
    /* Midra's Preconfig page: each section is its own strip with one tab. */
    const { El, Text, container, strip } = stub;
    container.children = container.children.filter((c) => c !== strip);
    for (const title of ['Resources', 'Screens', 'Summary']) {
      const one = new El('div');
      one.className = 'ui tabular menu';
      const a = new El('a'); a.className = 'active item'; a.append(new Text(title));
      one.append(a);
      container.append(one);
    }
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({
      tabs: [{ id: 'timeline', label: 'Timeline', icon: 'timer-14', render: () => stub.doc.createElement('div') }]
    });
    assert.equal(host._mount(), false);
    assert.equal(container.querySelectorAll('[data-lpp-tab]').length, 0);
  });
});

/*
 * Fitting the strip.
 *
 * The panel these tabs live in is about 360px on a 1280px window and the
 * vendor's own two tabs already spend most of it, so Console and Timeline ran
 * out past the panel edge and under the Transition column beside it. Nothing
 * clipped them and nothing scrolled: the strip is `nowrap` with
 * `overflow: visible`.
 *
 * The widths below come from the stub's model, not from a browser, so what is
 * pinned is the policy — take the widest rung that fits, never touch the
 * vendor's tabs, and keep the tabs rather than drop them when nothing fits.
 */
const fitTabs = (doc) => [
  { id: 'console', label: 'Console', short: 'Cmd', icon: 'mini-list-14', render: () => doc.createElement('div') },
  { id: 'timeline', label: 'Timeline', short: 'Cues', icon: 'timer-14', render: () => doc.createElement('div') }
];

const labelsOf = (strip) =>
  strip.querySelectorAll('[data-lpp-tab]').map((a) => {
    const h5 = a.querySelector('h5');
    const glyph = a.querySelector('i.icon');
    return {
      text: h5 && h5.style.display !== 'none' ? h5.textContent : null,
      icon: !!(glyph && glyph.style.display !== 'none')
    };
  });

async function fitAt(room, { tabs = fitTabs, collapse = false, then } = {}) {
  return withDom(async (stub) => {
    stub.container.clientWidth = room;
    if (collapse) addCollapse(stub);
    const { TabHost } = await import('../src/ui/tabs.js');
    const host = new TabHost({ tabs: tabs(stub.doc) });
    host._mount();
    const out = { host, labels: labelsOf(stub.strip), strip: stub.strip, stub };
    if (then) await then(out);
    return out;
  });
}

test('a wide panel keeps the full labels and the icons', async () => {
  const { host, labels } = await fitAt(430);
  assert.equal(host.mode, 'full');
  assert.deepEqual(labels, [
    { text: 'Console', icon: true },
    { text: 'Timeline', icon: true }
  ]);
});

/* The icon is the first thing to go: a word is worth more than a glyph in a
   strip whose other tabs are words. */
test('a little tight drops the icons before it touches the words', async () => {
  const { host, labels } = await fitAt(380);
  assert.equal(host.mode, 'label');
  assert.deepEqual(labels, [
    { text: 'Console', icon: false },
    { text: 'Timeline', icon: false }
  ]);
});

test('the real panel width falls back to the short names', async () => {
  const { host, labels, strip } = await fitAt(360);
  assert.equal(host.mode, 'short');
  assert.deepEqual(labels, [
    { text: 'Cmd', icon: false },
    { text: 'Cues', icon: false }
  ]);
  assert.ok(strip.scrollWidth <= 360, 'and it actually fits: ' + strip.scrollWidth);
});

test('narrower still leaves the icons alone, with the name on hover', async () => {
  const { host, labels, strip } = await fitAt(310);
  assert.equal(host.mode, 'icon');
  assert.deepEqual(labels, [
    { text: null, icon: true },
    { text: null, icon: true }
  ]);
  assert.equal(strip.querySelectorAll('[data-lpp-tab]')[0].getAttribute('title'), 'Console');
});

/* Squeezed past every rung, the tabs stay — behind ⋯, which stays too. A panel
   that is hard to reach is recoverable; a panel that has silently removed the
   cue stack is not. */
test('a panel too narrow for any rung keeps the tabs rather than dropping them', async () => {
  const { host, strip } = await fitAt(80);
  assert.equal(host.mode, 'more');
  assert.deepEqual(host.overflow, ['console', 'timeline']);
  assert.equal(strip.querySelectorAll('[data-lpp-more]').length, 1);
});

/*
 * The strip is centred over the panel, and the panel's own collapse button
 * sits in the same row at the right, so a strip narrower than the panel can
 * still run under it. Without the button 360px takes the short names (above);
 * with it, they would end 1.5px into the button, so the icons it is.
 */
test("the strip is kept clear of the panel's own collapse button", async () => {
  const { host, strip } = await fitAt(360, { collapse: true });
  assert.equal(host.mode, 'icon');
  assert.ok(strip.getBoundingClientRect().right <= 336, 'clear of the button: ' + strip.getBoundingClientRect().right);
});

/* What LivePremier actually has: four plugins with a tab apiece. */
const fourTabs = (doc) => [
  ...fitTabs(doc),
  { id: 'layer', label: 'Layer', short: 'Layer', icon: 'properties-14', render: () => doc.createElement('div') },
  { id: 'groups', label: 'Groups', short: 'Grps', icon: 'group-14', render: () => doc.createElement('div') }
];
const moreOf = (strip) => strip.querySelector('[data-lpp-more]');
const shownOurs = (strip) =>
  strip.querySelectorAll('[data-lpp-tab]').filter((a) => !a.hasAttribute('data-lpp-more') && a.style.display !== 'none');

test('tabs that will not fit as icons go behind ⋯, as many staying out as fit', async () => {
  const { host, strip } = await fitAt(360, { tabs: fourTabs, collapse: true });
  assert.equal(host.mode, 'more');
  assert.deepEqual(shownOurs(strip).map((a) => a.getAttribute('title')), ['Console']);
  assert.deepEqual(host.overflow, ['timeline', 'layer', 'groups']);
  assert.equal(moreOf(strip).getAttribute('title'), 'More: Timeline, Layer, Groups');
  assert.ok(strip.getBoundingClientRect().right <= 336);
});

/* LivePremier's case: its vendor tabs are wider than the stub's, and leave
   room for ⋯ alone. */
test('a panel with room for nothing else puts every tab behind ⋯', async () => {
  const { host, strip } = await fitAt(330, { tabs: fourTabs, collapse: true });
  assert.deepEqual(host.overflow, ['console', 'timeline', 'layer', 'groups']);
  assert.equal(shownOurs(strip).length, 0);
  const r = strip.getBoundingClientRect();
  assert.ok(r.left >= 0 && r.right <= 306, `inside the panel and clear of the button: ${r.left}..${r.right}`);
});

test('the open tab behind ⋯ lights it and lends it its icon, and lets go when closed', async () => {
  await fitAt(330, {
    tabs: fourTabs, collapse: true,
    then: ({ host, strip }) => {
      const glyph = () => moreOf(strip).querySelector('use').getAttribute('href');
      assert.equal(glyph(), '#more-horizontal-14');
      host.show('timeline');
      assert.ok(moreOf(strip).classList.contains('active'));
      assert.equal(glyph(), '#timer-14');
      assert.deepEqual(tabsOf(strip).filter((t) => t.active && !t.ours), [], 'no vendor tab lit');
      host.hide();
      assert.equal(moreOf(strip).classList.contains('active'), false);
      assert.equal(glyph(), '#more-horizontal-14');
    }
  });
});

test('⋯ opens a menu of the tabs behind it, and picking one opens that tab', async () => {
  await fitAt(330, {
    tabs: fourTabs, collapse: true,
    then: ({ host, strip, stub }) => {
      host.show('console');
      moreOf(strip).click();
      const menu = stub.doc.body.querySelector('.wru-tabmenu');
      assert.ok(menu, 'menu open');
      const rows = menu.querySelectorAll('button');
      assert.deepEqual(rows.map((r) => r.textContent), ['Console', 'Timeline', 'Layer', 'Groups']);
      assert.deepEqual(rows.map((r) => r.classList.contains('wru-tabmenu-row--on')), [true, false, false, false]);
      rows[2].click();
      assert.equal(host.active, 'layer');
      assert.equal(stub.doc.body.querySelector('.wru-tabmenu'), null, 'and the menu closes');
      /* Picking the open one keeps it open: a menu that closed the panel you
         picked would be a strange menu. */
      moreOf(strip).click();
      stub.doc.body.querySelector('.wru-tabmenu').querySelectorAll('button')[2].click();
      assert.equal(host.active, 'layer');
    }
  });
});

test('clicking ⋯ again closes its menu, and so does a re-render', async () => {
  await fitAt(330, {
    tabs: fourTabs, collapse: true,
    then: ({ host, strip, stub }) => {
      moreOf(strip).click();
      moreOf(strip).click();
      assert.equal(stub.doc.body.querySelector('.wru-tabmenu'), null);
      moreOf(strip).click();
      host.remount();
      assert.equal(stub.doc.body.querySelector('.wru-tabmenu'), null);
      assert.equal(strip.querySelectorAll('[data-lpp-more]').length, 1, 'one ⋯, not two');
    }
  });
});

test('a panel that widens again takes ⋯ away and puts the tabs back', async () => {
  await fitAt(330, {
    tabs: fourTabs, collapse: true,
    then: ({ host, strip, stub }) => {
      stub.container.clientWidth = 900;
      host._fit();
      assert.equal(host.mode, 'full');
      assert.equal(moreOf(strip), null);
      assert.deepEqual(host.overflow, []);
      assert.equal(shownOurs(strip).length, 4);
    }
  });
});

test("the vendor's own tabs are never shortened", async () => {
  await withDom(async (stub) => {
    stub.container.clientWidth = 200;
    const { TabHost } = await import('../src/ui/tabs.js');
    new TabHost({ tabs: fitTabs(stub.doc) })._mount();
    const vendor = stub.strip.querySelectorAll('a').filter((a) => !a.hasAttribute('data-lpp-tab'));
    assert.deepEqual(vendor.map((a) => a.querySelector('h5').textContent), ['Properties', 'Memories']);
    assert.deepEqual(vendor.map((a) => a.querySelector('h5').style.display), [undefined, undefined]);
  });
});

/* A zero-width panel is one that has not been laid out yet, not one with no
   room. Treating it as tiny would send every tab to icon-only and leave it
   there, because nothing measures again until the width changes. */
test('an unlaid-out panel is left alone rather than collapsed', async () => {
  const { host, labels } = await fitAt(0);
  assert.equal(host.mode, 'full');
  assert.equal(labels[0].text, 'Console');
});
