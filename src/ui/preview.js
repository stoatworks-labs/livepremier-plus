/*
 * Screen and auxiliary previews, composed the way Web RCS composes them.
 *
 * There is no picture to fetch — see the header of `core/screens.js`. A
 * destination is drawn as its canvas rectangle with one absolutely-positioned
 * box per allocated layer, each box filled with the snapshot of the source it
 * is showing. That is exactly what the vendor's screen card is.
 *
 * ## Snapshots come off one clock, not one per image
 *
 * Every visible layer showing the same input wants the same picture, and the
 * device is a switcher, not a web server. So a single interval bumps one
 * shared cache-buster and every `<img>` in the popout re-requests together.
 * Per-image timers would have produced a ragged stream of requests at
 * whatever rate the number of layers happened to be.
 *
 * The URL is cache-busted rather than merely re-set, because the browser will
 * otherwise serve the first PNG forever — the device sends no cache headers
 * that would stop it. This is the vendor's own trick: its input thumbnails
 * are `/api/device/snapshots/inputs/1?<epoch-ms>`.
 *
 * ## Refreshing is paused when nothing can be seen
 *
 * `document.hidden` stops the clock. A popout left open behind a full-screen
 * vendor window would otherwise keep asking a switcher for pictures nobody is
 * looking at, all show.
 */

import { h } from './dom.js';
import { listDestinations, readLayers, sourceLabel } from '../core/screens.js';

/* Vendor input thumbnails move at about 1 Hz. Matching that is enough for a
   confidence view and is the rate the device is already producing. */
const DEFAULT_PERIOD_MS = 1000;

export const SIZES = [
  { id: 'small', label: 'S', width: 180 },
  { id: 'medium', label: 'M', width: 260 },
  { id: 'large', label: 'L', width: 380 },
  { id: 'huge', label: 'XL', width: 560 }
];

/**
 * A wall of destination previews.
 *
 * @param {{session: object, onRefresh?: Function, doc?: Document}} opts
 */
export function createPreviewWall({ session, onRefresh = () => {}, doc = document }) {
  const state = {
    /* null means "everything in service", which is the vendor's ALL. Kept as
       null rather than as a filled-in set so a screen that comes into service
       mid-show appears instead of being silently outside a stale selection. */
    screens: null,
    auxes: null,
    showProgram: true,
    showPreview: true,
    size: 'medium',
    /* Bumped on a timer; every snapshot URL carries it. */
    tick: Date.now(),
    period: DEFAULT_PERIOD_MS
  };

  let timer = null;
  const images = new Set();

  function start() {
    stop();
    timer = setInterval(() => {
      if (doc.hidden) return;
      state.tick = Date.now();
      /* Repointing the live `<img>` nodes directly, rather than repainting the
         whole wall: a full re-render every second would fight the operator's
         scroll position and rebuild several hundred nodes for no reason. */
      for (const img of images) {
        if (!img.isConnected) { images.delete(img); continue; }
        const base = img.dataset.lppSnapshot;
        if (base) img.setAttribute('src', base + '?' + state.tick);
      }
    }, state.period);
  }

  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  /* ------------------------------------------------------------- filters */

  /** The destinations to draw, after the filters. */
  function chosen() {
    const all = listDestinations(session.store);
    return all.filter((d) => {
      const pick = d.kind === 'screen' ? state.screens : state.auxes;
      return pick === null ? true : pick.includes(d.id);
    });
  }

  /** Everything that exists, for the filter controls to offer. */
  function offered() {
    return listDestinations(session.store);
  }

  function toggle(kind, id) {
    const key = kind === 'screen' ? 'screens' : 'auxes';
    const available = offered().filter((d) => d.kind === kind).map((d) => d.id);
    const current = state[key] === null ? available.slice() : state[key].slice();
    const at = current.indexOf(id);
    if (at >= 0) current.splice(at, 1); else current.push(id);
    /* Back to ALL when everything is picked, so the selection keeps tracking
       the device rather than freezing at today's list. */
    state[key] = current.length === available.length ? null : current;
    onRefresh();
  }

  function setAll(kind) {
    state[kind === 'screen' ? 'screens' : 'auxes'] = null;
    onRefresh();
  }

  /* -------------------------------------------------------------- render */

  const sizeOf = () => (SIZES.find((s) => s.id === state.size) || SIZES[1]).width;

  function render() {
    const dests = chosen();
    const wall = h('div', { class: 'lpp-wall' },
      dests.length
        ? dests.map((d) => card(d))
        : h('div', { class: 'wru-empty', text: session.store.ready
          ? 'No screens or auxiliaries in service match the filter.'
          : 'Waiting for the device store.' }));
    return wall;
  }

  function card(dest) {
    const width = sizeOf();
    const stages = [];
    if (state.showProgram) stages.push(stage(dest, dest.banks.program, 'PGM', 'pgm'));
    if (state.showPreview) stages.push(stage(dest, dest.banks.preview, 'PRW', 'prw'));

    return h('div', { class: 'lpp-card', style: { width: width + 'px' } },
      h('div', { class: 'lpp-card-head aw-flex-row-center-v aw-gap-col-small' },
        h('span', { class: 'aw-font-body-1-bold', text: dest.id }),
        dest.label ? h('span', { class: 'aw-text-secondary aw-text-ellipsis', text: dest.label }) : null,
        h('div', { style: { flex: '1' } }),
        dest.isTransitioning ? h('span', { class: 'wru-tag wru-warn', text: 'TAKE' }) : null,
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: `${dest.layerCount ?? '?'}L` })),
      stages.length ? stages : h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'No view selected' }));
  }

  function stage(dest, bank, label, tone) {
    const layers = readLayers(session.store, dest, bank);
    const ratio = (dest.canvas.height / dest.canvas.width) * 100;

    const frame = h('div', { class: ['lpp-stage', 'lpp-stage--' + tone] },
      h('div', { class: 'lpp-stage-pad', style: { paddingTop: ratio + '%' } }),
      h('div', { class: 'lpp-stage-inner' }, layers.map(layerBox)),
      h('span', { class: ['lpp-stage-tag', 'lpp-stage-tag--' + tone], text: label }));

    return frame;
  }

  function layerBox(layer) {
    const pct = (n) => (n * 100).toFixed(4) + '%';
    const box = h('div', {
      class: ['lpp-layer', layer.isNative ? 'lpp-layer--native' : ''],
      style: {
        left: pct(layer.frac.left),
        top: pct(layer.frac.top),
        width: pct(layer.frac.width),
        height: pct(layer.frac.height),
        opacity: String(layer.opacity)
      },
      title: `${layer.label} · ${layer.source}`
    });

    if (layer.snapshot) {
      const img = h('img', { class: 'lpp-layer-img', alt: '', decoding: 'async' });
      /* The base URL is kept on the node so the shared clock can re-bust it
         without re-deriving anything. */
      img.dataset.lppSnapshot = layer.snapshot;
      img.setAttribute('src', layer.snapshot + '?' + state.tick);
      images.add(img);
      box.append(img);
    }

    const name = sourceLabel(layer.source);
    box.append(h('span', { class: 'lpp-layer-tag', text: name ? `${layer.label} ${name}` : layer.label }));
    return box;
  }

  /* ------------------------------------------------------------ controls */

  /**
   * The filter bar, in the vendor's own idiom: an ALL chip and one per
   * destination, a PGM/PRW pair, and a size step.
   */
  function controls() {
    const all = offered();
    const screens = all.filter((d) => d.kind === 'screen');
    const auxes = all.filter((d) => d.kind === 'aux');

    const chip = (text, on, onClick, extra) => h('button', {
      class: ['lpp-chip', on ? 'lpp-chip--on' : '', extra || ''],
      type: 'button', onClick
    }, text);

    const group = (label, kind, list) => {
      if (!list.length) return null;
      const pick = kind === 'screen' ? state.screens : state.auxes;
      return h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
        chip('ALL', pick === null, () => setAll(kind)),
        list.map((d) => chip(d.id, pick === null || pick.includes(d.id), () => toggle(kind, d.id))));
    };

    return h('div', { class: 'lpp-controls aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
      group('Screens', 'screen', screens),
      group('Aux.', 'aux', auxes),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Views' }),
        chip('PGM', state.showProgram, () => { state.showProgram = !state.showProgram; onRefresh(); }, 'lpp-chip--pgm'),
        chip('PRW', state.showPreview, () => { state.showPreview = !state.showPreview; onRefresh(); }, 'lpp-chip--prw')),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Size' }),
        SIZES.map((s) => chip(s.label, state.size === s.id, () => { state.size = s.id; onRefresh(); }))));
  }

  return { render, controls, start, stop, state };
}
