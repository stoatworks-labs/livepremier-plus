/*
 * Test Card — the tab, put on the vendor's own tab strips.
 *
 * ## ⚠️ This writes into the middle of Web RCS's markup
 *
 * Like Matrix Routing's Router tab (`plugins/matrix-routing/router-box.js`),
 * whose discipline this copies, and for the same reason: the card belongs
 * where the operator already is, beside the switcher's own Pattern tab. A
 * firmware that restructures either page makes the tab not appear, quietly;
 * `describe()` says what was found.
 *
 * ## What is matched, and why
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-10-20):
 *
 *   Setup ▸ Outputs ▸ an output   URL `/outputs/<n>/<tab>`. The strip is a
 *                                 `.ui.tabular.menu` of **routed anchors**
 *                                 (Format, Signal, Adjustments, Pattern),
 *                                 every `href` under `/outputs/<n>/`, and its
 *                                 next sibling is the content pane. The output
 *                                 comes from the URL, never from position.
 *   Preconfig ▸ Canvas            URL `/preconfig/pixelspaces/screens`. One
 *                                 `.ui.tabular.menu` of anchors with **no**
 *                                 `href` (Canvas, Pattern — a pane switch in
 *                                 React state), its next sibling the pane. The
 *                                 destination is the card in the left-hand
 *                                 list carrying `aw-preconfig-card--reference`,
 *                                 read by the `S1` / `A1` in its header.
 *
 * Labels are never matched — the vendor ships five languages — only shape,
 * URLs and the plain (unhashed) classes above.
 *
 * ## Open, closed, and the other tabs
 *
 * The tab is ours; opening it hides the vendor's pane (it is not removed, so
 * its scroll and state are there to go back to) and takes the selected look
 * off the vendor's tabs without touching what they do. A click on any other
 * tab in the strip — the vendor's, or Matrix Routing's Router — closes ours,
 * in the capture phase, before React handles it. A new page closes it too.
 */

import { h } from '../../src/ui/dom.js';

const MARK = 'data-lpp-testcard';
const HIDDEN = 'data-lpp-testcard-hidden';
const INNER = 'data-lpp-testcard-inner';
const OTHER_HOSTS = '[data-lpp-testcard], [data-lpp-router]';

function show(pane) {
  pane.style.display = '';
  pane.removeAttribute(HIDDEN);
}

/** Which page this is, for the tab: `{ kind: 'output', key }`, `{ kind: 'canvas' }`, or null. */
export function pageOf(pathname) {
  const path = String(pathname || '');
  const out = /^\/outputs\/(\d+)\/[^/]+/.exec(path);
  if (out) return { kind: 'output', key: out[1] };
  if (/^\/preconfig\/pixelspaces\/screens\/?$/.test(path)) return { kind: 'canvas' };
  return null;
}

const pageKey = (page) => (page ? (page.kind === 'output' ? `output:${page.key}` : 'canvas') : null);

/** The destination the Canvas page has selected: `S1`, `A2`, or null. */
export function selectedCanvas(doc) {
  const card = doc.querySelector('.aw-preconfig-card--reference');
  if (!card) return null;
  const head = card.querySelector('.aw-preconfig-card__header') || card;
  for (const el of head.querySelectorAll('div')) {
    if (el.children.length) continue;
    const t = String(el.textContent || '').trim();
    if (/^[SA]\d+$/.test(t)) return t;
  }
  return null;
}

/**
 * @param {object} o
 * @param {() => boolean} o.enabled
 * @param {(page: {kind:'output', key:string}|{kind:'canvas', id:string|null}) => Element} o.render
 *   the tab's body for a page — the same element again when nothing changed
 * @param {Document} [o.doc]
 * @param {{pathname: string}} [o.loc]
 */
export function installTestCardTab({ enabled, render, doc = document, loc = (typeof location !== 'undefined' ? location : { pathname: '/' }) }) {
  let open = false;
  let openOn = null;
  let observer = null;
  let rememberedActive = [];

  const anchors = (strip) => [...strip.querySelectorAll(':scope > a')];

  function findStrip(page) {
    for (const strip of doc.querySelectorAll('.ui.tabular.menu')) {
      const links = anchors(strip).filter((a) => !a.hasAttribute(MARK) && !a.hasAttribute('data-lpp-router'));
      if (!links.length) continue;
      if (page.kind === 'output') {
        const routed = links.filter((a) => a.hasAttribute('href'));
        if (routed.length && routed.every((a) => new RegExp(`^/outputs/${page.key}/`).test(a.getAttribute('href')))) return { strip, links: routed };
      } else if (links.every((a) => !a.hasAttribute('href'))) {
        return { strip, links };
      }
    }
    return null;
  }

  const paneOf = (strip) => [...strip.parentElement.children].find((c) => c !== strip && !c.matches(OTHER_HOSTS));
  const isActive = (a) => a.getAttribute('aria-current') === 'page' || a.classList.contains('active');

  /* The selected look, lifted off whichever vendor tab carries it: `active`
     on the Canvas page, `active` plus a hashed `--active` on the output's. */
  function activeClasses(links) {
    const active = links.find(isActive);
    const idle = links.find((a) => a !== active);
    if (active && idle) {
      const found = [...active.classList].filter((c) => !idle.classList.contains(c));
      if (found.length) rememberedActive = found;
    }
    return rememberedActive.length ? rememberedActive : ['active'];
  }

  function close() {
    open = false;
    openOn = null;
    for (const node of doc.querySelectorAll(`[${MARK}]:not(a)`)) node.remove();
    for (const pane of doc.querySelectorAll(`[${HIDDEN}]`)) show(pane);
  }

  function decorate() {
    if (!enabled()) return stop(false);
    const page = pageOf(loc.pathname);
    const key = pageKey(page);
    if (open && openOn !== key) close();
    if (!page) return;
    const found = findStrip(page);
    if (!found) return;
    const { strip, links } = found;

    let tab = strip.querySelector(`:scope > a[${MARK}]`);
    if (!tab) {
      const template = links.find((a) => !isActive(a)) || links[0];
      tab = template.cloneNode(true);
      tab.setAttribute(MARK, 'tab');
      tab.removeAttribute('href');
      tab.removeAttribute('aria-current');
      tab.style.cursor = 'pointer';
      for (const cls of activeClasses(links)) tab.classList.remove(cls);
      const label = tab.querySelector('h3, h4, h5') || tab;
      label.textContent = 'Test Card';
      tab.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        /* The page now, not the one this tab was cloned on: React keeps the
           strip, and so this tab, from one output's page to the next. */
        open = true;
        openOn = pageKey(pageOf(loc.pathname));
        decorate();
      });
      /* After the vendor's own tabs and before anything else added to the
         strip, so it sits beside Pattern. */
      const last = links[links.length - 1];
      last.parentElement.insertBefore(tab, last.nextSibling);
      strip.style.flexWrap = 'wrap';
    }

    const actives = activeClasses(links);
    const pane = paneOf(strip);
    let host = strip.parentElement.querySelector(`:scope > [${MARK}]:not(a)`);
    if (!open) {
      if (host) host.remove();
      if (pane && pane.hasAttribute(HIDDEN)) show(pane);
      for (const cls of actives) tab.classList.remove(cls);
      return;
    }

    for (const cls of actives) tab.classList.add(cls);
    for (const a of links) for (const cls of actives) a.classList.remove(cls);
    if (pane && !pane.hasAttribute(HIDDEN)) { pane.style.display = 'none'; pane.setAttribute(HIDDEN, ''); }

    if (!host) {
      /* The vendor pane's own classes, so it sits where the pane sat; and a
         panel inside, because on the Canvas page the pane is a Semantic
         segment holding a panel, where on an output's page it is the panel. */
      host = h('div', { class: (pane && pane.className) || 'aw-full-height', [MARK]: key },
        h('div', { class: 'aw-full-height aw-panel aw-panel--large', [INNER]: '' }));
      strip.parentElement.append(host);
    }
    const inner = host.querySelector(`[${INNER}]`) || host;
    const body = render(page.kind === 'output' ? page : { kind: 'canvas', id: selectedCanvas(doc) });
    if (body && inner.firstChild !== body) {
      /* Held off while a field of ours has the caret — a rebuild would take
         the field, and what is half typed in it, away. */
      const focused = doc.activeElement;
      if (focused && host.contains(focused) && /^(INPUT|SELECT|TEXTAREA)$/.test(focused.tagName)) return;
      const scroller = (n) => n && n.querySelector && n.querySelector('.aw-panel__content--scrollable');
      const old = scroller(host);
      const top = old ? old.scrollTop : 0;
      inner.replaceChildren(body);
      const fresh = scroller(host);
      if (fresh && top) fresh.scrollTop = top;
    }
  }

  function stop(disconnect = true) {
    close();
    for (const node of doc.querySelectorAll(`a[${MARK}]`)) node.remove();
    if (disconnect && observer) { observer.disconnect(); observer = null; }
  }

  /* A click on any other tab in a strip that has ours closes ours. Capture
     phase, so it is noticed before React navigates or switches the pane. */
  const onClick = (ev) => {
    const a = ev.target && ev.target.closest && ev.target.closest('.ui.tabular.menu > a');
    if (!a || a.hasAttribute(MARK) || !open) return;
    if (!a.parentElement.querySelector(`:scope > a[${MARK}]`)) return;
    close();
    decorate();
  };
  doc.addEventListener('click', onClick, true);

  let queued = false;
  if (typeof MutationObserver === 'function') {
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      Promise.resolve().then(() => { queued = false; decorate(); });
    });
    observer.observe(doc.body, { childList: true, subtree: true });
  }
  decorate();

  return {
    refresh: decorate,
    stop() { doc.removeEventListener('click', onClick, true); stop(); },
    isOpen: () => open,
    describe: () => {
      const page = pageOf(loc.pathname);
      return {
        page: loc.pathname,
        kind: page ? page.kind : null,
        strip: !!(page && findStrip(page)),
        tab: !!doc.querySelector(`a[${MARK}]`),
        open,
        canvas: page && page.kind === 'canvas' ? selectedCanvas(doc) : null
      };
    }
  };
}
