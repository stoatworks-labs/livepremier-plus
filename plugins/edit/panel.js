/*
 * The Edit page: the Screens / Aux. layout with one row instead of two.
 *
 * The vendor's page draws every destination twice, PGM over PRW, because those
 * are the two places a look can exist on the device. This draws it once, and
 * the one row is a buffer that is on neither bus — `core/programmer.js` says
 * what that is and why buffer C is not it. Same sources, same sixty-seven
 * layer parameters, same memory bank. Nothing an operator does here reaches
 * the switcher until they save a memory, and the header of
 * `core/preset-file.js` says how that happens without a bus either.
 *
 * ## What is deliberately missing
 *
 * There is no TAKE, no T-bar and no padlock. There is nothing to transition
 * and nothing to protect, and their absence is the clearest possible statement
 * of where the operator is: a page with a TAKE button that did nothing would
 * be worse than no button at all.
 *
 * ## The three columns are the vendor's, in the vendor's order
 *
 * Sources on the left, destinations in the middle, the per-layer panel on the
 * right. An operator who can use Web RCS can use this without being told where
 * anything is, which is the whole argument for cloning a layout rather than
 * designing one.
 *
 * ## Dragging writes through the catalogue, not around it
 *
 * A drag is turned into `position.posH`/`posV`/`sizeH`/`sizeV` and sent through
 * `core/properties.js`'s `writeCmd`, the same path the Layer panel's fields
 * use. So the clamps are the device's own declared ranges rather than a second
 * set invented here, and a layer cannot be dragged somewhere a typed number
 * could not go.
 *
 * Two things about that are easy to get wrong and are handled in `geometry()`:
 *
 * - **A resize is a statement about a corner and the device stores an anchor.**
 *   Writing `sizeH` alone on a `BOTTOM_RIGHT`-anchored layer moves the edge
 *   the operator was not touching. Every drag goes out through
 *   `topLeftToAnchor`.
 * - **The stage is drawn in fractions of the canvas**, so a pointer delta in
 *   pixels has to be scaled by the canvas width over the stage's own width —
 *   which changes with the size chip and with the window.
 */

import { h, button, icon } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { stage } from '../../src/ui/stage.js';
import { listDestinations, listSources, readLayers, sourceLabel, topLeftToAnchor } from '../../src/core/screens.js';
import { fittedLayers, writeCmd, catalogueFor } from '../../src/core/properties.js';
import { layerLabel } from '../../src/core/layer-names.js';
import { EDIT } from '../../src/core/programmer.js';

/** Card widths, the same ladder the preview wall offers. */
const SIZES = [
  { id: 'small', label: 'S', width: 240 },
  { id: 'medium', label: 'M', width: 340 },
  { id: 'large', label: 'L', width: 460 },
  { id: 'huge', label: 'XL', width: 640 }
];

/** Vendor input thumbnails move at about 1 Hz; matching it is enough. */
const SNAPSHOT_MS = 1000;

/**
 * The eight resize handles, as the fraction of the box each one moves.
 *
 * `dx`/`dy` are which edges the handle drags: -1 is the near edge, +1 the far
 * one, 0 neither. One table rather than eight cases, so a handle cannot be
 * wired to the wrong edge in one place and right in another.
 */
const HANDLES = [
  { id: 'nw', dx: -1, dy: -1 }, { id: 'n', dx: 0, dy: -1 }, { id: 'ne', dx: 1, dy: -1 },
  { id: 'w', dx: -1, dy: 0 }, { id: 'e', dx: 1, dy: 0 },
  { id: 'sw', dx: -1, dy: 1 }, { id: 's', dx: 0, dy: 1 }, { id: 'se', dx: 1, dy: 1 }
];

/**
 * @param {object} opts
 * @param {object} opts.session     the live session — read only, from here
 * @param {object} opts.programmer  `core/programmer.js`
 * @param {object} opts.properties  a properties panel bound to the programmer
 * @param {Function} opts.onRefresh
 * @param {Function} [opts.names]   layer names
 * @param {Function} [opts.onSave]  ({id, slot, label, route}) => Promise, saves a memory
 * @param {Function} [opts.onLoad]  ({id, slot}) => Promise, reads one back in
 */
export function createEditPanel({
  session, programmer, properties, onRefresh = () => {},
  names = () => ({}), onSave = null, onLoad = null, doc = document
}) {
  const view = {
    /* null means "every destination in service", which is the vendor's ALL.
       Held as null rather than as a filled-in list so a screen that comes into
       service mid-session appears instead of falling outside a stale set. */
    screens: null,
    auxes: null,
    size: 'medium',
    rail: 'layer',
    sourcesOpen: true,
    tick: Date.now(),
    note: null,
    /* {slot, label, route} while a memory is being saved into or read out of. */
    saving: null,
    busySave: false,
    busyLoad: false
  };

  const images = new Set();
  let timer = null;
  let dragging = null;

  const store = () => programmer.store;

  /**
   * What is selected, resolved the same way the Layer panel resolves it.
   *
   * The selection lives in that panel's own `view`, so the card and the panel
   * cannot disagree about which layer is being edited — but `view.dest` and
   * `view.layer` are null until somebody picks, and null there means "the
   * first one" rather than "none". Reading them raw is how the page comes to
   * say "pick a layer first" with a layer visibly selected on the right.
   */
  function selected() {
    const all = offered();
    const dest = all.find((d) => d.id === properties.view.dest) || all[0] || null;
    if (!dest) return { dest: null, layer: null };
    const layers = fittedLayers(store(), dest.id);
    const layer = layers.find((l) => l.key === properties.view.layer) || layers[0] || null;
    return { dest: dest.id, layer: layer ? layer.key : null };
  }

  function select(id, layer) {
    properties.view.dest = id;
    if (layer != null) properties.view.layer = String(layer);
    properties.view.mode = EDIT;
    onRefresh();
  }

  function note(tone, text) {
    view.note = text ? { tone, text } : null;
    onRefresh();
  }

  /* ------------------------------------------------------------ lifecycle */

  function start() {
    stop();
    timer = setInterval(() => {
      if (doc.hidden) return;
      view.tick = Date.now();
      for (const img of images) {
        if (!img.isConnected) { images.delete(img); continue; }
        const base = img.dataset.lppSnapshot;
        if (base) img.setAttribute('src', base + '?' + view.tick);
      }
    }, SNAPSHOT_MS);
  }

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ------------------------------------------------------------- the desk */

  const offered = () => (store().ready ? listDestinations(store()) : []);

  function chosen() {
    return offered().filter((d) => {
      const pick = d.kind === 'screen' ? view.screens : view.auxes;
      return pick === null ? true : pick.includes(d.id);
    });
  }

  function toggle(kind, id) {
    const key = kind === 'screen' ? 'screens' : 'auxes';
    const available = offered().filter((d) => d.kind === kind).map((d) => d.id);
    const current = view[key] === null ? available.slice() : view[key].slice();
    const at = current.indexOf(id);
    if (at >= 0) current.splice(at, 1); else current.push(id);
    view[key] = current.length === available.length ? null : current;
    onRefresh();
  }

  /* ------------------------------------------------------------- geometry */

  /**
   * Turn a pointer drag into layer geometry, and send it.
   *
   * `handle` is null for a move and one of `HANDLES` for a resize. Everything
   * is in canvas units by the time it gets here; the caller does the pixel
   * arithmetic because only it knows how wide the stage was drawn.
   */
  function geometry(id, layerKey, rect, anchor) {
    const specs = catalogueFor(store()).layer;
    const spec = (paramId) => specs.find((s) => s.id === paramId);
    const target = { id, bank: EDIT, layer: String(layerKey) };
    const { posH, posV } = topLeftToAnchor(anchor, rect.left, rect.top, rect.width, rect.height);

    for (const [paramId, value] of [
      ['position.sizeH', Math.round(rect.width)],
      ['position.sizeV', Math.round(rect.height)],
      ['position.posH', Math.round(posH)],
      ['position.posV', Math.round(posV)]
    ]) {
      const cmd = writeCmd(target, spec(paramId), value, store());
      if (cmd) programmer.send(cmd);
    }
  }

  /**
   * Start a drag.
   *
   * The box is moved by hand while the pointer is down and the programmer is
   * written at the same time, but nothing is re-rendered until the pointer
   * comes up: a repaint mid-drag would replace the element the pointer is
   * captured on, and the drag would end on the first move.
   */
  function beginDrag(ev, { dest, layer, box, inner, handle = null }) {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();

    const canvas = dest.canvas;
    const stageWidth = inner.getBoundingClientRect().width || 1;
    const scale = canvas.width / stageWidth;
    const start = { x: ev.clientX, y: ev.clientY };
    const from = { ...layer.rect };
    const anchor = layerAnchor(dest, layer.key);

    dragging = { dest, layer, box, handle };
    box.setPointerCapture?.(ev.pointerId);

    const move = (e) => {
      const dx = (e.clientX - start.x) * scale;
      const dy = (e.clientY - start.y) * scale;
      const rect = handle ? resized(from, handle, dx, dy) : {
        left: from.left + dx, top: from.top + dy, width: from.width, height: from.height
      };
      /* Drawn straight onto the node, in the fractions the stage uses. */
      box.style.left = ((rect.left / canvas.width) * 100).toFixed(4) + '%';
      box.style.top = ((rect.top / canvas.height) * 100).toFixed(4) + '%';
      box.style.width = ((rect.width / canvas.width) * 100).toFixed(4) + '%';
      box.style.height = ((rect.height / canvas.height) * 100).toFixed(4) + '%';
      geometry(dest.id, layer.key, rect, anchor);
    };

    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      dragging = null;
      onRefresh();
    };

    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  }

  /** A rectangle after one handle has been dragged. Never inside-out. */
  function resized(from, handle, dx, dy) {
    let { left, top, width, height } = from;
    if (handle.dx < 0) { left += dx; width -= dx; }
    if (handle.dx > 0) { width += dx; }
    if (handle.dy < 0) { top += dy; height -= dy; }
    if (handle.dy > 0) { height += dy; }
    /* A box dragged through itself keeps its far edge and stops, rather than
       flipping — which is what the vendor's own fields do with a negative
       width, and what the catalogue's minimum would clamp to anyway. */
    if (width < 1) { left = from.left + (handle.dx < 0 ? from.width - 1 : 0); width = 1; }
    if (height < 1) { top = from.top + (handle.dy < 0 ? from.height - 1 : 0); height = 1; }
    return { left, top, width, height };
  }

  function layerAnchor(dest, key) {
    return store().get([
      'device', dest.listName, 'items', dest.id, 'presetList', 'items', EDIT,
      'layerList', 'items', String(key), 'position', 'pp', 'anchor'
    ]) || 'MIDDLE_CENTER';
  }

  /* --------------------------------------------------------------- source */

  /** Put a source on the selected layer. Local, like everything else here. */
  function assign(value) {
    const { dest, layer } = selected();
    if (!dest || layer == null) { note('warn', 'pick a layer first'); return; }
    if (!programmer.has(dest)) seed(dest, 'PREVIEW');

    const spec = catalogueFor(store()).layer.find((s) => s.id === 'source.inputNum');
    const cmd = writeCmd({ id: dest, bank: EDIT, layer: String(layer) }, spec, value, store());
    if (!cmd) { note('err', 'that source is not one this layer accepts'); return; }
    programmer.send(cmd);
    note('ok', `${dest} ${layerLabel(names(), dest, layer, { short: true })} = ${sourceLabel(value, store()) || 'none'}`);
  }

  const seed = (id, from) => {
    if (programmer.seed(id, from)) return true;
    note('warn', `${id}: the device has not said which buffer is ${String(from).toLowerCase()} yet`);
    return false;
  };

  /* --------------------------------------------------------------- render */

  const sizeOf = () => (SIZES.find((s) => s.id === view.size) || SIZES[1]).width;

  function render() {
    return panel({ toolbar: toolbar(), body: body() });
  }

  function chip(text, on, onClick, extra) {
    return h('button', {
      class: ['lpp-chip', on ? 'lpp-chip--on' : '', extra || ''], type: 'button', onClick
    }, text);
  }

  function toolbar() {
    const all = offered();
    const screens = all.filter((d) => d.kind === 'screen');
    const auxes = all.filter((d) => d.kind === 'aux');

    const group = (label, kind, list) => {
      if (!list.length) return null;
      const pick = kind === 'screen' ? view.screens : view.auxes;
      return h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
        chip('ALL', pick === null, () => {
          view[kind === 'screen' ? 'screens' : 'auxes'] = null;
          onRefresh();
        }),
        list.map((d) => chip(d.id, pick === null || pick.includes(d.id), () => toggle(kind, d.id))));
    };

    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        icon('properties-18', 'aw-block-huge'),
        h('span', { class: 'aw-font-body-1-bold', text: 'Edit' }),
        h('span', {
          class: 'wru-tag wru-tag--good',
          title: 'Nothing on this page reaches the switcher until you save a memory.'
        }, 'offline')),
      group('Screens', 'screen', screens),
      group('Aux.', 'aux', auxes),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Size' }),
        SIZES.map((s) => chip(s.label, view.size === s.id, () => { view.size = s.id; onRefresh(); }))),
      chip(view.sourcesOpen ? '‹ Sources' : 'Sources ›', view.sourcesOpen,
        () => { view.sourcesOpen = !view.sourcesOpen; onRefresh(); }));
  }

  function body() {
    if (!store().ready) return h('div', { class: 'wru-empty', text: 'Waiting for the device store…' });
    const dests = chosen();

    return h('div', { class: 'lpp-edit' },
      view.sourcesOpen ? sourcesColumn() : null,
      h('div', { class: 'lpp-edit-main' },
        noteLine(),
        dests.length
          ? h('div', { class: 'lpp-wall' }, dests.map(card))
          : h('div', {
            class: 'wru-empty',
            text: 'No screen or auxiliary in service matches the filter.'
          })),
      h('div', { class: 'lpp-edit-rail' }, railTabs(), railBody()));
  }

  function noteLine() {
    if (!view.note) return null;
    const cls = { ok: 'wru-console-ok', warn: 'wru-console-warn', err: 'wru-console-err' };
    return h('div', {
      class: ['wru-console-row', cls[view.note.tone] || '', 'aw-margin-bottom-medium']
    }, h('span', { text: view.note.text }));
  }

  /* ----------------------------------------------------------------- card */

  function card(dest) {
    const width = sizeOf();
    const live = programmer.has(dest.id);
    const { dest: selDest, layer: selLayer } = selected();

    const frame = live
      ? stage({
        store: store(),
        dest,
        bank: EDIT,
        label: 'EDIT',
        tone: 'edit',
        tick: view.tick,
        images,
        names: names(),
        selected: selDest === dest.id ? selLayer : null,
        onLayer: (key, ev) => {
          select(dest.id, key);
          const box = ev.currentTarget;
          const layer = readLayers(store(), dest, EDIT).find((l) => String(l.key) === String(key));
          if (layer) beginDrag(ev, { dest, layer, box, inner: box.parentElement });
        },
        decorate: (box, layer) => {
          if (selDest !== dest.id || String(selLayer) !== String(layer.key)) return;
          for (const handle of HANDLES) {
            box.append(h('span', {
              class: ['lpp-handle', 'lpp-handle--' + handle.id],
              onPointerDown: (ev) => beginDrag(ev, {
                dest, layer, box, inner: box.parentElement, handle
              })
            }));
          }
        }
      })
      : emptyStage(dest);

    return h('div', {
      class: ['lpp-card', selDest === dest.id ? 'lpp-card--on' : ''],
      style: { width: width + 'px' }
    },
    h('div', { class: 'lpp-card-head aw-flex-row-center-v aw-gap-col-small' },
      h('button', {
        class: 'lpp-card-name', type: 'button',
        onClick: () => select(dest.id, null)
      }, h('span', { class: 'aw-font-body-1-bold', text: dest.id })),
      dest.label ? h('span', { class: 'aw-text-secondary aw-text-ellipsis', text: dest.label }) : null,
      h('div', { style: { flex: '1' } }),
      h('span', { class: 'aw-font-caption aw-text-tertiary', text: `${dest.layerCount ?? '?'}L` })),
    frame,
    cardTools(dest, live),
    live ? layerStrip(dest) : null);
  }

  function emptyStage(dest) {
    const ratio = (dest.canvas.height / dest.canvas.width) * 100;
    return h('div', { class: 'lpp-stage lpp-stage--edit' },
      h('div', { class: 'lpp-stage-pad', style: { paddingTop: ratio + '%' } }),
      h('div', { class: 'lpp-stage-inner lpp-stage-inner--empty' },
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'nothing programmed' })),
      h('span', { class: 'lpp-stage-tag lpp-stage-tag--edit', text: 'EDIT' }));
  }

  /**
   * The per-card actions.
   *
   * Copying from PGM or PRW is free — the mirror already holds both, and
   * nothing is asked of the device to read them. That is worth saying on the
   * page, because an operator who has understood that this page is offline
   * will reasonably wonder what "from program" costs.
   */
  function cardTools(dest, live) {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini lpp-card-tools aw-flex-wrap' },
      button('From PGM', {
        onClick: () => { if (seed(dest.id, 'PROGRAM')) note('ok', `${dest.id} copied from program`); },
        title: 'Copy what is on air into the programmer. Reads the mirror; asks the device nothing.'
      }),
      button('From PRW', {
        onClick: () => { if (seed(dest.id, 'PREVIEW')) note('ok', `${dest.id} copied from preview`); },
        title: 'Copy what is cued into the programmer. Reads the mirror; asks the device nothing.'
      }),
      button('Empty', {
        onClick: () => { programmer.clear(dest.id); note('ok', `${dest.id} emptied`); },
        title: 'Every layer full-frame with no source, which is what an untouched preset looks like.'
      }),
      live
        ? button('Discard', {
          variant: 'danger',
          onClick: () => { programmer.discard(dest.id); note('ok', `${dest.id} discarded`); },
          title: 'Forget this destination\'s programmer buffer.'
        })
        : null);
  }

  /** The layer list under a card, the vendor's own furniture. */
  function layerStrip(dest) {
    const { dest: selDest, layer: selLayer } = selected();
    const layers = fittedLayers(store(), dest.id);
    if (!layers.length) return null;

    return h('div', { class: 'lpp-layer-strip' }, layers.map((l) => {
      const source = store().get([
        'device', dest.listName, 'items', dest.id, 'presetList', 'items', EDIT,
        'layerList', 'items', String(l.key), 'source', 'pp', 'inputNum'
      ]);
      const on = selDest === dest.id && String(selLayer) === String(l.key);
      return h('button', {
        class: ['lpp-layer-row', on ? 'lpp-layer-row--on' : ''],
        type: 'button',
        onClick: () => select(dest.id, l.key)
      },
      h('span', { class: 'aw-font-caption', text: layerLabel(names(), dest.id, l.key, { short: true }) }),
      h('span', {
        class: ['aw-font-caption', source && source !== 'NONE' ? 'aw-text-secondary' : 'aw-text-tertiary'],
        text: sourceLabel(source, store()) || '—'
      }));
    }));
  }

  /* -------------------------------------------------------------- sources */

  function sourcesColumn() {
    const sources = listSources(store());
    const { dest, layer } = selected();
    const current = dest && layer != null
      ? store().get([
        'device', (offered().find((d) => d.id === dest) || {}).listName || 'screenList',
        'items', dest, 'presetList', 'items', EDIT,
        'layerList', 'items', String(layer), 'source', 'pp', 'inputNum'
      ])
      : null;

    return h('div', { class: 'lpp-edit-sources' },
      h('div', { class: 'aw-font-overline aw-text-tertiary lpp-rail-title', text: 'Sources' }),
      h('div', { class: 'lpp-source-grid' }, sources.map((s) => sourceCard(s, s.value === current))));
  }

  function sourceCard(source, on) {
    const box = h('button', {
      class: ['lpp-source', on ? 'lpp-source--on' : ''],
      type: 'button',
      title: `${source.label} · ${source.value}`,
      onClick: () => assign(source.value)
    });

    if (source.snapshot) {
      const img = h('img', { class: 'lpp-source-img', alt: '', decoding: 'async' });
      img.dataset.lppSnapshot = source.snapshot;
      img.setAttribute('src', source.snapshot + '?' + view.tick);
      images.add(img);
      box.append(img);
    } else {
      box.append(h('span', { class: 'lpp-source-blank', text: source.kind === 'none' ? '∅' : '—' }));
    }

    box.append(h('span', { class: 'lpp-source-tag', text: source.label }));
    return box;
  }

  /* ----------------------------------------------------------------- rail */

  function railTabs() {
    const tab = (id, label) => h('button', {
      class: ['lpp-rail-tab', view.rail === id ? 'lpp-rail-tab--on' : ''],
      type: 'button',
      onClick: () => { view.rail = id; onRefresh(); }
    }, label);

    return h('div', { class: 'lpp-rail-tabs' }, tab('layer', 'Layer'), tab('memory', 'Memory'));
  }

  function railBody() {
    if (view.rail === 'memory') return memoryRail();
    properties.view.mode = EDIT;
    return h('div', { class: 'lpp-rail-body' }, properties.render());
  }

  /* --------------------------------------------------------------- memory */

  /**
   * Saving a look into a real memory slot.
   *
   * This is the one control on the page that touches the switcher, so it says
   * so, it names the slot before it fires, and it will not fire twice.
   * `onSave` does the work — see `core/preset-file.js` for what a save
   * actually is.
   */
  const ROUTES = [
    {
      id: 'direct',
      label: 'Direct',
      what: 'Writes the memory bank itself. No preset buffer is written and no take is fired, '
        + 'so neither preview nor program moves. Needs the switcher to be able to read the file '
        + 'this app writes — which it can when they are the same machine.'
    },
    {
      id: 'preview',
      label: 'Via preview',
      what: 'Puts the look into the preview buffer, fires the switcher\'s own save, then puts '
        + 'preview back property-for-property. Program never moves; preview shows the look for '
        + 'about a second and the bank will call it modified afterwards. Works on any switcher.'
    }
  ];

  function memoryRail() {
    const { dest } = selected();
    const slot = view.saving?.slot ?? '';
    const label = view.saving?.label ?? '';
    const route = view.saving?.route || 'direct';

    if (!dest || !programmer.has(dest)) {
      return h('div', { class: 'lpp-rail-body' },
        h('div', { class: 'wru-empty', text: 'Programme a destination first, then save it into a slot.' }));
    }

    const edit = (field) => (ev) => {
      view.saving = { ...(view.saving || {}), [field]: ev.target.value };
    };

    return h('div', { class: 'lpp-rail-body aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Save ' + dest + ' into a memory' }),
      h('label', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'Slot' }),
        h('input', {
          class: 'wru-input', type: 'number', min: '1', value: String(slot), onInput: edit('slot')
        })),
      h('label', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'Label' }),
        h('input', {
          class: 'wru-input', type: 'text', maxlength: '32', value: label, onInput: edit('label')
        })),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Route' }),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          ROUTES.map((r) => chip(r.label, route === r.id, () => {
            view.saving = { ...(view.saving || {}), route: r.id };
            onRefresh();
          })))),
      h('div', {
        class: 'aw-font-caption aw-text-tertiary',
        text: (ROUTES.find((r) => r.id === route) || ROUTES[0]).what
      }),
      button(view.busySave ? 'Saving…' : 'Save to memory', {
        iconId: 'shotbox-18',
        disabled: view.busySave || !onSave,
        onClick: () => saveMemory(dest)
      }),
      onLoad
        ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
          h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Load into the programmer' }),
          h('div', {
            class: 'aw-font-caption aw-text-tertiary',
            text: 'Reads the slot out of the bank — a memory\'s contents are not in the store, so '
              + 'this is the only way to see inside one.'
          }),
          button(view.busyLoad ? 'Loading…' : `Load memory ${slot || '—'} into ${dest}`, {
            disabled: view.busyLoad || !slot,
            onClick: () => loadMemory(dest)
          }))
        : null);
  }

  async function saveMemory(dest) {
    const slot = Number(view.saving?.slot);
    if (!Number.isFinite(slot) || slot < 1) { note('err', 'name a slot to save into'); return; }
    if (!onSave) { note('err', 'saving is not wired up'); return; }

    view.busySave = true;
    note('ok', `saving ${dest} into memory ${slot}…`);
    try {
      const result = await onSave({
        id: dest, slot, label: view.saving?.label || '', route: view.saving?.route || 'direct'
      });
      note(result && result.ok ? 'ok' : 'err', (result && result.message) || `memory ${slot} saved`);
    } catch (err) {
      note('err', `memory ${slot} not saved — ${err.message}`);
    } finally {
      view.busySave = false;
      onRefresh();
    }
  }

  async function loadMemory(dest) {
    const slot = Number(view.saving?.slot);
    if (!Number.isFinite(slot) || slot < 1) { note('err', 'name a slot to load'); return; }

    view.busyLoad = true;
    note('ok', `reading memory ${slot}…`);
    try {
      const result = await onLoad({ id: dest, slot });
      note(result && result.ok ? 'ok' : 'err',
        (result && result.message) || `memory ${slot} loaded into ${dest}`);
    } catch (err) {
      note('err', `memory ${slot} not loaded — ${err.message}`);
    } finally {
      view.busyLoad = false;
      onRefresh();
    }
  }

  return { render, view, start, stop, select, busy: () => !!dragging || view.busySave };
}
