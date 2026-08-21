/*
 * Adding tabs to the vendor's own tab strip.
 *
 * On Screens / Aux. the right-hand panel carries a Semantic-UI tab strip —
 * Properties, Memories — over a single content pane. This puts our own tabs on
 * the end of it, so Console and Timeline sit exactly where an operator already
 * looks for per-screen tools, rather than in a separate part of the app.
 *
 * The same discipline as `Shell`, for the same reasons:
 *
 *  - **Clone, never construct.** A tab is copied from a real one and rewritten,
 *    so whatever classes and padding this build uses, we inherit. The strip's
 *    own container carries a CSS-modules hash
 *    (`preset-setup-panels-container__c__tab___3L0xl`), so it is found by
 *    structure — the parent of the strip — and never by name.
 *  - **React owns this subtree** and re-renders it whenever the selection
 *    changes. A MutationObserver puts our tabs back rather than fighting
 *    reconciliation.
 *  - **Hide the vendor pane, do not float over it.** Its own layout keeps
 *    working and going back leaves scroll and focus where the operator left
 *    them.
 *
 * One thing that differs from the sidebar: the active class here is Semantic
 * UI's plain `active`, not a hashed one, because this strip is built from
 * Semantic UI rather than a CSS module. It is still read off a live tab rather
 * than assumed, on the chance that a future build wraps it.
 */

import { h, icon } from './dom.js';

/* The strip is Semantic UI's `ui tabular menu`. Structure is the fallback:
   a menu holding anchors that each contain a heading. */
const STRIP_SEL = '.ui.tabular.menu';
const OURS = 'data-lpp-tab';

export class TabHost {
  /**
   * @param {{tabs: Array<{id:string,label:string,icon:string,render:Function}>}} opts
   */
  constructor({ tabs = [] } = {}) {
    this.tabs = tabs;
    this.active = null;
    this.nodes = new Map();
    this._observer = null;
    this._pane = null;
  }

  start() {
    this._mount();
    this._observer = new MutationObserver(() => {
      /* Cheap guard: only look properly when our tabs are absent. */
      if (!document.querySelector(`[${OURS}]`)) this._mount();
    });
    const app = document.querySelector('.aw-app') || document.body;
    this._observer.observe(app, { childList: true, subtree: true });
  }

  stop() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
  }

  /** The vendor strip, if this page has one. */
  _strip() {
    const strip = document.querySelector(STRIP_SEL);
    if (strip && strip.querySelector('a')) return strip;
    return null;
  }

  /** The vendor's content pane: the strip's sibling that is not the strip. */
  _vendorPane(strip) {
    const parent = strip.parentElement;
    if (!parent) return null;
    return [...parent.children].find(
      (c) => c !== strip && !c.hasAttribute(OURS + '-pane')
    ) || null;
  }

  _mount() {
    const strip = this._strip();
    if (!strip) return false;
    if (strip.querySelector(`[${OURS}]`)) return true;

    /* Prefer an inactive tab as the template — an active one would drag its
       own state classes in, and stripping them is guesswork we can skip. */
    const anchors = [...strip.querySelectorAll('a')];
    const template = anchors.find((a) => !a.classList.contains('active')) || anchors[0];
    if (!template) return false;

    this.nodes.clear();
    for (const tab of this.tabs) {
      const node = this._cloneTab(template, tab);
      strip.append(node);
      this.nodes.set(tab.id, node);
    }

    /* Losing the pane on a re-render means the one we were showing is gone. */
    this._pane = null;
    if (this.active) this.show(this.active);
    else this._sync(strip);
    return true;
  }

  _cloneTab(template, tab) {
    const node = template.cloneNode(true);
    node.setAttribute(OURS, tab.id);
    node.classList.remove('active');
    node.removeAttribute('href');
    node.style.cursor = 'pointer';

    const label = node.querySelector('h5') || node;
    label.textContent = tab.label;

    const iconHost = node.querySelector('i.icon');
    if (iconHost && tab.icon) {
      const fresh = icon(tab.icon, iconHost.className.replace('icon', '').trim() || 'aw-block-medium');
      /* Keep the wrapper's own classes; only the glyph changes. */
      fresh.className = iconHost.className;
      iconHost.replaceWith(fresh);
    }

    node.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this.toggle(tab.id);
    });
    return node;
  }

  /** Our content pane, created next to the vendor's. */
  _ourPane(strip) {
    if (this._pane && this._pane.isConnected) return this._pane;
    const vendor = this._vendorPane(strip);
    const pane = h('div', { class: (vendor && vendor.className) || 'aw-full-height' });
    pane.setAttribute(OURS + '-pane', '');
    pane.style.minHeight = '0';
    if (vendor && vendor.parentElement) vendor.parentElement.append(pane);
    else strip.parentElement.append(pane);
    this._pane = pane;
    return pane;
  }

  toggle(id) { this.active === id ? this.hide() : this.show(id); }

  show(id) {
    const tab = this.tabs.find((t) => t.id === id);
    const strip = this._strip();
    if (!tab || !strip) return;

    this.active = id;
    const vendor = this._vendorPane(strip);
    if (vendor) {
      if (vendor.dataset.lppPrevDisplay === undefined) {
        vendor.dataset.lppPrevDisplay = vendor.style.display || '';
      }
      vendor.style.display = 'none';
    }

    const pane = this._ourPane(strip);
    pane.hidden = false;
    pane.textContent = '';
    pane.append(tab.render());
    this._sync(strip);
  }

  hide() {
    const strip = this._strip();
    this.active = null;
    if (this._pane) { this._pane.hidden = true; this._pane.textContent = ''; }
    if (strip) {
      const vendor = this._vendorPane(strip);
      if (vendor && vendor.dataset.lppPrevDisplay !== undefined) {
        vendor.style.display = vendor.dataset.lppPrevDisplay;
        delete vendor.dataset.lppPrevDisplay;
      }
      this._sync(strip);
    }
  }

  /**
   * Redraw the open tab.
   *
   * Scroll position is preserved the way `Shell.refresh` does it: the device
   * store is chatty and a repaint that jumped an operator's cue list back to
   * the top mid-show would be its own bug.
   */
  refresh() {
    if (this.active == null || !this._pane || !this._pane.isConnected) return;
    const tab = this.tabs.find((t) => t.id === this.active);
    if (!tab) return;
    const scroll = this._pane.querySelector('.wru-body');
    const top = scroll ? scroll.scrollTop : 0;
    this._pane.textContent = '';
    this._pane.append(tab.render());
    const again = this._pane.querySelector('.wru-body');
    if (again) again.scrollTop = top;
  }

  /**
   * Move the `active` class so exactly one tab looks selected.
   *
   * When one of ours is open the vendor's must be dimmed, and when the
   * operator goes back to a vendor tab ours must let go — including the case
   * where React re-rendered the strip and put its own active class back.
   */
  _sync(strip) {
    for (const [id, node] of this.nodes) {
      node.classList.toggle('active', this.active === id);
    }
    for (const a of strip.querySelectorAll('a')) {
      if (a.hasAttribute(OURS)) continue;
      if (this.active) a.classList.remove('active');
    }
  }
}

/**
 * Notice the operator clicking back to a vendor tab.
 *
 * Their tabs are React's, so we cannot hook their handlers; a capture-phase
 * listener sees the click first and lets go of the pane before React redraws
 * into it.
 */
export function watchVendorTabs(host, doc = document) {
  const onClick = (ev) => {
    const anchor = ev.target.closest && ev.target.closest('.ui.tabular.menu a');
    if (!anchor || anchor.hasAttribute(OURS)) return;
    if (host.active) host.hide();
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
