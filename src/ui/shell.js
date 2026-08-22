/*
 * Getting into the vendor UI without looking like a guest.
 *
 * Two problems, one answer.
 *
 * The look: Web RCS is built with CSS modules, so every component class name
 * carries a per-build hash - `sidebar-module__c__menu___1sHvq` today, some
 * other suffix after the next firmware. Hard-coding those would produce an
 * extension that renders correctly on exactly one release. So nothing is
 * hard-coded: the sidebar entries are *cloned from a real one* at runtime and
 * then rewritten. Whatever hashes this build uses, we inherit them, including
 * the active-state classes, which are lifted off whichever item is currently
 * active.
 *
 * The lifecycle: the sidebar is React's, and React may re-render it out from
 * under us at any moment. Rather than fight reconciliation, a MutationObserver
 * watches the menu container and re-inserts the section whenever it goes
 * missing. Cheap, and it survives route changes.
 *
 * The panel itself is a flex sibling of the main content area, shown by
 * hiding that area rather than by floating over it - so the app's own layout
 * keeps working, and scroll position and focus behave the way the operator
 * expects when they switch back.
 */

import { h, icon } from './dom.js';
import { installStyles } from './theme.js';

const SIDEBAR_SEL = '[class*="sidebar-module__c___"]';
const MENU_SEL = '[class*="sidebar-module__c__menu___"]';
const SEPARATOR_SEL = '[class*="sidebar-module__c__separator___"]';
const LABEL_SEL = '[class*="sidebar-module__c__menu__title__label___"]';
const TITLE_SEL = '[class*="sidebar-module__c__menu__title___"]';
/* Preconfig is the one sidebar item with a flyout of its own: a list of
   `<a>` items, each a route under /preconfig. */
const SUBLIST_SEL = '[class*="sidebar-module__c__submenu__list___"]';
const SUBITEM_SEL = '[class*="sidebar-module__c__submenu__list__item___"]';
/* Put on every link we create, so the "operator navigated away" listener can
   tell one of ours from the vendor's wherever it happens to sit. */
const NAV_MARK = 'data-lpp-nav';

/**
 * Find a hashed class name by its stable middle, in the page's own stylesheets.
 *
 * CSS-modules names are `<module>__<part>___<hash>`; only the hash moves
 * between builds. When no element on the page is currently wearing the class
 * there is nowhere else to read it from — and a proxied page is same-origin,
 * so `cssRules` is legible. Cross-origin sheets throw on access; skip them
 * rather than let one abort the search.
 */
export function classFromStylesheets(fragment, doc = document) {
  const re = new RegExp('\\.([A-Za-z0-9_-]*' + fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[A-Za-z0-9_-]*)');
  for (const sheet of doc.styleSheets || []) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const rule of rules || []) {
      const hit = rule.selectorText && re.exec(rule.selectorText);
      if (hit) return hit[1];
    }
  }
  return null;
}

export class Shell {
  /**
   * @param {{title:string, entries:Array<{id:string,label:string,icon:string,render:Function,after?:string,submenuOf?:string}>}} opts
   *
   * Three placements, in the order a reader will meet them:
   *
   * - No hint at all: the entry goes in our own section at the bottom of the
   *   sidebar, under `title`.
   * - `after: '<vendor label>'` puts it directly beneath that vendor item, in
   *   the vendor's own section. That is for a tool that belongs to an existing
   *   part of the app — MIDI Mapping sits under Virtual RC400T because both
   *   are about control surfaces, and a PLUS section at the bottom would file
   *   it by who wrote it rather than by what it does.
   * - `submenuOf: '<vendor label>'` puts it *inside* that item's flyout, at
   *   the end of the list. Only Preconfig has one, and app-wide settings
   *   belong beside the device's own System page for the same reason.
   */
  constructor({ title = 'Unleashed', entries = [] } = {}) {
    this.title = title;
    this.entries = entries;
    this.active = null;
    this.nav = new Map();
    /* For a submenu entry: the vendor menu item whose flyout it sits in, so
       that opening ours lights its parent up the way a vendor page does. */
    this._parents = new Map();
    this._observer = null;
    this._activeClasses = { title: [], sub: [] };
  }

  start() {
    installStyles();
    this._mount();
    /* React re-renders the sidebar on navigation; put it back when it does.
       Both placements are checked — an anchored entry can be lost on its own
       when the vendor section it sits in re-renders. */
    this._observer = new MutationObserver(() => {
      const sectioned = this.entries.some((e) => !e.after && !e.submenuOf);
      if (sectioned && !document.getElementById('wru-nav-section')) return this._mount();
      for (const entry of this.entries) {
        if ((entry.after || entry.submenuOf) && !document.getElementById('wru-nav-' + entry.id)) return this._mount();
      }
    });
    const row = document.querySelector('.aw-app');
    if (row) this._observer.observe(row, { childList: true, subtree: true });

    /* Any stock navigation means the operator has left our panel. Our own
       entries are excluded by the marker rather than by where they sit: a
       submenu entry of ours lives inside the vendor's own flyout, so there is
       no ancestor of ours to test for. */
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest && ev.target.closest('a[href]');
      if (link && !link.hasAttribute(NAV_MARK) && !link.closest('#wru-nav-section') && !link.closest('#wru-overlay')) this.hide();
    }, true);
    window.addEventListener('popstate', () => this.hide());
  }

  _mount() {
    const sidebar = document.querySelector(SIDEBAR_SEL);
    if (!sidebar) return false;
    const anyMenu = sidebar.querySelector(MENU_SEL);
    const anySeparator = sidebar.querySelector(SEPARATOR_SEL);
    if (!anyMenu) return false;
    const list = anyMenu.parentElement;
    if (!list) return false;

    this._captureActiveClasses(sidebar);

    const anchored = this.entries.filter((e) => e.after);
    const nested = this.entries.filter((e) => e.submenuOf);
    const sectioned = this.entries.filter((e) => !e.after && !e.submenuOf);

    for (const entry of anchored) {
      if (document.getElementById('wru-nav-' + entry.id)) continue;
      const host = this._itemByLabel(sidebar, entry.after);
      if (!host) continue;   /* that page may not exist on this device */
      const node = this._cloneMenu(anyMenu, entry);
      node.id = 'wru-nav-' + entry.id;
      host.after(node);
      this.nav.set(entry.id, node);
    }

    for (const entry of nested) {
      if (document.getElementById('wru-nav-' + entry.id)) continue;
      const host = this._itemByLabel(sidebar, entry.submenuOf);
      const sublist = host && host.querySelector(SUBLIST_SEL);
      /* No flyout means this build files that page differently; the entry is
         dropped rather than invented somewhere it does not belong. */
      if (!sublist) continue;
      const template = sublist.querySelector(SUBITEM_SEL);
      if (!template) continue;
      const node = this._cloneSubItem(template, entry);
      node.id = 'wru-nav-' + entry.id;
      sublist.append(node);
      this.nav.set(entry.id, node);
      this._parents.set(entry.id, host);
    }

    if (sectioned.length && !document.getElementById('wru-nav-section')) {
      const section = h('div', { id: 'wru-nav-section' });
      section.append(this._cloneSeparator(anySeparator, this.title));
      for (const entry of sectioned) {
        const node = this._cloneMenu(anyMenu, entry);
        section.append(node);
        this.nav.set(entry.id, node);
      }
      list.append(section);
    }

    this._syncNav();
    return true;
  }

  /**
   * Find a vendor menu item by its visible label.
   *
   * Matched on text rather than on any class or href, because the label is the
   * only part of that markup the vendor has not hashed — and it is what the
   * caller named it by.
   */
  _itemByLabel(sidebar, label) {
    const wanted = String(label).trim().toLowerCase();
    for (const item of sidebar.querySelectorAll(MENU_SEL)) {
      const el = item.querySelector(LABEL_SEL);
      const text = (el ? el.textContent : item.textContent).trim().toLowerCase();
      if (text === wanted) return item;
    }
    return null;
  }

  /**
   * Read the active-state class names off whichever item is active now.
   *
   * They are hashed like everything else, and there is no other way to make
   * our entries highlight identically to the vendor's.
   */
  _captureActiveClasses(sidebar) {
    const activeTitle = sidebar.querySelector('[class*="menu__title--active___"]');
    if (activeTitle) {
      this._activeClasses.title = [...activeTitle.classList].filter((c) => c.includes('--active___'));
    }
    /*
     * The flyout's active class cannot be lifted off a live element the way
     * the title's can: it only exists while the operator is on a page inside
     * that flyout, and they may never go to one. So it is read out of the
     * vendor's own stylesheet instead — same source, no waiting.
     */
    if (!this._activeClasses.sub.length) {
      const activeSub = sidebar.querySelector('[class*="submenu__list__item--active___"]');
      if (activeSub) {
        this._activeClasses.sub = [...activeSub.classList].filter((c) => c.includes('--active___'));
      } else {
        const fromCss = classFromStylesheets('submenu__list__item--active___');
        if (fromCss) this._activeClasses.sub = [fromCss];
      }
    }
  }

  _cloneSeparator(template, text) {
    if (!template) {
      return h('div', { class: 'aw-font-overline aw-text-secondary aw-padding-vertical-small aw-padding-horizontal-big aw-margin-top-big', text });
    }
    const node = template.cloneNode(true);
    /* The padding and type live on an inner title element, not on the
       separator itself - writing to the wrapper loses both and the heading
       ends up flush against the edge while the vendor's are indented. */
    const title = node.querySelector('[class*="separator__title___"]') || node;
    title.textContent = text;
    return node;
  }

  _cloneMenu(template, entry) {
    const node = template.cloneNode(true);
    node.removeAttribute('id');

    /* A cloned item may carry the active state of the item it was copied
       from; strip it, then let _syncNav decide. */
    const link = node.querySelector(TITLE_SEL) || node.querySelector('a');
    if (link) {
      for (const c of [...link.classList]) if (c.includes('--active___')) link.classList.remove(c);
      link.setAttribute(NAV_MARK, '');
      link.setAttribute('href', '#' + entry.id);
      link.removeAttribute('aria-current');
      link.addEventListener('click', (ev) => { ev.preventDefault(); this.toggle(entry.id); });
    }

    const label = node.querySelector(LABEL_SEL);
    if (label) label.textContent = entry.label;

    const iconHost = node.querySelector('i.icon');
    if (iconHost && entry.icon) {
      const fresh = icon(entry.icon, iconHost.className.replace('icon', '').trim() || 'aw-block-huge');
      iconHost.replaceWith(fresh);
    }

    /* Anything beside the title link is that item's submenu - a clone of
       Preconfig would otherwise drag its whole tree along with it. */
    if (link) node.replaceChildren(link);

    return node;
  }

  /**
   * A flyout item, cloned from one of the vendor's own.
   *
   * Simpler than a menu item — no icon, no submenu of its own, just an anchor
   * carrying text — but the same rule applies: the padding and the type scale
   * live in a hashed class, so copy the element rather than build one.
   */
  _cloneSubItem(template, entry) {
    const node = template.cloneNode(true);
    node.removeAttribute('id');
    node.removeAttribute('aria-current');
    for (const c of [...node.classList]) if (c.includes('--active___')) node.classList.remove(c);
    node.setAttribute(NAV_MARK, '');
    node.setAttribute('href', '#' + entry.id);
    node.textContent = entry.label;
    node.addEventListener('click', (ev) => { ev.preventDefault(); this.toggle(entry.id); });
    return node;
  }

  toggle(id) { this.active === id ? this.hide() : this.show(id); }

  show(id) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    this.active = id;
    const overlay = this._overlay();
    overlay.hidden = false;
    const main = this._mainContent();
    if (main) { main.dataset.wruPrevDisplay = main.style.display || ''; main.style.display = 'none'; }
    overlay.textContent = '';
    overlay.append(entry.render());
    this._syncNav();
  }

  hide() {
    if (this.active == null) return;
    this.active = null;
    const overlay = document.getElementById('wru-overlay');
    if (overlay) { overlay.hidden = true; overlay.textContent = ''; }
    const main = this._mainContent();
    if (main) { main.style.display = main.dataset.wruPrevDisplay || ''; delete main.dataset.wruPrevDisplay; }
    this._syncNav();
  }

  /** Ask the visible panel to redraw, if it is one of ours. */
  refresh() {
    if (this.active == null) return;
    const entry = this.entries.find((e) => e.id === this.active);
    const overlay = document.getElementById('wru-overlay');
    if (!entry || !overlay) return;
    const scroll = overlay.querySelector('.wru-body');
    const top = scroll ? scroll.scrollTop : 0;
    overlay.textContent = '';
    overlay.append(entry.render());
    const again = overlay.querySelector('.wru-body');
    if (again) again.scrollTop = top;
  }

  _syncNav() {
    for (const [id, node] of this.nav) {
      const on = this.active === id;
      const nested = this._parents.has(id);
      /* A flyout item IS the anchor; a menu item wraps one. */
      const link = nested ? node : (node.querySelector(TITLE_SEL) || node.querySelector('a'));
      if (!link) continue;
      for (const c of (nested ? this._activeClasses.sub : this._activeClasses.title)) link.classList.toggle(c, on);
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');

      /*
       * Opening a flyout entry also lights its parent, because that is what
       * the vendor does for every page in the flyout and the operator reads
       * the sidebar for "where am I". Only ever turned ON here: the vendor's
       * router owns that class the rest of the time, and clearing it when one
       * of ours closes would blank a highlight React had put there for a page
       * that is genuinely open.
       */
      const parent = this._parents.get(id);
      const title = parent && (parent.querySelector(TITLE_SEL) || parent.querySelector('a'));
      if (on && title) for (const c of this._activeClasses.title) title.classList.add(c);
    }
  }

  _mainContent() {
    const app = document.querySelector('.aw-app');
    const row = app && app.children[1];
    if (!row) return null;
    return [...row.children].find(
      (c) => c.id !== 'wru-overlay' && c.classList.contains('aw-flex-item')
    ) || null;
  }

  _overlay() {
    let overlay = document.getElementById('wru-overlay');
    if (overlay) return overlay;
    const app = document.querySelector('.aw-app');
    const row = app && app.children[1];
    overlay = h('div', { id: 'wru-overlay', class: 'wru-overlay aw-flex-item aw-min-width-0', hidden: 'hidden' });
    overlay.style.position = 'relative';
    if (row) row.append(overlay);
    return overlay;
  }
}

/** Standard panel frame: a fixed toolbar over a scrolling body. */
export function panel({ toolbar, body }) {
  return h('div', { class: 'wru-overlay-inner aw-flex-col aw-full-height', style: { height: '100%' } },
    h('div', { class: 'wru-topbar' }, toolbar),
    h('div', { class: 'wru-body' }, body));
}
