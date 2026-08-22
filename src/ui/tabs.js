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

/*
 * How much of a tab to show, widest first.
 *
 * The panel this strip lives in is about 360px on a 1280px window, and the
 * vendor's own two tabs already spend 243 of it. Ours were adding another 214
 * into what was left, so the strip ran out past the panel and underneath the
 * Transition column beside it — `flex-wrap: nowrap` and `overflow: visible`,
 * so nothing clipped it and nothing scrolled.
 *
 * Rather than pick a look and hope, each rung is tried in turn and the first
 * one that fits wins. That way a wide window keeps the full labels and a
 * narrow one degrades on its own, with no breakpoint to maintain against a
 * panel whose width we do not control.
 *
 *   full   icon + full label      Console        105px
 *   label  full label, no icon    Console         77px
 *   short  short label, no icon   Cmd             51px
 *   icon   icon only, tooltip     ▤               40px
 *
 * The vendor's tabs are never touched. They are the operator's landmarks and
 * they are not the reason the strip overflows.
 */
const MODES = ['full', 'label', 'short', 'icon'];

export class TabHost {
  /**
   * @param {{tabs: Array<{id:string,label:string,short?:string,icon:string,render:Function}>}} opts
   *
   * `short` is the label to fall back to when the strip will not fit the full
   * one. Without it the full label is used at every rung, which simply means
   * this tab reaches the icon-only rung sooner.
   */
  constructor({ tabs = [] } = {}) {
    this.tabs = tabs;
    this.active = null;
    this.nodes = new Map();
    this._observer = null;
    this._pane = null;
    /* Which rung of MODES is currently showing, for tests and for anyone
       wondering why the labels went away. */
    this.mode = MODES[0];
    this._resize = null;
    this._resizeHost = null;
    this._lastRoom = null;
  }

  start() {
    this._mount();
    this._observer = new MutationObserver(() => {
      /* Cheap guard: only look properly when our tabs are absent — and only
         when there is one we would actually mount. */
      if (document.querySelector(`[${OURS}]`)) return;
      if (this.tabs.some((t) => (t.enabled ? t.enabled() !== false : true))) this._mount();
    });
    const app = document.querySelector('.aw-app') || document.body;
    this._observer.observe(app, { childList: true, subtree: true });
  }

  stop() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    if (this._resize) { this._resize.disconnect(); this._resize = null; this._resizeHost = null; }
  }

  /**
   * The vendor strip, if this page has one *of the right kind*.
   *
   * `.ui.tabular.menu` is not unique to the per-screen panel: Preconfig heads
   * its page with a strip built from the same Semantic UI classes. That one is
   * **page navigation** — every anchor is an `href` to another route, and the
   * items are icons with no text. Appending Console and Timeline to it put two
   * words in a row of glyphs, on a page they have nothing to do with, and
   * clicking one hid a pane belonging to a different screen.
   *
   * So a strip qualifies only if it holds a **pane switcher**: an anchor with
   * a heading and no `href`. That is the structural difference between "these
   * tabs change what is shown here" and "these links go somewhere else", and
   * it does not depend on a class name, a route or a label.
   */
  _strip() {
    for (const strip of document.querySelectorAll(STRIP_SEL)) {
      if (this._switchers(strip).length) return strip;
    }
    return null;
  }

  /** The vendor's own pane-switching tabs in a strip, ours excluded. */
  _switchers(strip) {
    return [...strip.querySelectorAll('a')].filter(
      (a) => !a.hasAttribute(OURS) && !a.hasAttribute('href') && a.querySelector('h5'));
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
    const anchors = this._switchers(strip);
    const template = anchors.find((a) => !a.classList.contains('active')) || anchors[0];
    if (!template) return false;

    this.nodes.clear();
    /* A tab can decline to be mounted, the same way a sidebar entry can: a
       panel written against paths this switcher does not have belongs off the
       strip rather than on it and broken. See `core/platform.js`. */
    for (const tab of this.tabs.filter((t) => (t.enabled ? t.enabled() !== false : true))) {
      const node = this._cloneTab(template, tab);
      strip.append(node);
      this.nodes.set(tab.id, node);
    }

    /* Losing the pane on a re-render means the one we were showing is gone. */
    this._pane = null;
    if (this.active) this.show(this.active);
    else this._sync(strip);

    this._fit();
    this._watchWidth(strip);
    return true;
  }

  /**
   * Show as much of each tab as the strip has room for.
   *
   * Measured, not guessed: each rung of `MODES` is applied and the strip is
   * asked how wide it came out. The first that fits inside the panel wins; if
   * none do, the narrowest stands, because a tab that is hard to read is still
   * better than one that has been taken away.
   *
   * `scrollWidth` rather than a bounding rect, because it reports the content
   * width whether or not anything is clipping it — and today nothing is.
   */
  _fit(strip = this._strip()) {
    if (!strip || !this.nodes.size) return;
    const host = strip.parentElement;
    const room = host && host.clientWidth;
    /* Not laid out yet — a zero-width panel would send every tab straight to
       icon-only and leave it there. Wait to be asked again. */
    if (!room) return;
    this._lastRoom = room;

    for (const mode of MODES) {
      this._applyMode(mode);
      if (strip.scrollWidth <= room) { this.mode = mode; return; }
    }
    this.mode = MODES[MODES.length - 1];
  }

  /** Put every one of our tabs into one rung. */
  _applyMode(mode) {
    for (const tab of this.tabs) {
      const node = this.nodes.get(tab.id);
      if (!node) continue;
      const glyph = node.querySelector('i.icon');
      const label = node.querySelector('h5');
      if (glyph) glyph.style.display = mode === 'full' || mode === 'icon' ? '' : 'none';
      if (label) {
        label.style.display = mode === 'icon' ? 'none' : '';
        label.textContent = mode === 'short' ? (tab.short || tab.label) : tab.label;
      }
      /* The full name is always one hover away, which is what makes the
         icon-only rung honest rather than a guessing game. */
      node.setAttribute('title', tab.label);
    }
  }

  /**
   * Re-fit when the panel changes width.
   *
   * A window resize is the obvious case, but not the only one — collapsing the
   * Sources column widens this panel without the window moving at all, and a
   * `resize` listener would sleep through it. So the panel itself is watched.
   *
   * Guarded on the width actually having changed: `_fit` writes to the strip,
   * and a ResizeObserver that reacts to its own effects is how you get the
   * "loop completed with undelivered notifications" warning.
   */
  _watchWidth(strip) {
    const host = strip.parentElement;
    if (!host || typeof ResizeObserver !== 'function') return;
    if (this._resizeHost === host && this._resize) return;
    if (this._resize) this._resize.disconnect();
    this._resizeHost = host;
    this._resize = new ResizeObserver(() => {
      if (host.clientWidth === this._lastRoom) return;
      this._fit();
    });
    this._resize.observe(host);
  }

  _cloneTab(template, tab) {
    const node = template.cloneNode(true);
    node.setAttribute(OURS, tab.id);
    node.classList.remove('active');
    node.removeAttribute('href');
    node.style.cursor = 'pointer';

    /* The label has to be its own element, because `_applyMode` shows and
       hides it independently of the icon. A template without a heading would
       otherwise mean writing the label onto the anchor itself, wiping the icon
       out and leaving nothing for the fit ladder to shrink. */
    let label = node.querySelector('h5');
    if (!label) {
      label = h('h5');
      node.replaceChildren(...[node.querySelector('i.icon'), label].filter(Boolean));
    }
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

  /**
   * Take our tabs off the strip and put back the ones that still apply.
   *
   * Called once the device store has arrived, which is the first moment
   * `enabled()` can answer honestly.
   */
  remount() {
    const strip = this._strip();
    const tab = this.tabs.find((t) => t.id === this.active);
    if (tab && tab.enabled && tab.enabled() === false) this.hide();
    if (strip) for (const node of strip.querySelectorAll(`[${OURS}]`)) node.remove();
    this.nodes.clear();
    this._mount();
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
