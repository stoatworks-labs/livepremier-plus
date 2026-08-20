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

export class Shell {
  /**
   * @param {{title:string, entries:Array<{id:string,label:string,icon:string,render:Function}>}} opts
   */
  constructor({ title = 'Unleashed', entries = [] } = {}) {
    this.title = title;
    this.entries = entries;
    this.active = null;
    this.nav = new Map();
    this._observer = null;
    this._activeClasses = { title: [], link: [] };
  }

  start() {
    installStyles();
    this._mount();
    /* React re-renders the sidebar on navigation; put it back when it does. */
    this._observer = new MutationObserver(() => {
      if (!document.getElementById('wru-nav-section')) this._mount();
    });
    const row = document.querySelector('.aw-app');
    if (row) this._observer.observe(row, { childList: true, subtree: true });

    /* Any stock navigation means the operator has left our panel. */
    document.addEventListener('click', (ev) => {
      const link = ev.target.closest && ev.target.closest('a[href]');
      if (link && !link.closest('#wru-nav-section') && !link.closest('#wru-overlay')) this.hide();
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
    if (!list || document.getElementById('wru-nav-section')) return true;

    this._captureActiveClasses(sidebar);

    const section = h('div', { id: 'wru-nav-section' });
    section.append(this._cloneSeparator(anySeparator, this.title));
    for (const entry of this.entries) {
      const node = this._cloneMenu(anyMenu, entry);
      section.append(node);
      this.nav.set(entry.id, node);
    }
    list.append(section);
    this._syncNav();
    return true;
  }

  /**
   * Read the active-state class names off whichever item is active now.
   *
   * They are hashed like everything else, and there is no other way to make
   * our entries highlight identically to the vendor's.
   */
  _captureActiveClasses(sidebar) {
    const activeTitle = sidebar.querySelector('[class*="menu__title--active___"]');
    if (!activeTitle) return;
    const classes = [...activeTitle.classList];
    this._activeClasses.title = classes.filter((c) => c.includes('--active___'));
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
      const link = node.querySelector(TITLE_SEL) || node.querySelector('a');
      if (!link) continue;
      const on = this.active === id;
      for (const c of this._activeClasses.title) link.classList.toggle(c, on);
      if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
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
