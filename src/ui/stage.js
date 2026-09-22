/*
 * One buffer of one destination, drawn.
 *
 * Web RCS's screen card is not a picture the device sends — there is no screen
 * snapshot endpoint, see `core/screens.js`. It is composed in the browser:
 * the canvas as a rectangle, one absolutely-positioned box per allocated
 * layer, each filled with the snapshot of whatever source it is showing.
 *
 * This was inside `ui/preview.js` until the Edit page needed the same picture
 * with a click and a drag on it. Two copies of the composition rules is how
 * the two pages come to disagree about what the desk looks like, so there is
 * one, and the interactive half is passed in rather than duplicated.
 *
 * ## The snapshots share one clock
 *
 * Every visible layer showing the same input wants the same picture, and the
 * device is a switcher rather than a web server. So callers keep one set of
 * live `<img>` nodes and one interval that re-busts all of them together;
 * `images` is that set, and this file only enrols into it. Per-image timers
 * would produce a ragged stream of requests at whatever rate the number of
 * layers happened to be.
 */

import { h } from './dom.js';
import { readLayers, sourceLabel } from '../core/screens.js';
import { layerLabel } from '../core/layer-names.js';

const pct = (n) => (n * 100).toFixed(4) + '%';

/**
 * Draw one buffer.
 *
 * @param {object} opts
 * @param {{get:Function}} opts.store
 * @param {{id:string, listName:string, canvas:object}} opts.dest
 * @param {string} opts.bank         a buffer key — a letter, or the programmer's
 * @param {string} [opts.label]      what to write in the corner: PGM, PRW, EDIT
 * @param {string} [opts.tone]       a class suffix — `pgm`, `prw`, `edit`
 * @param {number} [opts.tick]       the shared cache-buster
 * @param {Set<Element>} [opts.images]  the shared set of live snapshot nodes
 * @param {object} [opts.names]      layer names, for the tag on each box
 * @param {string|null} [opts.selected]  the layer key drawn as selected
 * @param {Function} [opts.onLayer]  (key, event) => void, makes the boxes clickable
 * @param {Function} [opts.onCanvas] (event) => void, a click on the empty canvas
 * @param {Function} [opts.decorate] (box, layer) => void, for handles and the like
 */
export function stage({
  store, dest, bank, label = '', tone = '', tick = 0, images = null,
  names = {}, selected = null, onLayer = null, onCanvas = null, decorate = null
}) {
  const layers = readLayers(store, dest, bank);
  const ratio = (dest.canvas.height / dest.canvas.width) * 100;

  const inner = h('div', { class: 'lpp-stage-inner' },
    layers.map((layer) => layerBox({
      layer, dest, store, tick, images, names, selected, onLayer, decorate
    })));

  return h('div', {
    class: ['lpp-stage', tone ? 'lpp-stage--' + tone : ''],
    onClick: onCanvas ? (ev) => { if (ev.target === inner) onCanvas(ev); } : null
  },
  h('div', { class: 'lpp-stage-pad', style: { paddingTop: ratio + '%' } }),
  inner,
  label ? h('span', { class: ['lpp-stage-tag', tone ? 'lpp-stage-tag--' + tone : ''], text: label }) : null);
}

function layerBox({ layer, dest, store, tick, images, names, selected, onLayer, decorate }) {
  const box = h('div', {
    class: [
      'lpp-layer',
      layer.isNative ? 'lpp-layer--native' : '',
      onLayer ? 'lpp-layer--pick' : '',
      selected != null && String(selected) === String(layer.key) ? 'lpp-layer--on' : ''
    ],
    style: {
      left: pct(layer.frac.left),
      top: pct(layer.frac.top),
      width: pct(layer.frac.width),
      height: pct(layer.frac.height),
      opacity: String(layer.opacity)
    },
    title: `${layer.label} · ${layer.source}`,
    onPointerDown: onLayer ? (ev) => onLayer(layer.key, ev) : null
  });

  if (layer.snapshot) {
    const img = h('img', { class: 'lpp-layer-img', alt: '', decoding: 'async', draggable: 'false' });
    /* The base URL lives on the node so the shared clock can re-bust it
       without re-deriving anything. */
    img.dataset.lppSnapshot = layer.snapshot;
    img.setAttribute('src', layer.snapshot + '?' + tick);
    if (images) images.add(img);
    box.append(img);
  }

  const source = sourceLabel(layer.source, store);
  /* The operator's own name for the slot wins over `L2`, because that is the
     point of having named it. `core/layer-names.js` keeps them; the device has
     nowhere to. */
  const named = layerLabel(names, dest.id, layer.key, { short: true });
  box.append(h('span', { class: 'lpp-layer-tag', text: [named, source].filter(Boolean).join(' ') }));

  if (decorate) decorate(box, layer);
  return box;
}
