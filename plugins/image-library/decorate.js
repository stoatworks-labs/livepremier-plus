/*
 * Image Library tools — the controls, put into the vendor's own pages.
 *
 * ## ⚠️ This writes into the middle of Web RCS's markup
 *
 * Like the layer names and Pixel Map, and for the same reason: the controls
 * are only any use where the operator already is — the Image Library page
 * for deleting and uploading, the Images page for a still's capacity. A
 * firmware that restructures either page makes the controls not appear,
 * quietly; `describe()` counts what was found, for the tests and for anyone
 * looking at a page with no buttons on it.
 *
 * ## What is matched, and why
 *
 * Read off a running Web RCS (LivePremier Simulator 6.2.73, 2026-10-20):
 *
 *   /image-library   the page's `h1` "Image Library" in a `.aw-header`, which
 *                    also holds the size counter. The toolbar goes on the end
 *                    of that header. The cards are a `.aw-grid.aw-cols-4` of
 *                    200 lazy wrappers; a filled one holds an `.aw-card` whose
 *                    header's `.aw-font-bold` is the slot number, and whose
 *                    `.aw-card__content` is the picture.
 *   /images          one `.aw-card` per still; its footer header's
 *                    `.aw-padding-left-medium` is the still number and its
 *                    `.aw-header__items.aw-margin-left-auto` holds the tally
 *                    and the ⋮ menu. The capacity dropdown goes first in that.
 *
 * Plain utility classes only, no build hashes, so a restyle that keeps the
 * structure keeps the controls.
 *
 * ## Clicks
 *
 * A filled library card is a drop zone: a click on its picture opens a file
 * picker to replace it. While selecting, a layer of ours covers each filled
 * card's picture and takes the click — `stopPropagation` on it means the
 * vendor's React handlers, which listen at the root, never hear it. The
 * dropdown stops its own clicks the same way, so a pick does not open the
 * still's page.
 *
 * ## A zip dropped on the page
 *
 * The vendor's drop zones take pictures only, and would refuse a zip. A drop
 * on the Image Library page that carries a zip is caught on the way down
 * (capture, on the document) and handled here, loose pictures with it; a
 * drop without one is left alone for the vendor.
 *
 * ## Never in a loop
 *
 * The sweep runs off a MutationObserver on the whole page, which our own
 * insertions trip too. So each piece is only rebuilt when what it shows has
 * changed (`data-lpp-sig`), and a settled sweep changes nothing.
 */

import { h, button } from '../../src/ui/dom.js';
import { sweeper } from '../../src/ui/canvas-overlay.js';
import { capacityLabel } from './core.js';

const BAR = 'data-lpp-library-tools';
const PICK = 'data-lpp-pick';
const CAP = 'data-lpp-capacity';
const SIG = 'data-lpp-sig';
const ZIP_TYPES = new Set(['application/zip', 'application/x-zip-compressed', 'application/x-zip']);
export const isZip = (file) => /\.zip$/i.test((file && file.name) || '') || ZIP_TYPES.has(file && file.type);

const STYLE_ID = 'lpp-image-library-css';
const CSS = `
[${BAR}] { display: flex; align-items: center; flex-wrap: wrap; gap: 0.5rem; margin-left: auto; }
[${BAR}] .lpp-libtools-status { font-size: 0.916667rem; color: #A9B1B7; white-space: nowrap; max-width: 28rem; overflow: hidden; text-overflow: ellipsis; }
[${BAR}] .lpp-libtools-status.is-warn { color: #F39910; }
[${BAR}] .lpp-libtools-status.is-ok { color: #7FD13B; }
[${PICK}] { position: absolute; inset: 0; z-index: 20; cursor: pointer; background: rgba(8,20,27,0.35); box-sizing: border-box; }
[${PICK}].is-on { background: rgba(33,133,208,0.25); outline: 0.25rem solid #2185D0; outline-offset: -0.25rem; }
[${PICK}] .lpp-libtools-tick { position: absolute; left: 0.5rem; top: 0.5rem; width: 1.5rem; height: 1.5rem; border-radius: 50%;
  border: 0.15rem solid #fff; background: rgba(0,0,0,0.4); color: #fff; font-weight: 700; line-height: 1.3rem; text-align: center; font-size: 1rem; }
[${PICK}].is-on .lpp-libtools-tick { background: #2185D0; border-color: #2185D0; }
/* The vendor's own hover art — "Drop image" over the picture — would show
   through a selected card's tint; while selecting, a click is ours anyway. */
[data-lpp-selecting] [class*="library-card-upload-container"] { visibility: hidden !important; }
select[${CAP}] { width: auto; min-width: 0; font-size: 0.833333rem; padding: 0 0.166667rem; height: 1.5rem; }
`;

function styles(doc) {
  try {
    if (!doc.head || doc.getElementById(STYLE_ID)) return;
    const el = doc.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    doc.head.append(el);
  } catch { /* unstyled rather than not drawn */ }
}

const stop = (ev) => { ev.stopPropagation(); };
const intText = (el) => {
  const t = el ? String(el.textContent || '').trim() : '';
  return /^\d+$/.test(t) ? Number(t) : null;
};

/**
 * @param {object} o
 * @param {() => boolean} o.enabled
 * @param {object} o.actions  what the controls call — `client.js`:
 *   `filled()` the filled slots; `status()` `{ busy, text, tone }`;
 *   `deleteSlots(slots, {all})`, `upload(files)`, `stop()`;
 *   `capacity(key)` the dropdown's view (`core.capacityView`) or null;
 *   `capacityBusy()` the still being changed, or null; `setCapacity(key, to)`;
 *   `assigned()` / `setAssigned(on)`, whether an upload may fill an empty
 *   slot a still points at
 * @param {Document} [o.doc]
 * @param {{pathname: string}} [o.loc]
 */
export function installLibraryTools({ enabled, actions, doc = document, loc = (typeof location !== 'undefined' ? location : { pathname: '/' }) }) {
  let selecting = false;
  const selected = new Set();
  let anchor = null;
  let last = { bar: false, cards: 0, picks: 0, stills: 0, dropdowns: 0 };

  const onLibraryPage = () => /^\/image-library(\/|$)/.test(loc.pathname || '');
  const onImagesPage = () => /^\/images(\/|$)/.test(loc.pathname || '');

  /* ------------------------------------------------------------ selection */

  function setSelecting(on) {
    selecting = on;
    if (!on) { selected.clear(); anchor = null; }
    refresh();
  }

  function pick(slot, ev) {
    if (ev && ev.shiftKey && anchor != null) {
      const lo = Math.min(anchor, slot);
      const hi = Math.max(anchor, slot);
      const want = !selected.has(slot) || selected.has(anchor);
      for (const s of actions.filled()) if (s >= lo && s <= hi) { if (want) selected.add(s); else selected.delete(s); }
    } else if (selected.has(slot)) selected.delete(slot);
    else selected.add(slot);
    anchor = slot;
    refresh();
  }

  /* -------------------------------------------------------------- toolbar */

  const fileInput = () => {
    const input = h('input', { type: 'file', accept: '.zip,application/zip,application/x-zip-compressed', multiple: 'multiple', style: { display: 'none' } });
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length) void actions.upload(files);
    });
    return input;
  };

  function barContent(bar) {
    const st = actions.status() || {};
    const filled = actions.filled();
    const status = h('span', {
      class: ['lpp-libtools-status', st.tone === 'warn' ? 'is-warn' : '', st.tone === 'ok' ? 'is-ok' : ''],
      title: st.text || null,
      text: st.text || ''
    });
    if (st.busy) {
      return { sig: `busy|${st.text}`, nodes: [status, button('Stop', { variant: 'danger', onClick: () => actions.stop(), title: 'Stop after the one in hand' })] };
    }
    if (selecting) {
      const n = [...selected].filter((s) => filled.includes(s)).length;
      return {
        sig: `sel|${n}|${filled.length}|${st.text}`,
        nodes: [
          status,
          h('span', { class: 'lpp-libtools-status', text: `${n} selected` }),
          button('All', { onClick: () => { for (const s of actions.filled()) selected.add(s); refresh(); }, title: 'Select every image' }),
          button('None', { onClick: () => { selected.clear(); refresh(); }, title: 'Clear the selection' }),
          button('Delete selected', {
            variant: 'danger', iconId: 'bin-12', disabled: n === 0,
            onClick: () => {
              const slots = [...selected].filter((s) => actions.filled().includes(s));
              void actions.deleteSlots(slots, { all: false }).then((done) => { if (done) setSelecting(false); });
            }
          }),
          button('Done', { variant: 'ghost', onClick: () => setSelecting(false), title: 'Stop selecting (Esc)' })
        ]
      };
    }
    const assigned = Boolean(actions.assigned && actions.assigned());
    return {
      sig: `idle|${filled.length}|${st.text}|${st.tone}|${assigned}`,
      nodes: [
        status,
        button('Select', { disabled: !filled.length, onClick: () => setSelecting(true), title: 'Pick images to delete: click a card, shift-click for a run' }),
        button('Delete all', {
          variant: 'danger', iconId: 'bin-12', disabled: !filled.length,
          onClick: () => void actions.deleteSlots(actions.filled(), { all: true }), title: 'Delete every image in the library'
        }),
        button('Upload .zip', {
          onClick: () => { const input = bar.querySelector('input[type="file"]'); if (input) input.click(); },
          title: 'A zip of pictures, unpacked here into the free slots in name order. Or drop it on this page.'
        }),
        h('label', {
          class: 'lpp-libtools-status', style: { display: 'flex', alignItems: 'center', gap: '0.25rem', cursor: 'pointer' },
          title: 'An empty slot a still points at is skipped unless this is ticked: the still shows whatever goes into it, on air if it is on a bus. Ticked, those slots are used after every clean one, and the question names each still.'
        },
        h('input', { type: 'checkbox', 'data-lpp-assigned': '', checked: assigned ? 'checked' : null, onChange: (ev) => actions.setAssigned(Boolean(ev.target.checked)) }),
        'Use assigned slots')
      ]
    };
  }

  function sweepBar(report) {
    const h1 = [...doc.querySelectorAll('h1')].find((el) => String(el.textContent || '').trim() === 'Image Library');
    const header = h1 && h1.closest('.aw-header');
    let bar = doc.querySelector(`[${BAR}]`);
    if (!header) { if (bar) bar.remove(); return; }
    report.bar = true;
    if (!bar || bar.parentNode !== header) {
      if (bar) bar.remove();
      bar = h('div', { [BAR]: '', class: 'aw-header__items' }, h('span', { 'data-lpp-bar-body': '' }), fileInput());
      header.append(bar);
    }
    const { sig, nodes } = barContent(bar);
    if (bar.getAttribute(SIG) === sig) return;
    bar.setAttribute(SIG, sig);
    const body = bar.querySelector('[data-lpp-bar-body]');
    body.replaceChildren(...nodes);
    body.style.display = 'contents';
  }

  /* --------------------------------------------------------- card ticks */

  function sweepPicks(report) {
    const grid = doc.querySelector('.aw-grid.aw-cols-4');
    const keep = new Set();
    const filled = new Set(actions.filled());
    if (grid) {
      /* An attribute, not a node: it does not trip the sweep's observer. */
      if (grid.hasAttribute('data-lpp-selecting') !== selecting) grid.toggleAttribute('data-lpp-selecting', selecting);
    }
    for (const g of doc.querySelectorAll('[data-lpp-selecting]')) if (g !== grid || !selecting) g.removeAttribute('data-lpp-selecting');
    if (grid && selecting) {
      for (const card of grid.querySelectorAll('.aw-card')) {
        report.cards += 1;
        const slot = intText(card.querySelector('.aw-header .aw-font-bold'));
        const content = card.querySelector('.aw-card__content');
        if (slot == null || !content || !filled.has(slot)) continue;
        let layer = content.querySelector(`[${PICK}]`);
        if (!layer || Number(layer.getAttribute(PICK)) !== slot) {
          if (layer) layer.remove();
          layer = h('div', { [PICK]: String(slot), role: 'checkbox', title: `Slot ${slot}` }, h('span', { class: 'lpp-libtools-tick' }));
          for (const type of ['pointerdown', 'mousedown', 'dragstart']) layer.addEventListener(type, (ev) => { ev.preventDefault(); stop(ev); });
          layer.addEventListener('click', (ev) => { ev.preventDefault(); stop(ev); pick(Number(layer.getAttribute(PICK)), ev); });
          content.append(layer);
        }
        const on = selected.has(slot);
        /* Attribute and class changes are not child-list changes: they do
           not trip the sweep's observer. */
        if (layer.classList.contains('is-on') !== on) layer.classList.toggle('is-on', on);
        if (layer.getAttribute('aria-checked') !== String(on)) layer.setAttribute('aria-checked', String(on));
        const tick = layer.firstElementChild;
        if (tick && tick.textContent !== (on ? '✓' : '')) tick.textContent = on ? '✓' : '';
        keep.add(layer);
        report.picks += 1;
      }
    }
    for (const node of doc.querySelectorAll(`[${PICK}]`)) if (!keep.has(node)) node.remove();
  }

  /* ------------------------------------------------------ capacity menus */

  function dropdown(key) {
    const sel = h('select', { [CAP]: String(key), class: 'wru-input', title: 'Capacity' });
    for (const type of ['click', 'pointerdown', 'mousedown', 'dragstart']) sel.addEventListener(type, stop);
    sel.addEventListener('change', () => {
      const to = sel.value;
      sel.disabled = true;
      void actions.setCapacity(key, to).finally(() => { sel.removeAttribute(SIG); refresh(); });
    });
    return sel;
  }

  function paintDropdown(sel, view, busy) {
    const sig = `${view.current}|${view.choices.map((c) => c.capability).join(',')}|${view.disabled || ''}|${busy || ''}`;
    if (sel.getAttribute(SIG) === sig) return;
    /* Never under the operator's hand: an open list rebuilt is a list that
       closes, or a pick that lands on the wrong row. */
    if (doc.activeElement === sel) return;
    sel.setAttribute(SIG, sig);
    const caps = view.choices.map((c) => c.capability);
    const all = view.current && !caps.includes(view.current) ? [view.current, ...caps] : caps;
    sel.replaceChildren(...all.map((c) => h('option', {
      value: c, text: capacityLabel(c),
      selected: c === view.current ? 'selected' : null,
      disabled: caps.includes(c) ? null : 'disabled'
    })));
    sel.value = view.current || '';
    const why = busy === view.key ? 'Applying…' : busy ? 'Another capacity change is being applied.' : view.disabled;
    sel.disabled = Boolean(why);
    sel.title = why ? `Capacity — ${why}` : 'Capacity: applied in Preconfig ▸ Images when you pick one, after a question';
  }

  function sweepDropdowns(report) {
    const keep = new Set();
    const busy = actions.capacityBusy();
    for (const num of doc.querySelectorAll('.aw-card .aw-header__items > .aw-padding-left-medium')) {
      const key = intText(num);
      const header = num.closest('.aw-header');
      const tools = header && header.querySelector('.aw-header__items.aw-margin-left-auto');
      if (key == null || !tools) continue;
      report.stills += 1;
      const view = actions.capacity(String(key));
      if (!view) continue;
      let sel = tools.querySelector(`select[${CAP}]`);
      if (!sel || sel.getAttribute(CAP) !== String(key)) {
        if (sel) sel.remove();
        sel = dropdown(String(key));
        tools.prepend(sel);
      }
      paintDropdown(sel, view, busy);
      keep.add(sel);
      report.dropdowns += 1;
    }
    for (const node of doc.querySelectorAll(`select[${CAP}]`)) if (!keep.has(node)) node.remove();
  }

  /* ----------------------------------------------------------------- sweep */

  let halted = false;

  function sweep() {
    /* A sweep already scheduled when `stop()` ran finds nothing to do. */
    if (halted) return;
    const report = { bar: false, cards: 0, picks: 0, stills: 0, dropdowns: 0 };
    const on = enabled();
    if (on) styles(doc);
    if (on && onLibraryPage()) {
      sweepBar(report);
      sweepPicks(report);
    } else {
      if (selecting) { selecting = false; selected.clear(); anchor = null; }
      for (const node of doc.querySelectorAll(`[${BAR}], [${PICK}]`)) node.remove();
      for (const g of doc.querySelectorAll('[data-lpp-selecting]')) g.removeAttribute('data-lpp-selecting');
    }
    if (on && onImagesPage()) sweepDropdowns(report);
    else for (const node of doc.querySelectorAll(`select[${CAP}]`)) node.remove();
    last = report;
  }

  /* ---------------------------------------------------------- drop a zip */

  const zipDrag = (ev) => {
    const items = Array.from((ev.dataTransfer && ev.dataTransfer.items) || []);
    return items.some((i) => i.kind === 'file' && ZIP_TYPES.has(i.type));
  };
  function onDragOver(ev) {
    if (!enabled() || !onLibraryPage() || !zipDrag(ev)) return;
    /* Lets the drop land outside the vendor's own zones too. */
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }
  function onDrop(ev) {
    if (!enabled() || !onLibraryPage()) return;
    const files = Array.from((ev.dataTransfer && ev.dataTransfer.files) || []);
    if (!files.some(isZip)) return;
    ev.preventDefault();
    ev.stopPropagation();
    if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
    if (!actions.status().busy) void actions.upload(files);
  }
  function onKey(ev) {
    if (!selecting || ev.key !== 'Escape') return;
    const t = ev.target;
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || '')) return;
    setSelecting(false);
  }
  doc.addEventListener('dragover', onDragOver, true);
  doc.addEventListener('drop', onDrop, true);
  doc.addEventListener('keydown', onKey, true);

  const sweeps = sweeper(sweep, doc);
  const refresh = sweeps.refresh;
  refresh();

  return {
    refresh,
    /** Run a sweep now — for tests. */
    sweepNow: sweep,
    /** What the last sweep found and decorated. A zero is how a moved page shows up. */
    describe: () => ({ ...last }),
    /** The selection, for tests. */
    selection: () => ({ selecting, selected: [...selected].sort((a, b) => a - b) }),
    /** For tests and for the drop path: what a drop on the page does. */
    handlers: { onDrop, onDragOver, onKey },
    stop() {
      halted = true;
      sweeps.stop();
      doc.removeEventListener('dragover', onDragOver, true);
      doc.removeEventListener('drop', onDrop, true);
      doc.removeEventListener('keydown', onKey, true);
      for (const node of doc.querySelectorAll(`[${BAR}], [${PICK}], select[${CAP}]`)) node.remove();
      for (const g of doc.querySelectorAll('[data-lpp-selecting]')) g.removeAttribute('data-lpp-selecting');
    }
  };
}
