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
import { captureFocus, restoreFocus, trackFields } from './keep-focus.js';

/* The strip is Semantic UI's `ui tabular menu`. Structure is the fallback:
   a menu holding anchors that each carry a label and switch a pane. */
const STRIP_SEL = '.ui.tabular.menu';
const OURS = 'data-lpp-tab';
/* Marks the label element inside one of our tabs when the vendor's own tab
   has no heading element to clone — see `_labelOf`. */
const LABEL = 'data-lpp-label';

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
 *   more   as many icons as fit,  ▤ ⋯
 *          the rest behind ⋯
 *
 * The last rung is the one LivePremier actually lands on. Up to seven plugins
 * have a tab here now (Console, Timeline, Layer, Groups, Pixel Map, Surfaces,
 * UMD), and on Web RCS 6.2.73 the
 * strip has about 312px: the panel is a fixed 360px whatever the window, the
 * vendor centres the strip in it, and its own collapse button `»` takes the
 * right-hand 24px — so 24px is lost at each side. Properties and Memories
 * spend 244 of that, which leaves room for one icon, and the icon rung ran
 * 426px wide: off both sides of the panel and under the `»` (measured
 * 2026-10-16 at 1280×800). Behind ⋯ every tab stays one click away.
 *
 * The vendor's tabs are never touched. They are the operator's landmarks and
 * they are not the reason the strip overflows.
 */
const MODES = ['full', 'label', 'short', 'icon', 'more'];
/* Marks the ⋯ tab, which is ours (it carries OURS too) but is not a tab. */
const MORE = 'data-lpp-more';
/* The sprite's horizontal ellipsis, as Send to uses on the source cards. */
const MORE_ICON = ['more-horizontal-14', 'more-horizontal-12', 'more-vertical-18'];

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
    /* The ⋯ tab, while the strip needs one, and the ids it holds. */
    this._more = null;
    this._moreGlyph = null;
    this.overflow = [];
    this._menu = null;
    this._resize = null;
    this._resizeHost = null;
    this._lastRoom = null;
  }

  start() {
    trackFields();
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
    this._closeMenu();
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
    if (this._resize) { this._resize.disconnect(); this._resize = null; this._resizeHost = null; }
  }

  /**
   * The vendor strip, if this page has one *of the right kind*.
   *
   * `.ui.tabular.menu` is not unique to the per-screen panel: Preconfig heads
   * its page with a strip built from the same Semantic UI classes. On
   * LivePremier that one is **page navigation** — every anchor is an `href`
   * to another route, and the items are icons with no text. Appending Console
   * and Timeline to it put two words in a row of glyphs, on a page they have
   * nothing to do with, and clicking one hid a pane belonging to a different
   * screen. On Midra 4K the same page is a column of one-tab strips, each a
   * card *title* dressed as a tab.
   *
   * So a strip qualifies only if it holds a **pane switcher**: at least two
   * anchors that each carry a label and have no `href`. Two, because a strip
   * with one tab switches nothing — it is a heading. That is the structural
   * difference between "these tabs change what is shown here" and "these
   * links go somewhere else", and it does not depend on a class name, a route
   * or a label.
   *
   * **And its tabs carry an icon.** The EDID page heads its bank column with
   * a pane switcher too — Default EDIDS, EDID Bank: two labelled anchors, no
   * `href` — and passed every test above, so Console, Timeline, Layer and
   * Groups were appended to it, labelled "EDID BankConsole" because its label
   * is an `h3` rather than the `h5` a clone rewrites. The per-screen strip's
   * tabs are an icon and a label on LivePremier and on Midra 4K alike; the
   * EDID page's are a bare heading. (The EDID plugin puts its own tab on that
   * strip, deliberately — see `plugins/edid/page.js`.)
   */
  _strip() {
    for (const strip of document.querySelectorAll(STRIP_SEL)) {
      const tabs = this._switchers(strip);
      if (tabs.length >= 2 && tabs.every((a) => a.querySelector('i.icon') || a.querySelector('svg'))) return strip;
    }
    return null;
  }

  /**
   * The vendor's own pane-switching tabs in a strip, ours excluded.
   *
   * A tab's label is an `h5` inside the anchor on LivePremier and a bare text
   * node beside the icon on Midra 4K and Alta 4K — the same Semantic UI
   * `Menu.Item`, given `content` as a string. Either counts; what does not is
   * an anchor with no words at all, which is an icon link.
   */
  _switchers(strip) {
    return [...strip.querySelectorAll('a')].filter(
      (a) => !a.hasAttribute(OURS) && !a.hasAttribute('href') && (a.textContent || '').trim() !== '');
  }

  /**
   * The element that carries a tab's words.
   *
   * The vendor's own heading when it has one, else the span we put in its
   * place. Never the anchor itself: `_applyMode` shows and hides the label
   * independently of the icon, and writing text straight onto the anchor
   * would take the icon with it.
   */
  _labelOf(node) {
    return node.querySelector('h5') || node.querySelector(`[${LABEL}]`);
  }

  /** The vendor's content pane: the strip's sibling that is not the strip. */
  _vendorPane(strip) {
    const parent = strip.parentElement;
    if (!parent) return null;
    return [...parent.children].find(
      (c) => c !== strip && !c.hasAttribute(OURS + '-pane')
    ) || null;
  }

  /* Prefer an inactive tab as the template — an active one would drag its
     own state classes in, and stripping them is guesswork we can skip. */
  _template(strip) {
    const anchors = this._switchers(strip);
    return anchors.find((a) => !a.classList.contains('active')) || anchors[0] || null;
  }

  _mount() {
    const strip = this._strip();
    if (!strip) return false;
    if (strip.querySelector(`[${OURS}]`)) return true;

    const template = this._template(strip);
    if (!template) return false;

    this.nodes.clear();
    /* A re-render took the ⋯ tab with the rest, and any menu it had open
       now points at nothing. */
    this._more = null;
    this.overflow = [];
    this._closeMenu();
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
   * asked where it came out. The first that sits inside `_bounds` wins. The
   * last rung keeps as many icons as fit, in order, and puts the rest behind
   * ⋯; if not even ⋯ alone fits, it stands anyway, because a tab that is hard
   * to reach is still better than one that has been taken away.
   *
   * A bounding rect rather than `scrollWidth`, because the overflow is not
   * only a matter of width: the strip is centred, so it spills off the left
   * of the panel as well as the right, and it can be narrower than the panel
   * and still run under the vendor's `»`.
   */
  _fit(strip = this._strip()) {
    if (!strip || !this.nodes.size) return;
    const host = strip.parentElement;
    const room = host && host.clientWidth;
    /* Not laid out yet — a zero-width panel would send every tab straight to
       the last rung and leave it there. Wait to be asked again. */
    if (!room) return;
    this._lastRoom = room;

    const bounds = this._bounds(strip);
    const fits = () => {
      const r = strip.getBoundingClientRect();
      return r.left >= bounds.left - 0.5 && r.right <= bounds.right + 0.5;
    };

    for (const mode of MODES.slice(0, -1)) {
      this._applyMode(strip, mode);
      if (fits()) { this.mode = mode; return; }
    }
    const ids = [...this.nodes.keys()];
    for (let keep = ids.length - 1; keep >= 0; keep--) {
      this._applyMode(strip, 'more', ids.slice(keep));
      if (fits()) break;
    }
    this.mode = 'more';
  }

  /**
   * Where the strip may sit, in viewport pixels: its panel, short of any
   * vendor control in the same row.
   *
   * On LivePremier the strip is not laid out inside its parent at all. Web
   * RCS lifts it into the panel header — `position: absolute`, centred with
   * `left: 50%` and `translateX(-50%)` — where the panel's collapse button
   * sits at the right. Measured from rects rather than assumed, so a build
   * that left-aligns the strip, moves the button or adds another still fits:
   * a button right of the panel's middle bounds the strip's right edge, one
   * left of it the left edge. Only buttons level with our tabs count; the
   * pane underneath is full of them.
   */
  _bounds(strip) {
    const host = strip.parentElement;
    const box = host.getBoundingClientRect();
    const band = (this._template(strip) || strip).getBoundingClientRect();
    const middle = (box.left + box.right) / 2;
    let left = box.left;
    let right = box.right;
    const scope = strip.offsetParent || host.parentElement || host;
    for (const control of scope.querySelectorAll('button')) {
      if (strip.contains(control)) continue;
      const r = control.getBoundingClientRect();
      if (!r.width || r.bottom <= band.top || r.top >= band.bottom) continue;
      if ((r.left + r.right) / 2 >= middle) right = Math.min(right, r.left);
      else left = Math.max(left, r.right);
    }
    return { left, right };
  }

  /**
   * Put every one of our tabs into one rung.
   *
   * `overflow` is for the `more` rung only: those tabs leave the strip and
   * the ⋯ tab holds them. The ones that stay are icons.
   */
  _applyMode(strip, mode, overflow = []) {
    const rung = mode === 'more' ? 'icon' : mode;
    for (const tab of this.tabs) {
      const node = this.nodes.get(tab.id);
      if (!node) continue;
      node.style.display = overflow.includes(tab.id) ? 'none' : '';
      const glyph = node.querySelector('i.icon');
      const label = this._labelOf(node);
      if (glyph) glyph.style.display = rung === 'full' || rung === 'icon' ? '' : 'none';
      if (label) {
        label.style.display = rung === 'icon' ? 'none' : '';
        label.textContent = rung === 'short' ? (tab.short || tab.label) : tab.label;
      }
      /* The full name is always one hover away, which is what makes the
         icon-only rung honest rather than a guessing game. */
      node.setAttribute('title', tab.label);
    }
    this.overflow = overflow;
    this._placeMore(strip, overflow.length > 0);
    this._syncMore();
  }

  /** Put the ⋯ tab on the end of the strip, or take it off. */
  _placeMore(strip, wanted) {
    if (!wanted) {
      this._closeMenu();
      if (this._more) { this._more.remove(); this._more = null; }
      return;
    }
    if (this._more && this._more.parentElement === strip) return;
    const template = this._template(strip);
    if (!template) return;
    const node = this._cloneTab(template, { id: '', label: 'More', icon: MORE_ICON }, () => this._toggleMenu());
    node.setAttribute(MORE, '');
    const label = this._labelOf(node);
    if (label) label.style.display = 'none';
    this._moreGlyph = null;
    strip.append(node);
    this._more = node;
  }

  /**
   * The ⋯ tab stands in for whichever of its tabs is open: lit, and wearing
   * that tab's icon, so the strip still says what the pane is showing.
   */
  _syncMore() {
    const node = this._more;
    if (!node) return;
    const open = this.overflow.includes(this.active) ? this.tabs.find((t) => t.id === this.active) : null;
    node.classList.toggle('active', Boolean(open));
    const names = this.overflow.map((id) => (this.tabs.find((t) => t.id === id) || {}).label).filter(Boolean);
    node.setAttribute('title', 'More: ' + names.join(', '));

    const glyph = open ? open.icon : MORE_ICON;
    const old = node.querySelector('i.icon');
    if (!old || this._moreGlyph === glyph) return;
    const fresh = icon(glyph, old.className);
    fresh.className = old.className;
    old.replaceWith(fresh);
    this._moreGlyph = glyph;
  }

  /* ------------------------------------------------------- the ⋯ menu */

  _toggleMenu() { this._menu ? this._closeMenu() : this._openMenu(); }

  /**
   * The tabs behind ⋯, as a menu under it.
   *
   * Parented to `body` and fixed, like Send to's: the panel header is not a
   * place a menu can hang out of. Picking a tab opens it — it does not
   * toggle, the way clicking a tab does, because a menu that closed the
   * panel you picked would be a strange menu. The vendor's own tabs are how
   * an operator goes back, as they are for every tab of ours.
   */
  _openMenu() {
    const anchor = this._more;
    if (!anchor) return;
    const doc = document;
    const rows = this.overflow
      .map((id) => this.tabs.find((t) => t.id === id))
      .filter(Boolean)
      .map((tab) => h('button', {
        class: 'wru-tabmenu-row' + (tab.id === this.active ? ' wru-tabmenu-row--on' : ''),
        type: 'button',
        role: 'menuitem',
        onClick: (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this._closeMenu();
          this.show(tab.id);
        }
      }, icon(tab.icon, 'aw-block-medium'), h('span', { text: tab.label })));
    const el = h('div', { class: 'wru-tabmenu', role: 'menu', 'aria-label': 'More tabs' }, ...rows);
    (doc.body || doc.documentElement).append(el);

    /* Under the ⋯, right edges level, and inside the window. */
    const r = anchor.getBoundingClientRect();
    const box = el.getBoundingClientRect();
    const margin = 8;
    const width = typeof window !== 'undefined' ? window.innerWidth : 0;
    let left = r.right - box.width;
    if (width) left = Math.min(left, width - box.width - margin);
    el.style.left = Math.round(Math.max(margin, left)) + 'px';
    el.style.top = Math.round(r.bottom + 4) + 'px';

    /* A press on the ⋯ itself is left to its click, which closes the menu —
       closing here as well would let that click open it straight back up. */
    const onOutside = (ev) => {
      if (el.contains(ev.target) || anchor.contains(ev.target)) return;
      this._closeMenu();
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); this._closeMenu(); } };
    const onResize = () => this._closeMenu();
    doc.addEventListener('mousedown', onOutside, true);
    doc.addEventListener('keydown', onKey, true);
    if (typeof window !== 'undefined') window.addEventListener('resize', onResize);
    this._menu = {
      el,
      close: () => {
        el.remove();
        doc.removeEventListener('mousedown', onOutside, true);
        doc.removeEventListener('keydown', onKey, true);
        if (typeof window !== 'undefined') window.removeEventListener('resize', onResize);
      }
    };
  }

  _closeMenu() {
    if (!this._menu) return;
    const menu = this._menu;
    this._menu = null;
    menu.close();
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

  _cloneTab(template, tab, onClick = () => this.toggle(tab.id)) {
    const node = template.cloneNode(true);
    node.setAttribute(OURS, tab.id);
    node.classList.remove('active');
    node.removeAttribute('href');
    node.style.cursor = 'pointer';

    /*
     * The label has to be its own element, because `_applyMode` shows and
     * hides it independently of the icon. LivePremier's tab carries an `h5`,
     * which is cloned and rewritten. Midra's carries a bare text node, and
     * an `h5` in its place would render as a heading — larger than the
     * vendor's own label and on its own line — so there the text nodes are
     * replaced by an inline span, which inherits whatever the anchor's text
     * was getting.
     */
    let label = node.querySelector('h5');
    if (!label) {
      label = h('span', { [LABEL]: '' });
      const texts = [...node.childNodes].filter((n) => n.nodeType === 3 /* TEXT_NODE */);
      if (texts.length) {
        texts[0].replaceWith(label);
        for (const t of texts.slice(1)) t.remove();
      } else node.append(label);
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
      onClick();
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
    /* The operator keeps their place — the same rule, and the same reason,
       as `Shell.refresh`; see `keep-focus.js`. */
    const place = captureFocus(this._pane);
    if (place && place.hold) return;
    const scroll = this._pane.querySelector('.wru-body');
    const top = scroll ? scroll.scrollTop : 0;
    const next = tab.render();
    /* Redrawn in place — the same rule, and the same reason, as `Shell.refresh`. */
    if (!(this._pane.children.length === 1 && this._pane.children[0] === next)) {
      this._pane.textContent = '';
      this._pane.append(next);
      const again = this._pane.querySelector('.wru-body');
      if (again) again.scrollTop = top;
    }
    restoreFocus(this._pane, place);
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
    this._syncMore();
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
