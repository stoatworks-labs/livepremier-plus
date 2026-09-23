/*
 * Router routing, on the vendor's own input and output pages.
 *
 * `panel.js` is the whole-rack view: every router, every cable. This
 * puts one socket's slice of it where an operator is already looking at that
 * socket, in the four places Web RCS configures one:
 *
 *   Setup ▸ Inputs ▸ an input        a **Router** tab on the Signal / Aspect /
 *   Setup ▸ Outputs ▸ an output      Keying strip, beside the vendor's own
 *
 *   Preconfig ▸ Inputs ▸ a card      a **Router** box at the foot of the
 *   Preconfig ▸ Outputs ▸ a card     column of boxes for the selected card
 *
 * Each shows the same thing: which router port the cable is on (editable in
 * place, so the patch can be written down where the socket is configured),
 * and the router's ports twice — as a grid of tiles and as a list — with the
 * control to route from either.
 *
 * ⚠️ **The two routes are still different operations**, exactly as in the
 * matrix panel. An input picks ONE router source and fires on the click. An
 * output picks any number of router destinations, and fires only on Route —
 * a half-made selection of monitors must not start landing one click at a
 * time. `core/patch.js` sets out why.
 *
 * ⚠️ **Nothing is optimistic here either.** A tile lights when the router says
 * it is routed, not when it was clicked. A pending selection on an output is
 * drawn as an outline and is ours; a filled tile is the router's.
 *
 * ## What is matched, and why
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-09-22):
 *
 *   detail page   URL `/inputs/IN_5/signal`, `/outputs/5/format`. The strip is
 *                 `.ui.tabular.menu` of **routed anchors** — every tab has an
 *                 `href`, so it is page navigation rather than a pane switch,
 *                 and `ui/tabs.js` rightly leaves it alone. Its one sibling is
 *                 the content pane.
 *   preconfig     `/preconfig/inputs`, `/preconfig/resources/outputs`. The
 *                 right-hand column is an `.aw-panel--large` headed by an `h3`
 *                 reading `In5` / `Out5`, over an `.aw-panel__content--
 *                 scrollable` of `.aw-panel--medium` boxes.
 *
 * Which socket a page is about comes from the URL on a detail page and from
 * that heading in Preconfig, never from position — see `connectorForPage`. A
 * box that cannot tell which socket it is on is not drawn, because routing the
 * wrong socket's router port is the failure this whole feature must not have.
 */

import { h, button, isEnter } from '../../src/ui/dom.js';
import {
  entryConnectorId, entryForConnector, choicesFor, withEntry, ROUTER_SIDE,
} from '../../src/core/patch.js';
import { readConnectors, describeConnector } from '../../src/core/connectors.js';

const API = '/__lpp/matrix';
const MARK = 'data-lpp-router';

/**
 * Which switcher socket a Web RCS page is about, or null.
 *
 * Pure, so it is testable without a page. `heading` is the Preconfig column's
 * title and is ignored everywhere else.
 */
export function connectorForPage(pathname, heading = '') {
  const path = String(pathname || '');
  const detail = /^\/(inputs|outputs)\/([^/]+)(?:\/|$)/.exec(path);
  if (detail) {
    const key = decodeURIComponent(detail[2]);
    if (detail[1] === 'inputs' && /^IN_\d+$/.test(key)) return `input:${key}`;
    if (detail[1] === 'outputs' && /^\d+$/.test(key)) return `output:${key}`;
    return null;
  }
  const title = String(heading || '').trim();
  if (/^\/preconfig\/inputs\/?$/.test(path)) {
    const m = /^In\s*(\d+)$/i.exec(title);
    return m ? `input:IN_${Number(m[1])}` : null;
  }
  if (/^\/preconfig\/resources\/outputs\/?$/.test(path)) {
    const m = /^Out\s*(\d+)$/i.exec(title);
    return m ? `output:${Number(m[1])}` : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */

/**
 * The router data, shared by every box on the page.
 *
 * Same two feeds as the matrix panel — the snapshot for the patch, the stream
 * for what the routers say — held once here rather than per box, because a
 * box is rebuilt every time React re-renders the column it sits in.
 */
function createClient(onChange) {
  let data = null;
  let error = null;
  let stream = null;
  let loading = null;

  function load() {
    if (loading) return loading;
    loading = fetch(API, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((json) => { data = json; error = null; })
      .catch((err) => { error = `Could not reach the launcher: ${err.message}`; })
      .finally(() => { loading = null; onChange(); });
    return loading;
  }

  function listen() {
    if (stream || typeof EventSource !== 'function') return;
    stream = new EventSource(`${API}/stream`);
    stream.addEventListener('matrix', (ev) => {
      try {
        const matrices = JSON.parse(ev.data);
        data = { ...(data || { patch: [], problems: [] }), matrices };
        data.routing = Object.fromEntries(
          matrices.filter((m) => m.state).map((m) => [m.id, m.state.routing]));
        onChange();
      } catch { /* a malformed frame is not worth taking the box down */ }
    });
  }

  async function request(method, path, body) {
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) { error = payload.error || `${res.status}`; return false; }
      error = null;
      if (payload.patch) data = { ...data, ...payload };
      return true;
    } catch (err) {
      error = err.message;
      return false;
    } finally {
      onChange();
    }
  }

  return {
    get data() { return data; },
    get error() { return error; },
    set error(v) { error = v; },
    start() { if (!data) load(); listen(); },
    feed: (connector, source) => request('POST', '/feed', { connector, source }),
    send: (connector, destinations) => request('POST', '/send', { connector, destinations }),
    savePatch: (patch) => request('PUT', '/patch', { patch }),
  };
}

/* ------------------------------------------------------------------ */

/**
 * @param {{session: object, enabled?: () => boolean, doc?: Document}} opts
 */
export function installRouterSurfaces({ session, enabled = () => true, doc = document } = {}) {
  /* Per-socket drafts: the patch form and an output's pending selection. Kept
     outside the DOM because the DOM is thrown away on every redraw. */
  const drafts = new Map();
  const draftFor = (id) => {
    if (!drafts.has(id)) drafts.set(id, { matrix: '', port: '', selected: new Set(), editing: false });
    return drafts.get(id);
  };
  let tabOpen = false;
  let observer = null;

  const client = createClient(() => redraw());

  /* ---- what is drawn inside a box or tab -------------------------- */

  function content(id) {
    const data = client.data;
    const matrices = (data && data.matrices) || [];
    const patch = (data && data.patch) || [];
    const entry = entryForConnector(patch, id);
    const draft = draftFor(id);
    const side = id.startsWith('input:') ? 'input' : 'output';

    const body = [];
    if (client.error) body.push(h('div', { class: 'wru-warn', text: client.error }));

    if (!data) {
      body.push(h('div', { class: 'aw-text-tertiary', text: 'Asking the launcher…' }));
      return body;
    }
    if (!matrices.length) {
      body.push(h('div', {
        class: 'aw-text-tertiary',
        text: 'No routers configured. Add one under PLUS ▸ Matrix Routing, then patch this socket here.',
      }));
      return body;
    }

    const matrix = entry && matrices.find((m) => m.id === entry.matrix);
    if (!entry || draft.editing) {
      body.push(patchForm(id, side, entry, matrices, draft));
      return body;
    }

    body.push(cableLine(id, side, entry, matrix, draft));
    /* The server's own verdict on the schedule — two sockets on one router
       port, a port past the router's size — for this socket only. */
    for (const p of (data.problems || []).filter((x) => x.entry && entryConnectorId(x.entry) === id)) {
      body.push(h('div', { class: 'wru-warn', text: p.message }));
    }

    if (!matrix) {
      body.push(h('div', { class: 'wru-warn', text: `No router called “${entry.matrix}” is configured.` }));
      return body;
    }
    if (matrix.status !== 'connected' || !matrix.state) {
      body.push(h('div', { class: 'aw-text-tertiary', text: `${matrix.name} is ${matrix.status}. Routing is available once it answers.` }));
      return body;
    }

    const routing = (data.routing && data.routing[matrix.id]) || matrix.state.routing || {};
    const choices = choicesFor(entry, matrix.state, routing);
    body.push(side === 'input'
      ? inputRouting(id, choices, matrix)
      : outputRouting(id, choices, matrix, entry, draft));
    return body;
  }

  /** "Fed by Hub output 3" with Change / Unpatch. */
  function cableLine(id, side, entry, matrix, draft) {
    const name = matrix ? matrix.name : entry.matrix;
    const what = side === 'input'
      ? `Fed by ${name} output ${entry.port}`
      : `Arrives at ${name} input ${entry.port}`;
    const status = matrix ? matrix.status : 'not configured';
    return field('Cable',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('span', { class: `wru-router-dot wru-router-dot--${status}`, title: status }),
        h('span', { class: 'aw-font-body-1', text: what }),
        button('Change', { variant: 'default', onClick: () => {
          draft.editing = true; draft.matrix = entry.matrix; draft.port = String(entry.port); redraw(true);
        } })));
  }

  /** Which router port the cable is on. Written straight to the patch. */
  function patchForm(id, side, entry, matrices, draft) {
    if (!draft.matrix || !matrices.some((m) => m.id === draft.matrix)) draft.matrix = matrices[0].id;
    const routerSide = ROUTER_SIDE[side];
    const chosen = matrices.find((m) => m.id === draft.matrix);
    const count = chosen && chosen.state ? chosen.state[`${routerSide}s`] : null;

    const save = async () => {
      const port = Number(draft.port);
      if (!Number.isInteger(port) || port < 1) {
        client.error = `Give the router ${routerSide} number the cable is on, counting from 1.`;
        return redraw(true);
      }
      if (count && port > count) {
        client.error = `${chosen.name} has ${count} ${routerSide}s; ${port} is not one of them.`;
        return redraw(true);
      }
      const ok = await client.savePatch(withEntry(client.data.patch || [], id, { matrix: draft.matrix, port }));
      if (ok) { draft.editing = false; draft.selected.clear(); }
      redraw(true);
    };

    const portField = h('input', {
      class: 'wru-input wru-input--narrow', value: draft.port, placeholder: '1',
      inputmode: 'numeric',
      onInput: (ev) => { draft.port = ev.target.value; },
      onKeyDown: (ev) => { if (isEnter(ev)) save(); },
    });

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-text-tertiary aw-font-caption', text: side === 'input'
        ? 'A switcher input is fed by a router OUTPUT — which one is the cable on?'
        : 'A switcher output arrives at a router INPUT — which one is the cable on?' }),
      field('Router', h('select', {
        class: 'wru-select',
        onChange: (ev) => { draft.matrix = ev.target.value; redraw(true); },
      }, ...matrices.map((m) => h('option', {
        value: m.id, selected: m.id === draft.matrix ? 'selected' : null,
      }, m.name)))),
      field(`Router ${routerSide}`, h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        portField,
        count ? h('span', { class: 'aw-text-tertiary', text: `of ${count}` }) : null)),
      h('div', { class: 'aw-flex-row aw-gap-col-small' },
        button(entry ? 'Save' : 'Patch', { variant: 'go', onClick: save }),
        entry ? button('Unpatch', { variant: 'danger', onClick: async () => {
          const ok = await client.savePatch(withEntry(client.data.patch || [], id, { matrix: null }));
          if (ok) { draft.editing = false; draft.selected.clear(); }
          redraw(true);
        } }) : null,
        entry ? button('Cancel', { onClick: () => { draft.editing = false; redraw(true); } }) : null));
  }

  /** One source, fired on the click. */
  function inputRouting(id, choices, matrix) {
    const live = choices.ports.find((p) => p.live);
    const pick = (port) => { if (!live || live.port !== port) client.feed(id, port); };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      field('Source', h('span', { class: 'aw-font-body-1', text: live ? portName(live) : '—' })),
      caption(`${matrix.name} inputs — click one to route it to this input. Applies immediately.`),
      grid(choices.ports, {
        state: (p) => (p.live ? 'live' : ''),
        onPick: pick,
        title: (p) => `${matrix.name} input ${portName(p)}`,
      }),
      list(choices.ports, {
        columns: ['', 'Input', 'Name'],
        cells: (p) => [
          h('input', { type: 'radio', name: `lpp-src-${id}`, checked: p.live ? 'checked' : null,
            onChange: () => pick(p.port) }),
          String(p.port),
          p.label || '—',
        ],
        state: (p) => (p.live ? 'live' : ''),
        onPick: pick,
      }));
  }

  /** Any number of destinations, fired on Route. */
  function outputRouting(id, choices, matrix, entry, draft) {
    const live = choices.ports.filter((p) => p.live);
    const sel = draft.selected;
    /* A port the router now reports live needs no pending mark. */
    for (const p of live) sel.delete(p.port);
    const toggle = (port) => {
      if (sel.has(port)) sel.delete(port); else sel.add(port);
      redraw(true);
    };
    const sourceName = (p) => {
      if (p.source == null) return '—';
      const labels = matrix.state.inputLabels || {};
      return labels[p.source] ? `${p.source} — ${labels[p.source]}` : String(p.source);
    };

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      field('On', h('span', { class: 'aw-font-body-1', text: live.length
        ? live.map((p) => p.port).join(', ')
        : 'no router outputs' })),
      caption(`${matrix.name} outputs — choose any number, then Route. A route adds; it never takes an output away.`),
      grid(choices.ports, {
        state: (p) => (p.live ? 'live' : sel.has(p.port) ? 'pending' : ''),
        onPick: (port) => { if (!live.some((p) => p.port === port)) toggle(port); },
        title: (p) => `${matrix.name} output ${portName(p)} — showing input ${sourceName(p)}`,
      }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button(sel.size ? `Route to ${sel.size} output${sel.size === 1 ? '' : 's'}` : 'Route', {
          variant: 'go',
          disabled: !sel.size,
          onClick: async () => {
            const ports = [...sel].sort((a, b) => a - b);
            if (await client.send(id, ports)) sel.clear();
            redraw(true);
          },
        }),
        sel.size ? button('Clear', { onClick: () => { sel.clear(); redraw(true); } }) : null),
      list(choices.ports, {
        columns: ['', 'Output', 'Name', 'Showing'],
        cells: (p) => [
          h('input', { type: 'checkbox',
            checked: p.live || sel.has(p.port) ? 'checked' : null,
            disabled: p.live ? 'disabled' : null,
            title: p.live ? 'Already on this output' : null,
            onChange: () => toggle(p.port) }),
          String(p.port),
          p.label || '—',
          p.live ? 'this output' : sourceName(p),
        ],
        state: (p) => (p.live ? 'live' : sel.has(p.port) ? 'pending' : ''),
        onPick: (port) => { if (!live.some((p) => p.port === port)) toggle(port); },
      }));
  }

  /* ---- mounting --------------------------------------------------- */

  /**
   * The Preconfig column's heading and its box list, or null.
   *
   * The card list on the left is the same shape — a large panel, an `h3`, a
   * scrollable body — headed "Inputs", so a column only counts when its
   * heading names one socket.
   */
  function preconfigColumn() {
    for (const col of doc.querySelectorAll('.aw-panel--large')) {
      const head = col.querySelector(':scope > .aw-panel__header h3');
      const list = col.querySelector(':scope > .aw-panel__content--scrollable');
      const heading = head ? head.textContent.trim() : '';
      if (list && /^(In|Out)\s*\d+$/i.test(heading)) return { heading, list };
    }
    return null;
  }

  /** The detail page's routed strip and its pane, or null. */
  function detailStrip() {
    for (const strip of doc.querySelectorAll('.ui.tabular.menu')) {
      const links = [...strip.querySelectorAll('a[href]')];
      if (links.length && links.every((a) => /^\/(inputs|outputs)\/[^/]+\//.test(a.getAttribute('href')))) {
        const pane = [...strip.parentElement.children].find(
          (c) => c !== strip && !c.hasAttribute(MARK));
        return { strip, pane, links };
      }
    }
    return null;
  }

  /**
   * One Router box in the vendor's idiom.
   *
   * The header is cloned from a sibling box when there is one, so the hashed
   * header-module class and its spacing come with it; the copy/paste/reset
   * tools are taken out because they are the vendor's and would act on the
   * vendor's settings.
   */
  function box(id, template) {
    const header = template
      ? template.cloneNode(true)
      : h('div', { class: 'aw-panel__header' },
          h('div', { class: 'aw-header aw-relative aw-header--medium' },
            h('div', { class: 'aw-header__items' }, h('h4'))));
    for (const tools of header.querySelectorAll('.aw-margin-left-auto')) tools.remove();
    const title = header.querySelector('h4') || header;
    title.textContent = 'Router';

    return h('div', { class: 'aw-panel aw-panel--medium', [MARK]: id },
      header,
      h('div', { class: 'aw-panel__content' },
        h('div', { class: 'ui form aw-flex-col aw-gap-row-medium wru-router' }, content(id))),
      h('div', { class: 'aw-panel__footer aw-panel__footer--empty' }));
  }

  function mountPreconfig() {
    const col = preconfigColumn();
    const id = col && connectorForPage(location.pathname, col.heading);
    const existing = doc.querySelector(`.aw-panel__content--scrollable > [${MARK}]`);
    if (!id) { if (existing) existing.remove(); return; }
    if (existing && existing.getAttribute(MARK) === id && existing.parentElement === col.list) return;
    if (existing) existing.remove();
    const sibling = col.list.querySelector(':scope > .aw-panel--medium > .aw-panel__header');
    col.list.append(box(id, sibling));
  }

  function mountTab() {
    const found = detailStrip();
    const id = connectorForPage(location.pathname);
    if (!found || !id) { tabOpen = false; return; }
    const { strip, pane, links } = found;

    let tab = strip.querySelector(`[${MARK}]`);
    if (!tab) {
      const template = links.find((a) => !isActive(a)) || links[0];
      tab = template.cloneNode(true);
      tab.setAttribute(MARK, 'tab');
      tab.removeAttribute('href');
      tab.removeAttribute('aria-current');
      tab.style.cursor = 'pointer';
      for (const cls of activeClasses(links)) tab.classList.remove(cls);
      const label = tab.querySelector('h3, h4, h5') || tab;
      label.textContent = 'Router';
      tab.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        tabOpen = true;
        mountTab();
      });
      strip.append(tab);
      /* The vendor's five tabs already overflow this strip at an ordinary
         window size — "Pattern" is cut to "Patte" — and nothing scrolls it,
         so a sixth would sit past the edge where nobody can click it. Wrapping
         puts it on a second row instead, and leaves the vendor's tabs where
         they were. */
      strip.style.flexWrap = 'wrap';
    }

    const ours = strip.parentElement.querySelector(`:scope > [${MARK}]:not(a)`);
    const actives = activeClasses(links);
    if (!tabOpen) {
      if (ours) ours.remove();
      if (pane && pane.dataset.lppRouterHidden) { pane.style.display = ''; delete pane.dataset.lppRouterHidden; }
      for (const cls of actives) tab.classList.remove(cls);
      return;
    }

    /* Ours is open: look selected, and let the vendor's tabs look unselected
       without touching their routing — a click on one still navigates. */
    for (const cls of actives) tab.classList.add(cls);
    for (const a of links) for (const cls of actives) a.classList.remove(cls);
    if (pane) { pane.style.display = 'none'; pane.dataset.lppRouterHidden = '1'; }

    if (ours && ours.getAttribute(MARK) === id) return;
    if (ours) ours.remove();
    const host = h('div', { class: (pane && pane.className) || 'aw-flex-item aw-panel aw-panel--large', [MARK]: id },
      h('div', { class: 'aw-panel__header aw-panel__header--empty' }),
      h('div', { class: 'aw-panel__content aw-scrollable-v-gutter-big' },
        box(id, null)));
    strip.parentElement.append(host);
  }

  /* The active classes, lifted off whichever vendor tab carries them. The
     strip is a CSS-modules link, so the "active" look is `active` plus a
     hashed `--active` modifier that changes every firmware. */
  let rememberedActive = [];
  function activeClasses(links) {
    const active = links.find((a) => a.getAttribute('aria-current') === 'page')
      || links.find((a) => a.classList.contains('active'));
    const idle = links.find((a) => a !== active);
    if (active && idle) {
      const found = [...active.classList].filter((c) => !idle.classList.contains(c));
      if (found.length) rememberedActive = found;
    }
    return rememberedActive.length ? rememberedActive : ['active'];
  }
  const isActive = (a) => a.getAttribute('aria-current') === 'page' || a.classList.contains('active');

  /**
   * Redraw whatever is on screen.
   *
   * `force` is for our own actions. A redraw driven by a router frame is held
   * off while a field of ours has the caret, for the reason `main.js` gives
   * about the panels: the rebuild would take the field and the caret with it.
   */
  function redraw(force = false) {
    if (!enabled()) return stop(false);
    const focused = doc.activeElement && doc.activeElement.closest && doc.activeElement.closest(`[${MARK}]`);
    if (!force && focused && /^(INPUT|SELECT)$/.test(doc.activeElement.tagName)) return;
    for (const node of doc.querySelectorAll(`[${MARK}]:not(a)`)) {
      if (node.classList.contains('aw-panel--medium')) {
        const id = node.getAttribute(MARK);
        const fresh = box(id, node.querySelector(':scope > .aw-panel__header'));
        node.replaceWith(fresh);
      }
    }
  }

  function decorate() {
    if (!enabled()) return stop(false);
    const onPage = /^\/(inputs|outputs)\/[^/]+\//.test(location.pathname)
      || /^\/preconfig\/(inputs|resources\/outputs)\/?$/.test(location.pathname);
    if (!onPage) { tabOpen = false; return; }
    client.start();
    mountPreconfig();
    mountTab();
  }

  function stop(disconnect = true) {
    for (const node of doc.querySelectorAll(`[${MARK}]`)) node.remove();
    for (const pane of doc.querySelectorAll('[data-lpp-router-hidden]')) {
      pane.style.display = ''; delete pane.dataset.lppRouterHidden;
    }
    tabOpen = false;
    if (disconnect && observer) { observer.disconnect(); observer = null; }
  }

  /* A click on one of the vendor's own tabs closes ours. Capture phase, so it
     is noticed before React navigates and redraws the strip. */
  const onClick = (ev) => {
    const a = ev.target.closest && ev.target.closest('.ui.tabular.menu a[href]');
    if (a && tabOpen) { tabOpen = false; mountTab(); }
  };
  doc.addEventListener('click', onClick, true);

  let queued = false;
  observer = new MutationObserver(() => {
    if (queued) return;
    queued = true;
    Promise.resolve().then(() => { queued = false; decorate(); });
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  decorate();

  return {
    refresh: decorate,
    stop() { doc.removeEventListener('click', onClick, true); stop(); },
    /* For the console and for a firmware that moves a page: what this found. */
    describe: () => ({
      page: location.pathname,
      preconfig: preconfigColumn() && preconfigColumn().heading,
      strip: !!detailStrip(),
      boxes: doc.querySelectorAll(`[${MARK}]`).length,
      connector: connectorForPage(location.pathname, (preconfigColumn() || {}).heading),
      socket: (() => {
        const id = connectorForPage(location.pathname, (preconfigColumn() || {}).heading);
        if (!id || !session.store || !session.store.ready) return null;
        const side = id.split(':')[0];
        const c = readConnectors(session.store, side).find((x) => x.id === id);
        return c ? describeConnector(c) : null;
      })(),
    }),
  };
}

/* ------------------------------------------------------------------ */

const portName = (p) => (p.label ? `${p.port} — ${p.label}` : String(p.port));

function field(label, control) {
  return h('div', { class: 'inline field' },
    h('label', { class: 'aw-block-medium' },
      h('div', { class: 'aw-font-body-1 aw-min-width-0 aw-text-ellipsis', text: label })),
    h('div', { class: 'children-wrapper aw-font-body-1' }, control));
}

const caption = (text) => h('div', { class: 'aw-font-caption aw-text-tertiary', text });

/**
 * The router's ports as tiles — the "back of the router" view.
 *
 * Drawn in the vendor's selection-tile language: dark tile, white at 70 %,
 * the vendor blue for what is selected. `live` is the router's word and is
 * filled; `pending` is ours and only outlined.
 */
function grid(ports, { state, onPick, title }) {
  return h('div', { class: 'wru-port-grid', role: 'group' },
    ...ports.map((p) => {
      const s = state(p);
      return h('button', {
        type: 'button',
        class: ['wru-port', s ? `wru-port--${s}` : ''],
        title: title(p),
        'aria-pressed': s ? 'true' : 'false',
        onClick: () => onPick(p.port),
      },
      h('span', { class: 'wru-port-num', text: String(p.port) }),
      h('span', { class: 'wru-port-label', text: p.label || '' }));
    }));
}

/** The same ports as rows, for a router with labels worth reading. */
function list(ports, { columns, cells, state }) {
  return h('div', { class: 'wru-port-list' },
    h('table', { class: 'wru-table' },
      h('thead', {}, h('tr', {}, ...columns.map((c) => h('th', { text: c })))),
      h('tbody', {}, ...ports.map((p) => {
        const s = state(p);
        return h('tr', { class: s === 'live' ? 'wru-row--active' : s === 'pending' ? 'wru-row--pending' : '' },
          ...cells(p).map((c) => h('td', {}, c)));
      }))));
}

export const ROUTER_MARK = MARK;
