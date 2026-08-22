/*
 * The sidebar shell, against a stand-in for Web RCS's own navigation.
 *
 * Same approach as tabs.test.js and for the same reason: what needs pinning is
 * the policy — where an entry lands, what it is cloned from, which classes it
 * inherits and which it must not — and none of that needs a layout engine.
 *
 * The stub reproduces the shape read off a running Web RCS on 2026-08-22: a
 * sidebar of `sidebar-module__c__menu___<hash>` items, each wrapping a title
 * anchor, with Preconfig alone carrying a flyout of
 * `sidebar-module__c__submenu__list__item___<hash>` anchors. The hashes are
 * deliberately not the live ones — nothing may match on them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const H = {
  sidebar: 'sidebar-module__c___TEST1',
  menu: 'sidebar-module__c__menu___TEST2',
  title: 'sidebar-module__c__menu__title___TEST3',
  titleActive: 'sidebar-module__c__menu__title--active___TEST4',
  label: 'sidebar-module__c__menu__title__label___TEST5',
  separator: 'sidebar-module__c__separator___TEST6',
  sepTitle: 'sidebar-module__c__separator__title___TEST7',
  submenu: 'sidebar-module__c__submenu___TEST8',
  sublist: 'sidebar-module__c__submenu__list___TEST9',
  subitem: 'sidebar-module__c__submenu__list__item___TESTA',
  subitemActive: 'sidebar-module__c__submenu__list__item--active___TESTB'
};

function stubDom() {
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
        toggle: (c, on) => (on === undefined ? (s.has(c) ? s.delete(c) : s.add(c)) : (on ? s.add(c) : s.delete(c))),
        [Symbol.iterator]: () => s[Symbol.iterator]()
      };
    }
    get className() { return [...this._classes].join(' '); }
    set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
    get id() { return this.getAttribute('id') || ''; }
    set id(v) { this.setAttribute('id', v); }
    get textContent() { return this._text || this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    setAttributeNS(_ns, k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
    removeAttribute(k) { this.attributes.delete(k); }
    hasAttribute(k) { return this.attributes.has(k); }
    append(...kids) { for (const k of kids) { if (k == null) continue; k.parentElement = this; this.children.push(k); } }
    replaceChildren(...kids) { this.children = []; this._text = ''; this.append(...kids); }
    after(node) {
      const p = this.parentElement;
      const i = p.children.indexOf(this);
      p.children.splice(i + 1, 0, node);
      node.parentElement = p;
    }
    replaceWith(node) {
      const i = this.parentElement.children.indexOf(this);
      if (i >= 0) { this.parentElement.children[i] = node; node.parentElement = this.parentElement; }
    }
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

  /* Enough CSS selector to run the shell: a tag, a class chain, the
     substring-attribute form every hashed class is matched by, and a comma
     list — the sidebar selectors are lists now, because Analog Way spells the
     module `sidebar-module` on LivePremier and `sidebar` on Midra and Alta. */
  function matches(el, sel) {
    if (sel.includes(',')) return sel.split(',').some((one) => matches(el, one.trim()));
    const attr = /^\[([a-zA-Z-]+)\*="([^"]+)"\]$/.exec(sel);
    if (attr) {
      const v = attr[1] === 'class' ? el.className : el.getAttribute(attr[1]);
      return typeof v === 'string' && v.includes(attr[2]);
    }
    if (sel.startsWith('[') && sel.endsWith(']')) return el.hasAttribute(sel.slice(1, -1));
    if (sel.startsWith('.')) return sel.slice(1).split('.').every((c) => el.classList.contains(c));
    if (sel === 'i.icon') return el.tagName === 'I' && el.classList.contains('icon');
    return el.tagName === sel.toUpperCase();
  }

  const doc = new El('document');
  doc.createElement = (t) => new El(t);
  doc.createElementNS = () => new El('svg');
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.getElementById = (id) => doc.querySelectorAll('[id]').find((e) => e.getAttribute('id') === id) || null;
  doc.head = new El('head');
  /* The active flyout class is read out of here when no element is wearing
     it, which is the normal case: nobody has been to a Preconfig page. */
  doc.styleSheets = [{ cssRules: [
    { selectorText: '.' + H.subitem, cssText: '' },
    { selectorText: '.' + H.subitemActive, cssText: '' },
    { selectorText: '.' + H.subitemActive + ':hover', cssText: '' }
  ] }];

  const menuItem = (label, { active = false } = {}) => {
    const item = new El('div');
    item.className = H.menu;
    const a = new El('a');
    a.className = H.title + (active ? ' ' + H.titleActive : '');
    a.setAttribute('href', '/' + label.toLowerCase());
    const i = new El('i'); i.className = 'icon large aw-block-huge';
    const lab = new El('div'); lab.className = H.label + ' aw-font-subtitle-1'; lab.textContent = label;
    a.append(i, lab);
    item.append(a);
    return item;
  };

  const app = new El('div');
  app.className = 'aw-app';
  app.append(new El('div'));            /* the header row */
  const row = new El('div');
  const sidebar = new El('div');
  sidebar.className = H.sidebar;
  const list = new El('div');

  const sep = new El('div');
  sep.className = H.separator;
  const sepTitle = new El('div'); sepTitle.className = H.sepTitle; sepTitle.textContent = 'LIVE';
  sep.append(sepTitle);
  list.append(sep);

  list.append(menuItem('Screens'), menuItem('Virtual RC400T'));

  /* Preconfig, the one item with a flyout. Marked active because some page
     always is, which is how the title's active classes get read. */
  const preconfig = menuItem('Preconfig', { active: true });
  const submenu = new El('div'); submenu.className = H.submenu;
  const sublist = new El('div'); sublist.className = 'aw-flex-col ' + H.sublist;
  for (const label of ['System', 'Outputs']) {
    const a = new El('a');
    a.className = H.subitem + ' aw-relative aw-font-body-1 aw-padding-vertical-small';
    a.setAttribute('href', '/preconfig/' + label.toLowerCase());
    a.textContent = label;
    sublist.append(a);
  }
  submenu.append(sublist);
  preconfig.append(submenu);
  list.append(preconfig);

  sidebar.append(list);
  const main = new El('div');
  main.className = 'aw-flex-item aw-min-width-0';
  row.append(sidebar, main);
  app.append(row);
  doc.append(app);

  return { doc, sidebar, list, sublist, preconfig, main, El };
}

async function withDom(fn) {
  const stub = stubDom();
  const g = globalThis;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = stub.doc;
  g.window = { addEventListener() {} };
  try { return await fn(stub); } finally { g.document = prevDoc; g.window = prevWin; }
}

const entry = (over) => ({ id: 'x', label: 'X', render: () => document.createElement('div'), ...over });

test('an entry with no placement goes in our own section at the end', async () => {
  await withDom(async ({ doc, list }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ title: 'PLUS', entries: [entry({ id: 'vpu', label: 'VPU Map' })] });
    assert.equal(shell._mount(), true);

    const section = doc.getElementById('wru-nav-section');
    assert.ok(section, 'the section exists');
    assert.equal(list.children[list.children.length - 1], section, 'and it is last');
    assert.equal(section.textContent, 'PLUSVPU Map');
  });
});

test('an anchored entry lands directly beneath the vendor item it names', async () => {
  await withDom(async ({ doc, list }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'midi', label: 'MIDI Mapping', after: 'Virtual RC400T' })] });
    shell._mount();

    const labels = list.children.map((c) => c.textContent);
    assert.deepEqual(labels, ['LIVE', 'Screens', 'Virtual RC400T', 'MIDI Mapping', 'PreconfigSystemOutputs']);
    assert.ok(doc.getElementById('wru-nav-midi'));
  });
});

test('a submenu entry lands inside that item\'s flyout, cloned from a real one', async () => {
  await withDom(async ({ doc, sublist }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig' })] });
    shell._mount();

    const items = sublist.children;
    assert.deepEqual(items.map((a) => a.textContent), ['System', 'Outputs', 'LivePremier Plus']);
    const ours = items[2];
    /* Cloned, so the vendor's padding and type classes come with it. */
    assert.ok(ours.classList.contains(H.subitem));
    assert.ok(ours.classList.contains('aw-padding-vertical-small'));
    /* And it is ours, wherever it happens to sit. */
    assert.ok(ours.hasAttribute('data-lpp-nav'));
    assert.equal(ours.getAttribute('href'), '#settings');
    assert.equal(doc.getElementById('wru-nav-settings'), ours);
  });
});

/*
 * The flyout's active class only exists on an element while the operator is on
 * a page inside the flyout, and they may never go to one. Reading it out of
 * the vendor's stylesheet is what makes the highlight work on first use.
 */
test('the flyout highlight is read from the stylesheet when nothing is wearing it', async () => {
  await withDom(async ({ sublist, preconfig }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig' })] });
    shell._mount();
    const ours = sublist.children[2];
    assert.equal(ours.classList.contains(H.subitemActive), false, 'not active before it is opened');

    shell.show('settings');
    assert.ok(ours.classList.contains(H.subitemActive), 'the vendor\'s own active class, hash and all');
    /* And the parent lights up, because that is what the vendor does for
       every page in the flyout. */
    assert.ok(preconfig.querySelector('a').classList.contains(H.titleActive));

    shell.hide();
    assert.equal(ours.classList.contains(H.subitemActive), false);
  });
});

test('opening a panel hides the vendor content and gives it back on close', async () => {
  await withDom(async ({ doc, main }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'settings', label: 'X', submenuOf: 'Preconfig' })] });
    shell._mount();

    shell.show('settings');
    assert.equal(main.style.display, 'none');
    assert.equal(doc.getElementById('wru-overlay').hidden, false);

    shell.hide();
    assert.equal(main.style.display, '');
    assert.equal(doc.getElementById('wru-overlay').hidden, true);
  });
});

test('clicking our flyout entry opens it, and clicking it again closes it', async () => {
  await withDom(async ({ sublist }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'settings', label: 'X', submenuOf: 'Preconfig' })] });
    shell._mount();
    const ours = sublist.children[2];

    ours.click();
    assert.equal(shell.active, 'settings');
    ours.click();
    assert.equal(shell.active, null);
  });
});

/*
 * React re-renders the sidebar on navigation and our entries go with it. Each
 * placement has to be restored on its own: an anchored entry can be lost while
 * the section survives, and before this the mount bailed out early whenever
 * the section was present.
 */
test('a re-render restores every placement without duplicating any', async () => {
  await withDom(async ({ doc, sublist, list }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({
      entries: [
        entry({ id: 'vpu', label: 'VPU Map' }),
        entry({ id: 'midi', label: 'MIDI Mapping', after: 'Virtual RC400T' }),
        entry({ id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig' })
      ]
    });
    shell._mount();

    /* React drops the flyout entry and the anchored one, keeps our section. */
    sublist.children = sublist.children.filter((c) => c.getAttribute('id') !== 'wru-nav-settings');
    list.children = list.children.filter((c) => c.getAttribute('id') !== 'wru-nav-midi');

    shell._mount();

    assert.equal(sublist.querySelectorAll('[data-lpp-nav]').length, 1);
    assert.equal(doc.querySelectorAll('[id]').filter((e) => e.getAttribute('id') === 'wru-nav-section').length, 1);
    assert.ok(doc.getElementById('wru-nav-midi'));
    assert.ok(doc.getElementById('wru-nav-settings'));
  });
});

test('an entry naming a menu this device does not have is simply dropped', async () => {
  await withDom(async ({ doc, sublist }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({ entries: [entry({ id: 'settings', label: 'X', submenuOf: 'Nowhere' })] });
    shell._mount();
    assert.equal(doc.getElementById('wru-nav-settings'), null);
    assert.equal(sublist.children.length, 2);
  });
});

/*
 * The other spelling.
 *
 * Midra 4K and Alta 4K run a different platform (`mng-platform`) whose Web RCS
 * names the same module `sidebar__c__…` rather than `sidebar-module__c__…`.
 * Every segment after `__c__` is identical, so both spellings are matched.
 *
 * The panels themselves are LivePremier-only for now — see `core/platform.js`
 * — but the settings page has to mount on those switchers regardless, because
 * it is where an operator finds out why nothing else is on offer. An app that
 * silently does nothing is worse than one that explains itself.
 */
test('the sidebar is found under either platform\'s spelling of it', async () => {
  const stub = stubDom();
  /* Rename every hashed class the way the other platform spells it. */
  const rename = (el) => {
    el.className = [...el.classList].map((c) => c.replace(/^sidebar-module__c/, 'sidebar__c')).join(' ');
    for (const kid of el.children) rename(kid);
  };
  rename(stub.doc);

  const g = globalThis;
  const prevDoc = g.document;
  const prevWin = g.window;
  g.document = stub.doc;
  g.window = { addEventListener() {} };
  try {
    const { Shell, SIDEBAR_SELECTOR } = await import('../src/ui/shell.js');
    assert.ok(stub.doc.querySelector(SIDEBAR_SELECTOR), 'the exported selector finds it too');

    const shell = new Shell({
      entries: [entry({ id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig' })]
    });
    assert.equal(shell._mount(), true);
    assert.deepEqual(stub.sublist.children.map((a) => a.textContent),
      ['System', 'Outputs', 'LivePremier Plus']);
  } finally { g.document = prevDoc; g.window = prevWin; }
});

/*
 * Gating. A panel written against paths a switcher does not have belongs off
 * the sidebar, not on it and failing when opened.
 */
test('an entry that declines to be enabled is never mounted', async () => {
  await withDom(async ({ doc, sublist }) => {
    const { Shell } = await import('../src/ui/shell.js');
    const shell = new Shell({
      title: 'PLUS',
      entries: [
        entry({ id: 'vpu', label: 'VPU Map', enabled: () => false }),
        entry({ id: 'settings', label: 'LivePremier Plus', submenuOf: 'Preconfig', enabled: () => true })
      ]
    });
    shell._mount();
    assert.equal(doc.getElementById('wru-nav-vpu'), null);
    /* And with nothing left in it, our section is not created at all. */
    assert.equal(doc.getElementById('wru-nav-section'), null);
    assert.equal(sublist.children.length, 3, 'the enabled one still mounts');
  });
});

/*
 * The store arrives after the panels do, so everything is offered until it
 * lands and `remount` is what takes back whatever turns out not to apply.
 */
test('remount drops what the switcher turned out not to support', async () => {
  await withDom(async ({ doc, list }) => {
    const { Shell } = await import('../src/ui/shell.js');
    let known = false;
    const shell = new Shell({
      title: 'PLUS',
      entries: [entry({ id: 'vpu', label: 'VPU Map', enabled: () => !known })]
    });
    shell._mount();
    assert.ok(doc.getElementById('wru-nav-section'), 'offered while unknown');

    shell.show('vpu');
    assert.equal(shell.active, 'vpu');

    known = true;
    shell.remount();
    assert.equal(doc.getElementById('wru-nav-section'), null, 'and gone once known');
    assert.equal(shell.active, null, 'closing the panel it was showing');
    assert.equal(list.children.filter((c) => c.getAttribute('id') === 'wru-nav-section').length, 0);
  });
});
