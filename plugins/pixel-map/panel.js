/*
 * Pixel Map — the tab on the Screens / Aux. strip.
 *
 * One row per destination in service: which image from the switcher's
 * library is its map, how it is combined with the layers, how strongly, and
 * whether it is drawn 1:1 or stretched. Above them, one switch for all of
 * them and which buffers they go over. Nothing here writes to the switcher.
 *
 * ## It redraws in place
 *
 * The app repaints every panel on every frame from the switcher, about once a
 * second. A rebuilt `<select>` closes under the operator's pointer and a
 * rebuilt slider drops the drag, so `render()` hands back the same element
 * while nothing it shows has changed, and `busy()` holds repaints off while
 * the pointer is down in the panel. The opacity slider changes the map as it
 * moves and saves when it is let go.
 *
 * ⚠️ Not "while a control has focus". A `<select>` keeps focus after a pick,
 * so that held every repaint off until the operator clicked elsewhere: an
 * image uploaded meanwhile never reached the list, and the next pick was made
 * from a stale one. Pressed is the only state a repaint can actually break.
 * A native dropdown can swallow the release, so a change ends it too.
 */

import { h, fill, note } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { MODES, FITS, BUFFERS, DEFAULT_MAP, imageLabel, withMap } from './core.js';

/**
 * @param {object} o
 * @param {() => object} o.doc              the document, normalised
 * @param {(next: object, opts?: {save?: boolean}) => void} o.change
 * @param {() => object[]} o.destinations   in service, `{id, label, canvas}`
 * @param {() => object[]} o.images         the library, `dialect.libraryImages`
 * @param {() => Map} o.plan                `core.plan` for now
 * @param {() => object} o.describe         what the overlay last drew
 * @param {() => boolean} o.ready           the switcher has answered
 */
export function createPixelMapPanel({ doc, change, destinations, images, plan, describe, ready }) {
  let root = null;
  let shown = null;

  const select = (choices, current, onPick, attrs = {}) =>
    h('select', { class: 'wru-input', onChange: (ev) => onPick(ev.target.value), ...attrs },
      choices.map((c) => h('option', { value: c.id, selected: c.id === current ? 'selected' : null, text: c.label })));

  const labelled = (label, control) =>
    h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { flex: '1 1 6rem', minWidth: '0' } },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  function toolbar(d) {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Pixel Map' }),
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-small aw-margin-left-auto', title: 'Show or hide every map at once' },
        h('input', {
          type: 'checkbox', checked: d.visible ? 'checked' : null,
          onChange: (ev) => change({ ...doc(), visible: ev.target.checked })
        }),
        h('span', { class: 'aw-font-caption', text: 'Show' })),
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', title: BUFFERS.find((b) => b.id === d.buffers).what },
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'On' }),
        select(BUFFERS, d.buffers, (v) => change({ ...doc(), buffers: v }), { style: { width: '5.5rem' } })));
  }

  function row(dest, d, lib, planned) {
    const map = d.maps[dest.id] || null;
    const entry = planned.get(dest.id);
    const current = map || DEFAULT_MAP;
    const size = dest.canvas && dest.canvas.width ? `${dest.canvas.width}×${dest.canvas.height}` : '';
    const set = (patch, opts) => change(withMap(doc(), dest.id, patch), opts);

    const choices = [{ id: '', label: 'None' }, ...lib.map((i) => ({ id: String(i.slot), label: imageLabel(i) }))];
    /* A map pointing at a slot that has since been emptied keeps its entry —
       the file may be on its way back — and says so rather than vanishing. */
    if (map && !lib.some((i) => i.slot === map.slot)) choices.push({ id: String(map.slot), label: `${map.slot} · empty slot` });

    const pct = h('span', { class: 'aw-font-caption aw-text-tertiary', text: `${Math.round(current.opacity * 100)}%` });
    const slider = h('input', {
      type: 'range', min: '0', max: '100', step: '5', value: String(Math.round(current.opacity * 100)),
      disabled: map ? null : 'disabled', style: { flex: '1 1 auto', minWidth: '4rem' },
      'aria-label': `${dest.id} map opacity`,
      onInput: (ev) => { pct.textContent = `${ev.target.value}%`; set({ opacity: Number(ev.target.value) / 100 }, { save: false }); },
      onChange: (ev) => set({ opacity: Number(ev.target.value) / 100 })
    });

    const thumb = entry && entry.image
      ? h('img', {
        src: entry.image.thumb, alt: '', draggable: 'false',
        style: { width: '4rem', height: '2.25rem', objectFit: 'contain', background: '#000', borderRadius: '0.2rem', flex: 'none' }
      })
      : null;

    return h('div', { class: 'aw-flex-col aw-gap-row-small', dataset: { lppPixelMapRow: dest.id } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('div', { class: 'aw-font-body-1-bold', text: dest.id }),
        h('div', { class: 'aw-font-caption aw-text-tertiary', text: [dest.label, size].filter(Boolean).join(' · ') }),
        h('div', { class: 'aw-margin-left-auto' }),
        thumb),
      labelled('Image', select(choices, map ? String(map.slot) : '', (v) => set({ slot: v === '' ? null : Number(v) }),
        { 'aria-label': `${dest.id} map image` })),
      h('div', { class: 'aw-flex-row aw-gap-col-small' },
        labelled('Mode', select(MODES, current.mode, (v) => set({ mode: v }),
          { disabled: map ? null : 'disabled', title: MODES.find((m) => m.id === current.mode).what })),
        labelled('Fit', select(FITS, current.fit, (v) => set({ fit: v }),
          { disabled: map ? null : 'disabled', title: FITS.find((f) => f.id === current.fit).what }))),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Opacity' }), slider, pct),
      entry && entry.missing ? note('warn', `Library slot ${entry.missing} is empty now. Load the map again, or pick another.`) : null,
      ...(entry && entry.notes ? entry.notes.map((n) => note('warn', n)) : []));
  }

  function status(d, planned, seen) {
    const wanted = [...planned.values()].filter((e) => e.image).length;
    if (!d.visible) return note('', 'Hidden. Nothing is drawn until Show is ticked.');
    if (!wanted) return note('', 'Pick an image for a screen and it is drawn over that screen’s canvas, here on Screens / Aux. It uses no layer and nothing is written to the switcher.');
    if (!seen.cards) return note('warn', 'No screen cards found on this page — the map is drawn on the Screens / Aux. cards, so it shows once they are.');
    const parts = [`Drawn over ${seen.drawn} buffer${seen.drawn === 1 ? '' : 's'}.`];
    if (seen.notDrawn.length) parts.push(`${seen.notDrawn.join(', ')}: card or buffer not on the page.`);
    if (seen.top) parts.push('Some cards are laid out differently from the ones this was built against, so the map is over the selection handles there.');
    if (seen.blocks && !seen.rasters) return note('warn', 'The screen cards are here but their canvases could not be found — a firmware that draws them differently. Nothing is drawn.');
    return note(seen.top ? 'warn' : '', parts.join(' '));
  }

  function body(d, dests, lib, planned, seen) {
    if (!ready()) return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting for the switcher…' });
    return h('div', { class: 'aw-flex-col aw-gap-row-big' },
      lib.length ? null : note('warn', 'The switcher’s image library is empty. Load a pixel map on the Image Library page first — any PNG or JPEG, ideally the size of the screen’s canvas.'),
      dests.length ? dests.map((dest) => row(dest, d, lib, planned)) : note('', 'No screens or auxiliaries in service.'),
      status(d, planned, seen));
  }

  /** Everything the panel shows, as one string: unchanged means nothing to redraw. */
  function signature(d, dests, lib, seen) {
    return JSON.stringify([
      ready(), d,
      dests.map((x) => [x.id, x.label, x.canvas && x.canvas.width, x.canvas && x.canvas.height]),
      lib.map((i) => [i.slot, i.version, i.fileName, i.width, i.height]),
      seen
    ]);
  }

  let pressed = false;
  const busy = () => pressed;

  /** Track presses in the panel, once, when it is first built. */
  function watch(el) {
    el.addEventListener('pointerdown', () => { pressed = true; });
    el.addEventListener('change', () => { pressed = false; });
    if (typeof document !== 'undefined') {
      const release = () => { pressed = false; };
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }
  }

  function render() {
    const d = doc();
    const dests = ready() ? destinations() : [];
    const lib = ready() ? images() : [];
    const planned = plan();
    const seen = describe();
    const sig = signature(d, dests, lib, seen);
    if (root && sig === shown) return root;
    if (root && busy()) return root;
    const fresh = panel({ toolbar: toolbar(d), body: body(d, dests, lib, planned, seen) });
    if (root) fill(root, ...fresh.childNodes);
    else { root = fresh; watch(root); }
    shown = sig;
    return root;
  }

  return { render, busy };
}
