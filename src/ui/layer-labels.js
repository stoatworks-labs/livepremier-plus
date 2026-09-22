/*
 * Layer names, written into the vendor's own pages.
 *
 * The switcher has no layer-name property — `core/layer-names.js` sets out how
 * thoroughly that was established — so there is no value to write that would
 * make Web RCS draw one. The only way a name appears on the vendor's own pages
 * is for us to put it there, which is what this file does, in the two places
 * that have room for it:
 *
 *   Screens / Aux. ▸ a screen card ▸ the stacked-layers flyout
 *       A list of rows, one per layer, each carrying a `L2` chip and its
 *       mixing mode. Wide, and the obvious place an operator looks to see
 *       what a screen's layers *are*.
 *
 *   Preconfig ▸ Screens ▸ a screen
 *       One panel per layer, headed "Layer 1". This is where the layers are
 *       configured, so it is where a name gets written down in the first
 *       place.
 *
 * ## ⚠️ This is the most fragile thing in the app, and it is opt-in
 *
 * Everything else we put in the vendor's UI is *ours* — a sidebar entry, a tab,
 * a button on a card — cloned from their markup and owning its own content.
 * This writes into the middle of their content. A firmware that restructures
 * either list makes the name not appear; that is the failure and it is a
 * quiet one, which is why `describe()` exists and why the settings page can
 * turn the whole thing off.
 *
 * It is worth the fragility only because the alternative is a name that exists
 * in our panels and nowhere the operator is actually looking.
 *
 * ## What is matched, and why
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-09-22):
 *
 *   flyout row   [class*="preset-layer-item-control-container__c__infos___"]
 *                  └ [class*="tag-item__c___"] with text `L2` / `BKG`
 *   preconfig    div.aw-header__items.aw-font-bold-semi with text `Layer 2`
 *
 * The flyout's container carries a build hash and is matched on its stable
 * middle, as `ui/shell.js` matches the sidebar. The preconfig header carries
 * none at all — it is plain utility classes — so it is matched on those plus
 * its text.
 *
 * ⚠️ **Which screen a row belongs to is not in the row.** Both lists are drawn
 * inside something that knows: the flyout hangs off a screen card
 * (`.aw-preset-view`, whose `h2` names it, the same anchor `ui/preset-lock.js`
 * uses), and the preconfig panels sit on a page whose left-hand list has one
 * item selected. Neither is guessed — a row whose screen cannot be established
 * gets no name, because a name against the wrong screen is worse than none.
 */

import { h } from './dom.js';
import { nameOf } from '../core/layer-names.js';

/** Ours, so a re-render cannot end up with two and so `stop()` can find them. */
const MARK = 'data-lpp-layer-name';

const FLYOUT_ROW = '[class*="preset-layer-item-control-container__c__infos___"]';
const CHIP = '[class*="tag-item__c___"]';
/* The preconfig panel header. `aw-font-bold-semi` is what separates it from
   every other `aw-header__items` on that page. */
const PRECONFIG_HEAD = '.aw-header__items.aw-font-bold-semi';

/**
 * @param {{names: () => object, enabled?: () => boolean, doc?: Document}} opts
 *   `names` returns the current map — a function, not a snapshot, because the
 *   operator renames while this is running.
 */
export function installLayerLabels({ names, enabled = () => true, doc = document } = {}) {
  let observer = null;
  /* The screen whose stacked-layers flyout was opened last. See `screenOf`. */
  let flyoutScreen = null;

  /** The destination a node sits inside, or null. */
  function cardScreen(node) {
    const card = node.closest && node.closest('.aw-preset-view');
    const heading = card && card.querySelector('h2');
    const id = heading && heading.textContent.trim().toUpperCase();
    return id && /^[SA]\d+$/.test(id) ? id : null;
  }

  /**
   * ⚠️ Which screen the flyout belongs to is not knowable from the flyout.
   *
   * It is a Semantic UI popup rendered into a **portal** — `ui bottom left
   * popup transition visible`, parented near the end of `<body>` — so there is
   * no card to climb out of, and it carries no `aria-describedby`, no id and
   * no other attribute tying it back to the button that opened it. Geometry is
   * no good either: the popup is positioned by the library and does not sit
   * over its own card.
   *
   * So the trigger is remembered instead. A capture-phase listener notes which
   * screen's stacked-layers button was pressed, and the flyout that follows
   * belongs to that screen. That holds because exactly one of these popups is
   * open at a time and the button is the only thing that opens one — and if
   * that ever stops being true, the failure is a name against the wrong
   * screen, which is why `describe()` reports what is being labelled.
   */
  const screenOf = () => flyoutScreen;

  function noteTrigger(ev) {
    const btn = ev.target.closest && ev.target.closest('button');
    const use = btn && btn.querySelector('use');
    const href = use && (use.getAttribute('href') || '');
    if (!href || !/^#layer-stacked-/.test(href)) return;
    flyoutScreen = cardScreen(btn);
  }

  /**
   * The screen the Preconfig ▸ Screens page is showing.
   *
   * That page has no card to climb out of — the panels are the page — so the
   * only source is the selected item in its own screen list. Matched by the
   * Semantic `active` class plus a destination-shaped label, which is what
   * the list actually is; a positional guess would silently follow the wrong
   * screen the moment the list scrolled.
   */
  function preconfigScreen() {
    for (const item of doc.querySelectorAll('.item.active, .active.item')) {
      const text = (item.textContent || '').trim().toUpperCase();
      if (/^[SA]\d+$/.test(text)) return text;
    }
    return null;
  }

  /** `L2` / `BKG` / `NATIVE` as the vendor writes it -> our layer key, or null. */
  function layerKeyFromChip(text) {
    const t = String(text || '').trim().toUpperCase();
    if (t === 'NATIVE') return 'NATIVE';
    /* ⚠️ BKG is the screen background, which lives in a different subtree and
       is not a layer slot at all — it cannot be named because there is nothing
       to hang a name on. Skipped rather than given a key that addresses
       nothing. `core/screens.js` makes the same distinction about NATIVE. */
    const m = /^L(\d+)$/.exec(t);
    return m ? m[1] : null;
  }

  /** Put one name beside one node, or take it away when the name is gone. */
  function apply(host, id, layer) {
    const existing = host.querySelector(`[${MARK}]`);
    const name = id && layer ? nameOf(names(), id, layer) : null;
    if (!name) { if (existing) existing.remove(); return; }
    if (existing) {
      /* React reuses rows as a list re-orders, so the text is re-stamped
         rather than trusted — a stale one names the wrong layer. */
      if (existing.textContent !== name) existing.textContent = name;
      return;
    }
    host.append(h('span', {
      class: 'wru-layer-name aw-text-tertiary',
      [MARK]: `${id}/${layer}`,
      title: `Layer name — LivePremier Plus (${id} L${layer})`,
      text: name
    }));
  }

  function decorate() {
    if (!enabled()) return stop(false);

    for (const row of doc.querySelectorAll(FLYOUT_ROW)) {
      const chip = row.querySelector(CHIP);
      apply(row, screenOf(), layerKeyFromChip(chip && chip.textContent));
    }

    const screen = preconfigScreen();
    for (const head of doc.querySelectorAll(PRECONFIG_HEAD)) {
      const m = /^Layer\s+(\d+)$/i.exec((head.textContent || '').trim().replace(/\s+/g, ' '));
      /* The header's own text carries the name once we have added it, so the
         match is against the text with our span taken out of the reckoning. */
      const own = head.querySelector(`[${MARK}]`);
      const bare = own ? (head.textContent || '').replace(own.textContent, '').trim() : (head.textContent || '').trim();
      const layer = m ? m[1] : (/^Layer\s+(\d+)$/i.exec(bare) || [])[1];
      if (!layer) continue;
      apply(head, screen, layer);
    }
  }

  function stop(disconnect = true) {
    for (const node of doc.querySelectorAll(`[${MARK}]`)) node.remove();
    if (disconnect && observer) { observer.disconnect(); observer = null; }
  }

  /**
   * What this is currently managing to label, for the settings page.
   *
   * A silent nothing is the failure mode of the whole file — a firmware moves
   * a list and the names simply stop appearing, with no error anywhere. A
   * count an operator can look at is the difference between "this feature is
   * off" and "this feature is broken".
   */
  function describe() {
    const rows = doc.querySelectorAll(FLYOUT_ROW).length;
    const heads = [...doc.querySelectorAll(PRECONFIG_HEAD)]
      .filter((e) => /^Layer\s+\d+/i.test((e.textContent || '').trim())).length;
    return {
      flyoutRows: rows, preconfigHeaders: heads,
      labelled: doc.querySelectorAll(`[${MARK}]`).length,
      flyoutScreen
    };
  }

  /* Capture, because the vendor's own handler opens the popup and we want the
     screen recorded before the popup exists to be decorated. */
  doc.addEventListener('click', noteTrigger, true);

  decorate();
  observer = new MutationObserver(() => decorate());
  observer.observe(doc.body, { childList: true, subtree: true });

  return {
    refresh: decorate,
    describe,
    stop() { doc.removeEventListener('click', noteTrigger, true); stop(); }
  };
}

export const LAYER_NAME_MARK = MARK;
