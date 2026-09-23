/*
 * Just enough DOM to render the panels under Node.
 *
 * This repo has no dependencies, so no jsdom. The panels only *build* DOM —
 * `h()` in `ui/dom.js` — and read a little of it back, so this covers exactly
 * that: elements, text, attributes, classes, styles, events, and a selector
 * engine for the simple selectors panels use (`tag`, `.class`, `#id`,
 * `[attr]`, `[attr="value"]`, compounds of those, descendant and `>` child
 * combinators, and comma lists). No layout: every rectangle is empty.
 *
 * `install()` puts `document`, `window`, `Node` and friends on the global
 * object and returns an `uninstall()` that puts back whatever was there.
 */

class FakeNode {
  constructor(doc) {
    this.ownerDocument = doc;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() { return this.parentNode instanceof FakeElement ? this.parentNode : null; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === this.ownerDocument;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] || null;
  }
  remove() {
    if (!this.parentNode) return;
    const kids = this.parentNode.childNodes;
    kids.splice(kids.indexOf(this), 1);
    this.parentNode = null;
  }
  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const i = parent.childNodes.indexOf(this);
    this.remove();
    parent._insertAt(i, nodes);
  }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  _adopt(child) {
    const node = child instanceof FakeNode ? child : this.ownerDocument.createTextNode(String(child));
    if (node.parentNode) node.remove();
    node.parentNode = this;
    return node;
  }
  _insertAt(index, nodes) {
    const adopted = nodes.filter((n) => n != null).map((n) => this._adopt(n));
    this.childNodes.splice(index, 0, ...adopted);
  }
  append(...nodes) { this._insertAt(this.childNodes.length, nodes); }
  prepend(...nodes) { this._insertAt(0, nodes); }
  appendChild(node) { this.append(node); return node; }
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this._insertAt(i < 0 ? this.childNodes.length : i, [node]);
    return node;
  }
  removeChild(node) { node.remove(); return node; }
  replaceChildren(...nodes) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' || v == null ? [] : [String(v)])); }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.data = String(text); this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new FakeText(this.ownerDocument, this.data); }
}

class FakeClassList {
  constructor(el) { this.el = el; }
  get _set() { return new Set(this.el.className.split(/\s+/).filter(Boolean)); }
  _write(set) { this.el.className = [...set].join(' '); }
  add(...c) { const s = this._set; c.forEach((x) => s.add(x)); this._write(s); }
  remove(...c) { const s = this._set; c.forEach((x) => s.delete(x)); this._write(s); }
  contains(c) { return this._set.has(c); }
  toggle(c, force) {
    const s = this._set;
    const on = force === undefined ? !s.has(c) : Boolean(force);
    if (on) s.add(c); else s.delete(c);
    this._write(s);
    return on;
  }
  [Symbol.iterator]() { return this._set[Symbol.iterator](); }
}

class FakeElement extends FakeNode {
  constructor(doc, tag, ns = null) {
    super(doc);
    this.nodeType = 1;
    this.tagName = ns ? tag : tag.toUpperCase();
    this.localName = tag.toLowerCase();
    this.namespaceURI = ns;
    this.attributes = new Map();
    this.style = { setProperty(k, v) { this[k] = v; }, removeProperty(k) { delete this[k]; } };
    this.dataset = {};
    this._listeners = {};
    this.classList = new FakeClassList(this);
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this._value = null;
  }
  get className() { return this.attributes.get('class') ?? ''; }
  set className(v) { this.attributes.set('class', String(v)); }
  get id() { return this.attributes.get('id') ?? ''; }
  set id(v) { this.attributes.set('id', String(v)); }
  get children() { return this.childNodes.filter((c) => c instanceof FakeElement); }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0] || null; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = v; }

  /* Form controls: the property follows the attribute until something writes it. */
  get value() {
    if (this._value != null) return this._value;
    if (this.tagName === 'SELECT') {
      const opts = this.querySelectorAll('option');
      const picked = opts.find((o) => o.hasAttribute('selected')) || opts[0];
      return picked ? picked.value : '';
    }
    if (this.tagName === 'OPTION' && !this.hasAttribute('value')) return this.textContent;
    return this.attributes.get('value') ?? (this.tagName === 'TEXTAREA' ? this.textContent : '');
  }
  set value(v) { this._value = String(v); }
  get defaultValue() { return this.attributes.get('value') ?? ''; }
  get type() { return this.attributes.get('type') ?? (this.tagName === 'INPUT' ? 'text' : ''); }
  set type(v) { this.attributes.set('type', String(v)); }
  get selectionStart() { return this.value.length; }
  get selectionEnd() { return this.value.length; }
  setSelectionRange() {}
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  click() { this.dispatchEvent({ type: 'click', target: this }); }
  select() {}

  setAttribute(k, v) {
    if (k === 'class') { this.className = v; return; }
    this.attributes.set(k, String(v));
  }
  setAttributeNS(_ns, k, v) { this.setAttribute(k, v); }
  getAttribute(k) { return this.attributes.has(k) ? this.attributes.get(k) : null; }
  hasAttribute(k) { return this.attributes.has(k); }
  removeAttribute(k) { this.attributes.delete(k); }
  toggleAttribute(k, force) {
    const on = force === undefined ? !this.hasAttribute(k) : Boolean(force);
    if (on) this.setAttribute(k, ''); else this.removeAttribute(k);
    return on;
  }

  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    this._listeners[type] = (this._listeners[type] || []).filter((f) => f !== fn);
  }
  dispatchEvent(ev) {
    const event = { bubbles: false, preventDefault() {}, stopPropagation() {}, ...ev, target: ev.target || this };
    for (let n = this; n; n = event.bubbles ? n.parentNode : null) {
      for (const fn of (n._listeners && n._listeners[event.type]) || []) fn.call(n, event);
      if (!event.bubbles) break;
    }
    return true;
  }

  getBoundingClientRect() { return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getClientRects() { return []; }
  scrollIntoView() {}
  animate() { return { cancel() {}, finished: Promise.resolve() }; }

  cloneNode(deep = false) {
    const copy = new FakeElement(this.ownerDocument, this.localName, this.namespaceURI);
    for (const [k, v] of this.attributes) copy.attributes.set(k, v);
    if (deep) for (const c of this.childNodes) copy.append(c.cloneNode(true));
    return copy;
  }

  matches(selector) { return parseList(selector).some((chain) => matchChain(this, chain)); }
  closest(selector) {
    for (let n = this; n instanceof FakeElement; n = n.parentNode) if (n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector) {
    const chains = parseList(selector);
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (chains.some((chain) => matchChain(c, chain))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementsByTagName(tag) { return this.querySelectorAll(tag); }
}

/* ------------------------------------------------------------- selectors */

/** "a b, c > d" → [[{compound, combinator}...], ...] */
function parseList(selector) {
  return String(selector).split(',').map((s) => parseChain(s.trim())).filter((c) => c.length);
}

function parseChain(text) {
  const parts = [];
  let combinator = ' ';
  const tokens = text.replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
  for (const t of tokens) {
    if (t === '>') { combinator = '>'; continue; }
    parts.push({ compound: parseCompound(t), combinator });
    combinator = ' ';
  }
  return parts;
}

function parseCompound(t) {
  const c = { tag: null, id: null, classes: [], attrs: [], not: [] };
  const re = /(^[a-zA-Z*][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([*^$]?=)["']?([^"'\]]*)["']?)?\]|:not\(([^)]+)\)|:scope|:[\w-]+(?:\([^)]*\))?/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) c.tag = m[1] === '*' ? null : m[1].toUpperCase();
    else if (m[2]) c.id = m[2];
    else if (m[3]) c.classes.push(m[3]);
    else if (m[4]) c.attrs.push({ name: m[4], op: m[5] || null, value: m[6] ?? null });
    else if (m[7]) c.not.push(parseCompound(m[7]));
  }
  return c;
}

function matchCompound(el, c) {
  if (c.tag && el.tagName.toUpperCase() !== c.tag) return false;
  if (c.id && el.id !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const a of c.attrs) {
    if (!el.hasAttribute(a.name)) return false;
    const v = el.getAttribute(a.name);
    if (a.op === '=' && v !== a.value) return false;
    if (a.op === '*=' && !v.includes(a.value)) return false;
    if (a.op === '^=' && !v.startsWith(a.value)) return false;
    if (a.op === '$=' && !v.endsWith(a.value)) return false;
  }
  for (const n of c.not) if (matchCompound(el, n)) return false;
  return true;
}

function matchChain(el, chain, i = chain.length - 1) {
  if (!matchCompound(el, chain[i].compound)) return false;
  if (i === 0) return true;
  const how = chain[i].combinator;
  if (how === '>') return el.parentElement ? matchChain(el.parentElement, chain, i - 1) : false;
  for (let p = el.parentElement; p; p = p.parentElement) if (matchChain(p, chain, i - 1)) return true;
  return false;
}

/* -------------------------------------------------------------- document */

class FakeDocument extends FakeNode {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.nodeType = 9;
    this.documentElement = new FakeElement(this, 'html');
    this.head = new FakeElement(this, 'head');
    this.body = new FakeElement(this, 'body');
    this.documentElement.append(this.head, this.body);
    this.childNodes = [this.documentElement];
    this.documentElement.parentNode = this;
    this.activeElement = this.body;
    this.hidden = false;
    this._listeners = {};
    this.styleSheets = [];
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createElementNS(ns, tag) { return new FakeElement(this, tag, ns); }
  createTextNode(text) { return new FakeText(this, text); }
  createDocumentFragment() { return new FakeElement(this, '#fragment'); }
  getElementById(id) { return this.documentElement.querySelector(`#${id}`); }
  querySelectorAll(s) { return this.documentElement.querySelectorAll(s); }
  querySelector(s) { return this.documentElement.querySelector(s); }
  addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); }
  removeEventListener() {}
  dispatchEvent() { return true; }
  hasFocus() { return true; }
}

/**
 * Put a fresh fake DOM on the global object. Returns it, with `uninstall()` to
 * put back whatever the globals were before.
 */
export function install() {
  const doc = new FakeDocument();
  const g = globalThis;
  const names = ['document', 'window', 'Node', 'Element', 'HTMLElement', 'HTMLInputElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'Text', 'requestAnimationFrame', 'EventSource',
    'MutationObserver', 'ResizeObserver', 'getComputedStyle', 'location', 'localStorage'];
  const before = Object.fromEntries(names.map((n) => [n, Object.getOwnPropertyDescriptor(g, n)]));

  const listeners = {};
  const win = {
    document: doc,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent(ev) { for (const fn of listeners[ev.type] || []) fn(ev); return true; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    open: () => null,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { pathname: '/', search: '', hash: '', href: 'http://127.0.0.1/', origin: 'http://127.0.0.1' },
    innerWidth: 1920,
    innerHeight: 1080
  };
  const set = (k, v) => Object.defineProperty(g, k, { value: v, configurable: true, writable: true });
  set('document', doc);
  set('window', win);
  set('Node', FakeNode);
  set('Element', FakeElement);
  set('HTMLElement', FakeElement);
  set('HTMLInputElement', FakeElement);
  set('HTMLSelectElement', FakeElement);
  set('HTMLTextAreaElement', FakeElement);
  set('Text', FakeText);
  set('requestAnimationFrame', (fn) => setTimeout(() => fn(Date.now()), 0));
  set('EventSource', class { constructor() {} addEventListener() {} close() {} });
  set('MutationObserver', class { observe() {} disconnect() {} });
  set('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  set('getComputedStyle', win.getComputedStyle);
  set('location', win.location);
  set('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });

  return {
    doc,
    window: win,
    uninstall() {
      for (const [k, d] of Object.entries(before)) {
        if (d) Object.defineProperty(g, k, d);
        else delete g[k];
      }
    }
  };
}
