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
  class El {
    constructor(tag) {
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
    get isConnected() { return true; }
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
    _all() { return this.children.flatMap((c) => [c, ...c._all()]); }
    querySelectorAll(sel) { return this._all().filter((e) => matches(e, sel)); }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  }

  function matches(el, sel) {
    if (sel === 'a') return el.tagName === 'A';
    if (sel === 'h5') return el.tagName === 'H5';
    if (sel === 'i.icon') return el.tagName === 'I' && el.classList.contains('icon');
    if (sel.startsWith('[') && sel.endsWith(']')) return el.hasAttribute(sel.slice(1, -1));
    if (sel.startsWith('.')) return sel.slice(1).split('.').every((c) => el.classList.contains(c));
    return false;
  }

  const doc = new El('document');
  doc.createElement = (t) => new El(t);
  doc.createElementNS = () => new El('svg');
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
  doc.append(container);
  return { doc, strip, pane, container, El };
}

async function withDom(fn) {
  const stub = stubDom();
  const g = globalThis;
  const prevDoc = g.document;
  g.document = stub.doc;
  try { return await fn(stub); } finally { g.document = prevDoc; }
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
