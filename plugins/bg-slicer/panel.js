/*
 * Background Slicer — the panel. PLUS ▸ Backgrounds, and a window of its own.
 *
 * Top to bottom it is the job in the order it is done:
 *
 *   1. **Picture** — choose an image (or drop one); its pixel size. In the
 *      live mode a content size stands in when there is no picture.
 *   2. **Screens** — which in-service screens it goes on, each or spanned.
 *   3. **Placement** — each screen's canvas drawn the way the Screens / Aux.
 *      page draws one, its outputs on it (label, raster, plug, group,
 *      slices), the picture over them: drag it, type x / y / w / h, or use
 *      Fit, Fill, Stretch, 1:1, Centre. Spanned screens share one picture.
 *   4. **Plan** — before anything is written: the background set per screen,
 *      and per output the raster, the library slot and still it will use,
 *      the capacity it needs against what the still has, the content, what
 *      it replaces, and whether the cut is a pixel copy.
 *   5. **Generate** — the images, cut in the page; thumbnails; a zip.
 *   6. **Write** — confirmed, then step by step with the switcher's echo
 *      after each; a failure stops and says what was written, and Undo takes
 *      it back off.
 *   7. **Media server** — the live mode's map, as the files each media server
 *      can import and a universal pack for the rest.
 *
 * Immediate-mode like every panel here; the picture and what was generated
 * live in the shared job (`job.js`), not in the DOM, so a repaint loses
 * nothing and the popped-out window shows the same job. A drag holds repaints
 * (`busy()`) and moves its one element directly until the pointer lets go.
 *
 * ⚠️ Preview: never run against a real frame. The switcher's side of it was
 * proved on a LivePremier Simulator 6.2.73; whether a background lands the
 * way `core.js` says on rotated, grouped, sliced or pitched outputs is not —
 * the panel says so on the outputs it applies to.
 */

import { h, button, fill } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import {
  buildPlan, readScreens, screenTopology, readSets, firstFreeSet, presetPlacement, spanLayout, placementFor,
  NOTES, liveCandidates, suggestInputs, edidChoice, plugTemplates, imageName, readLibrary, LABEL_MAX
} from './core.js';
import { reconcile } from './job.js';
import { applyPlan, revert } from './apply.js';
import { decodePicture, renderOutput, renderTemplate, download } from './render.js';
import { zipStore } from './zip.js';
import { packFiles, templateList, templateShapes, TARGETS } from './exports.js';

const POPOUT = new URL('./popout.html', import.meta.url).href;
const STYLE_ID = 'lpp-bgs-style';

const CSS = `
.lpp-bgs-section { border-top: 0.083333rem solid #283239; padding-top: 0.833333rem; }
.lpp-bgs-row { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; }
.lpp-bgs-drop { border: 0.166667rem dashed #3A464E; border-radius: 0.333333rem; padding: 1rem; text-align: center; color: #838B91; }
.lpp-bgs-drop--over { border-color: #2185D0; color: #fff; }
.lpp-bgs-view { position: relative; width: 100%; max-width: 64rem; background: #050B0F; border: 0.083333rem solid #283239; border-radius: 0.25rem; overflow: hidden; }
.lpp-bgs-view-inner { position: absolute; inset: 0; }
.lpp-bgs-screen { position: absolute; box-sizing: border-box; border: 0.083333rem solid #616D75; background: #0D1D26; }
.lpp-bgs-screen-tag { position: absolute; left: 0.25rem; top: 0.166667rem; font-size: 0.833333rem; color: #838B91; white-space: nowrap; pointer-events: none; z-index: 3; }
.lpp-bgs-pic { position: absolute; opacity: 0.6; cursor: grab; user-select: none; z-index: 1; outline: 0.083333rem dashed #F39910; }
.lpp-bgs-pic--box { background: repeating-linear-gradient(45deg, rgba(243,153,16,0.12) 0 0.5rem, rgba(243,153,16,0.04) 0.5rem 1rem); }
.lpp-bgs-out { position: absolute; box-sizing: border-box; border: 0.125rem solid #2185D0; z-index: 2; pointer-events: none; }
.lpp-bgs-out-tag { position: absolute; left: 0.166667rem; bottom: 0.166667rem; font-size: 0.75rem; line-height: 1.2; color: #fff; background: rgba(8,20,27,0.75); padding: 0 0.25rem; border-radius: 0.166667rem; white-space: nowrap; max-width: calc(100% - 0.5rem); overflow: hidden; text-overflow: ellipsis; }
.lpp-bgs-out--assumed { border-style: dashed; border-color: #F39910; }
.lpp-bgs-fields { display: flex; flex-wrap: wrap; gap: 0.333333rem 0.666667rem; align-items: center; }
.lpp-bgs-fields label { display: flex; gap: 0.25rem; align-items: center; }
.lpp-bgs-thumbs { display: flex; flex-wrap: wrap; gap: 0.666667rem; }
.lpp-bgs-thumb { width: 12rem; display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.833333rem; color: #838B91; }
.lpp-bgs-thumb img { width: 100%; height: auto; background: #000; border: 0.083333rem solid #283239; }
.lpp-bgs-steps { margin: 0; padding: 0 0 0 1rem; font-size: 0.916667rem; line-height: 1.5; }
.lpp-bgs-step--failed { color: #F64747; }
.lpp-bgs-step--note { color: #F39910; }
.lpp-bgs-step--running { color: #2185D0; }
.lpp-bgs-problems { color: #F64747; }
.lpp-bgs-tag { display: inline-block; font-size: 0.75rem; padding: 0 0.333333rem; border-radius: 0.166667rem; margin-right: 0.25rem; background: rgba(255,255,255,0.08); color: #c8ced3; }
.lpp-bgs-tag--good { background: rgba(0,255,127,0.1); color: #00FF7F; }
.lpp-bgs-tag--warn { background: rgba(243,153,16,0.12); color: #F39910; }
.lpp-bgs-tag--bad { background: rgba(246,71,71,0.12); color: #F64747; }
.lpp-bgs-targets { display: grid; grid-template-columns: max-content 1fr; gap: 0.333333rem 1rem; font-size: 0.916667rem; }
.lpp-bgs-preview { color: #F39910; }
`;

const KIND_TAG = { import: ['imports', 'good'], partial: ['partly imports', 'warn'], manual: ['by hand', ''] };
const PRESET_LABELS = [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch'], ['native', '1:1'], ['centre', 'Centre']];
const pct = (n) => `${(n * 100).toFixed(4)}%`;
const kb = (bytes) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString()} KB`;

/**
 * @param {object} o
 * @param {object} o.session   the live store mirror + `send`
 * @param {object} o.job       the shared job (`job.js`)
 * @param {Function} [o.onRefresh]
 * @param {boolean} [o.popoutEnabled]
 * @param {Document} [o.doc]
 */
export function createBgSlicerPanel({ session, job, onRefresh = () => {}, popoutEnabled = true, doc = document } = {}) {
  let dragging = false;
  let over = false;
  const unlisten = job ? job.listen(() => onRefresh()) : () => {};

  function styles() {
    try {
      if (!doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
      const el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      doc.head.append(el);
    } catch { /* unstyled rather than not drawn */ }
  }

  const changed = ({ stale = false } = {}) => {
    if (stale) job.stale();
    job.changed();
  };

  /* --------------------------------------------------------------- render */

  function render() {
    styles();
    const store = session.store;
    const toolbar = h('div', { class: 'aw-flex-row-center-v-space-between aw-flex-wrap lpp-controls aw-gap-col-large' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Backgrounds' }),
        h('span', { class: 'aw-font-caption lpp-bgs-preview', text: 'Preview — never yet run against a real frame' })),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        chip('Stills', job.source === 'stills', () => { job.source = 'stills'; changed({ stale: true }); }, 'Cut the picture into one still per output and build a background set'),
        chip('Live inputs', job.source === 'live', () => { job.source = 'live'; changed({ stale: true }); }, 'Feed each output’s background from an input, and export the map a media server needs'),
        popoutEnabled ? button('Pop out', { iconId: 'set-layer-to-fullscreen-18', title: 'Open the Background Slicer in its own window', onClick: popOut }) : null));

    if (!job) return panel({ toolbar, body: h('div', { class: 'wru-empty', text: 'The Background Slicer is not running in the Web RCS tab.' }) });
    if (!store || !store.ready) return panel({ toolbar, body: h('div', { class: 'wru-empty', text: 'Waiting for the device store…' }) });
    const screens = reconcile(job, store);
    if (!screens.length) {
      return panel({ toolbar, body: h('div', { class: 'wru-empty', text: 'No screen is in service on this switcher — or it is not a LivePremier, which is the only platform with background sets.' }) });
    }

    const size = job.size();
    const chosen = screens.filter((s) => job.screens.includes(s.id));
    const topo = new Map(chosen.map((s) => [s.id, screenTopology(store, s.id)]));
    if (job.source === 'live') prepareLive(store, topo);
    const planJob = { ...job, image: size };
    const plan = buildPlan(store, planJob, { allowProgram: job.options.allowProgram });
    const key = planKey(plan);
    if (job.generated && job.generated.key !== key) job.stale();

    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      pictureSection(),
      screensSection(screens),
      chosen.length && size ? placementSection(chosen, topo, size) : null,
      chosen.length ? planSection(store, plan) : null,
      chosen.length && job.source === 'stills' ? generateSection(plan, key) : null,
      chosen.length ? writeSection(store, plan, key) : null,
      chosen.length && size ? exportSection(plan, size) : null,
      notesSection());
    return panel({ toolbar, body });
  }

  function chip(label, on, onClick, title) {
    return h('button', { class: ['lpp-chip', on ? 'lpp-chip--on' : ''], type: 'button', title, onClick }, label);
  }

  /* -------------------------------------------------------------- picture */

  function pictureSection() {
    const input = h('input', {
      type: 'file', accept: 'image/png,image/jpeg,image/gif,image/tiff,image/bmp,image/webp',
      onChange: (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) loadPicture(f); }
    });
    const drop = h('div', {
      class: ['lpp-bgs-drop', over ? 'lpp-bgs-drop--over' : ''],
      onDragover: (ev) => { ev.preventDefault(); if (!over) { over = true; onRefresh(); } },
      onDragleave: () => { over = false; onRefresh(); },
      onDrop: (ev) => {
        ev.preventDefault();
        over = false;
        const f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
        if (f) loadPicture(f); else onRefresh();
      }
    }, 'Drop a picture here, or ', input);
    const p = job.picture;
    const live = job.source === 'live';
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-2', text: live ? '1 · Content' : '1 · Picture' }),
      drop,
      p ? h('div', { class: 'lpp-bgs-row' },
        h('span', { class: 'aw-font-body-1-bold', text: p.name }),
        h('span', { class: 'aw-text-tertiary', text: `${p.width} × ${p.height} px` }),
        button('Forget it', { variant: 'ghost', onClick: () => { try { URL.revokeObjectURL(p.url); } catch { /* fine */ } job.picture = null; changed({ stale: true }); } }))
        : null,
      live && !p ? h('div', { class: 'lpp-bgs-fields' },
        h('span', { class: 'aw-text-tertiary', text: 'No picture: the media server’s content is' }),
        numField('content-w', (job.content || {}).width || '', (n) => { job.content = { ...(job.content || {}), width: n }; changed({ stale: true }); }, 'Content width in pixels'),
        h('span', { text: '×' }),
        numField('content-h', (job.content || {}).height || '', (n) => { job.content = { ...(job.content || {}), height: n }; changed({ stale: true }); }, 'Content height in pixels'),
        h('span', { class: 'aw-text-tertiary', text: 'px' }))
        : null,
      job.note ? h('div', { class: 'aw-font-caption wru-warn', text: job.note }) : null);
  }

  async function loadPicture(file) {
    job.note = null;
    try {
      const { bitmap, width, height } = await decodePicture(file);
      if (job.picture) { try { URL.revokeObjectURL(job.picture.url); } catch { /* fine */ } }
      job.picture = { name: file.name, width, height, bitmap, url: URL.createObjectURL(file) };
      job.place = {};
      job.span.rect = null;
    } catch (err) {
      job.note = `That file could not be read as a picture: ${err.message}`;
    }
    changed({ stale: true });
  }

  /* -------------------------------------------------------------- screens */

  function screensSection(screens) {
    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '2 · Screens' }),
      h('div', { class: 'lpp-bgs-row' },
        screens.map((s) => chip(`${s.id}${s.label ? ` ${s.label}` : ''} · ${s.canvas.width}×${s.canvas.height}`, job.screens.includes(s.id), () => {
          job.screens = job.screens.includes(s.id) ? job.screens.filter((x) => x !== s.id) : [...job.screens, s.id].sort(byScreen);
          job.span.rect = null;
          changed({ stale: true });
        }, `Put the background on ${s.id}`))),
      job.screens.length > 1 ? h('div', { class: 'lpp-bgs-row' },
        h('span', { class: 'aw-text-tertiary', text: 'Picture:' }),
        chip('On each screen', job.mode === 'each', () => { job.mode = 'each'; changed({ stale: true }); }, 'Place the picture on each screen separately'),
        chip('Span selected screens', job.mode === 'span', () => { job.mode = 'span'; job.span.rect = null; changed({ stale: true }); }, 'Lay the screens side by side, in order, under one picture'))
        : null);
  }

  const byScreen = (a, b) => Number(a.slice(1)) - Number(b.slice(1));

  /* ------------------------------------------------------------ placement */

  function placementSection(chosen, topo, size) {
    const items = [];
    if (job.mode === 'span' && chosen.length > 1) {
      const lay = spanLayout(chosen, job.span.offsets);
      const rect = job.span.rect || presetPlacement('fit', size, lay.bounds);
      items.push(h('div', { class: 'aw-flex-col aw-gap-row-small' },
        view({
          box: union([lay.bounds, rect]),
          screens: lay.screens.map((p) => ({ ...p, topo: topo.get(p.id) })),
          picture: rect,
          onMove: (r) => { job.span.rect = r; },
          id: 'span'
        }),
        rectFields('span', rect, (r) => { job.span.rect = r; changed({ stale: true }); }),
        presetButtons(size, lay.bounds, rect, (r) => { job.span.rect = r; changed({ stale: true }); }),
        h('div', { class: 'lpp-bgs-fields' },
          h('span', { class: 'aw-text-tertiary', text: 'Where each screen sits in the strip:' }),
          lay.screens.map((p) => h('label', {},
            h('span', { text: p.id }),
            numField(`off-${p.id}-x`, p.x, (n) => { setOffset(lay, p.id, { x: n }); }, `${p.id} x in the strip`),
            numField(`off-${p.id}-y`, p.y, (n) => { setOffset(lay, p.id, { y: n }); }, `${p.id} y in the strip`))))));
    } else {
      for (const s of chosen) {
        const t = topo.get(s.id);
        const frame = { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height };
        const rect = placementFor(job, s.id) || presetPlacement('fit', size, frame);
        items.push(h('div', { class: 'aw-flex-col aw-gap-row-small' },
          h('div', { class: 'aw-font-body-1-bold', text: `${s.id}${s.label ? ` — ${s.label}` : ''}` }),
          view({ box: union([frame, rect]), screens: [{ id: s.id, x: 0, y: 0, w: frame.w, h: frame.h, topo: t }], picture: rect, onMove: (r) => { job.place[s.id] = r; }, id: s.id }),
          rectFields(s.id, rect, (r) => { job.place[s.id] = r; changed({ stale: true }); }),
          presetButtons(size, frame, rect, (r) => { job.place[s.id] = r; changed({ stale: true }); })));
      }
    }
    return h('div', { class: 'aw-flex-col aw-gap-row-medium lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '3 · Placement' }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Canvas pixels. Drag the picture, or type a position and size — sums work, as in every numeric field.' }),
      items);
  }

  function setOffset(lay, id, patch) {
    const offsets = {};
    for (const p of lay.screens) offsets[p.id] = { x: p.x, y: p.y };
    offsets[id] = { ...offsets[id], ...patch };
    job.span.offsets = offsets;
    changed({ stale: true });
  }

  function union(rects) {
    const x = Math.min(...rects.map((r) => r.x));
    const y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }

  /** A canvas drawn as the Screens / Aux. page draws one: screens, outputs on them, the picture over. */
  function view({ box, screens, picture, onMove, id }) {
    const at = (r) => ({ left: pct((r.x - box.x) / box.w), top: pct((r.y - box.y) / box.h), width: pct(r.w / box.w), height: pct(r.h / box.h) });
    const inner = h('div', { class: 'lpp-bgs-view-inner' });
    for (const s of screens) {
      inner.append(h('div', { class: 'lpp-bgs-screen', style: at(s), title: `${s.id} canvas ${s.w} × ${s.h}` },
        h('span', { class: 'lpp-bgs-screen-tag', text: `${s.id} · ${s.w}×${s.h}` })));
    }
    const pic = job.picture
      ? h('img', { class: 'lpp-bgs-pic', src: job.picture.url, alt: '', draggable: 'false', style: at(picture) })
      : h('div', { class: 'lpp-bgs-pic lpp-bgs-pic--box', style: at(picture) });
    pic.setAttribute('data-lpp-drag', id);
    pic.addEventListener('pointerdown', (ev) => startDrag(ev, pic, inner, box, picture, onMove));
    inner.append(pic);
    for (const s of screens) {
      for (const o of (s.topo && s.topo.outputs) || []) {
        for (const r of o.regions) {
          const rect = { x: s.x + r.canvas.x, y: s.y + r.canvas.y, w: r.canvas.w, h: r.canvas.h };
          const assumed = o.rotation || o.groupShape.cols * o.groupShape.rows > 1 || o.ratio.h !== 1 || o.ratio.v !== 1 || o.regions.length > 1;
          const words = [o.name, `${o.raster.width}×${o.raster.height}`, o.plugs.join('/') || '', o.group !== '1X1' ? o.group : '',
            o.regions.length > 1 ? `slice ${r.slice}` : '', o.rotation ? `⟲${o.rotation}°` : '', o.label].filter(Boolean);
          inner.append(h('div', { class: ['lpp-bgs-out', assumed ? 'lpp-bgs-out--assumed' : ''], style: at(rect), title: words.join(' · ') },
            h('span', { class: 'lpp-bgs-out-tag', text: words.join(' · ') })));
        }
      }
    }
    const ratio = Math.min(1.2, box.h / box.w);
    return h('div', { class: 'lpp-bgs-view' }, h('div', { style: { paddingTop: `${(ratio * 100).toFixed(3)}%` } }), inner);
  }

  function startDrag(ev, el, inner, box, start, onMove) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    const width = (inner.getBoundingClientRect && inner.getBoundingClientRect().width) || 0;
    if (!width) return;
    const scale = box.w / width;
    const sx = ev.clientX;
    const sy = ev.clientY;
    let rect = { ...start };
    dragging = true;
    const ownerDoc = el.ownerDocument || doc;
    const move = (e) => {
      rect = { ...start, x: Math.round(start.x + (e.clientX - sx) * scale), y: Math.round(start.y + (e.clientY - sy) * scale) };
      el.style.left = pct((rect.x - box.x) / box.w);
      el.style.top = pct((rect.y - box.y) / box.h);
    };
    const up = () => {
      ownerDoc.removeEventListener('pointermove', move);
      ownerDoc.removeEventListener('pointerup', up);
      dragging = false;
      onMove(rect);
      changed({ stale: true });
    };
    ownerDoc.addEventListener('pointermove', move);
    ownerDoc.addEventListener('pointerup', up);
  }

  function numField(key, value, onCommit, title) {
    return h('input', {
      type: 'text', class: 'wru-input wru-input--narrow', step: '1', value: String(value), title,
      'data-lpp-key': `bgs-${key}`,
      onChange: (ev) => {
        const n = Math.round(Number(String(ev.target.value).trim()));
        if (Number.isFinite(n)) onCommit(n);
        else onRefresh();
      }
    });
  }

  function rectFields(id, rect, onCommit) {
    const field = (k, label) => h('label', {}, h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      numField(`${id}-${k}`, rect[k], (n) => {
        if ((k === 'w' || k === 'h') && n < 1) return onRefresh();
        onCommit({ ...rect, [k]: n });
      }, `Picture ${label} in canvas pixels`));
    return h('div', { class: 'lpp-bgs-fields' }, field('x', 'X'), field('y', 'Y'), field('w', 'W'), field('h', 'H'));
  }

  function presetButtons(size, frame, current, onPick) {
    return h('div', { class: 'lpp-bgs-row' },
      PRESET_LABELS.map(([p, label]) => button(label, { variant: 'ghost', onClick: () => onPick(presetPlacement(p, size, frame, current)) })));
  }

  /* ------------------------------------------------------------------ live */

  /** Fill in the inputs and EDIDs the live mode suggests, where the operator has not chosen. */
  function prepareLive(store, topo) {
    const cands = liveCandidates(store);
    const taken = new Set(Object.values(job.live).filter(Boolean));
    for (const [sid, t] of topo) {
      for (const o of (t && t.outputs) || []) {
        const k = `${sid}/${o.key}`;
        if (job.live[k] === undefined) {
          const pick = suggestInputs(cands, o.key, taken)[0];
          job.live[k] = pick ? pick.key : null;
          if (pick) taken.add(pick.key);
        }
        const input = job.live[k];
        job.edid[k] = input ? edidChoice(o, plugTemplates(store, input)) : null;
      }
    }
    return cands;
  }

  /* ------------------------------------------------------------------ plan */

  function planSection(store, plan) {
    const live = plan.source === 'live';
    const cands = live ? liveCandidates(store) : [];
    const lib = readLibrary(store);
    const blocks = plan.screens.map((s) => {
      const sets = readSets(store, s.id);
      const setPick = h('select', {
        class: 'wru-select',
        onChange: (ev) => { job.sets[s.id] = Number(ev.target.value); changed(); }
      }, sets.map((x) => h('option', { value: String(x.index), selected: x.index === s.setIndex ? 'selected' : null },
        `Set ${x.index}${x.label ? ` “${x.label}”` : ''}${x.onProgram ? ' · ON PROGRAM' : x.onPreview ? ' · on preview' : ''}${Object.keys(x.contents).length ? ` · holds ${Object.keys(x.contents).length}` : x.empty ? ' · free' : ''}`)));
      const head = h('tr', {},
        ['Output', 'Raster', 'Connector', ...(live ? ['Input', 'EDID'] : ['Library', 'Still']), 'Content', 'Replaces', 'Cut'].map((t) => h('th', { text: t })));
      const rows = s.outputs.map((o) => h('tr', {},
        h('td', {}, h('div', { class: 'aw-font-body-1-bold', text: o.name }), o.label ? h('div', { class: 'aw-text-tertiary', text: o.label }) : null),
        h('td', {}, `${o.raster.width} × ${o.raster.height}`, h('div', { class: 'aw-text-tertiary', text: [o.format, o.rate ? `${o.rate / 1000} Hz` : ''].filter(Boolean).join(' · ') })),
        h('td', { text: [o.plugs.join('/') || '—', o.group, o.rotation ? `⟲${o.rotation}°` : ''].filter(Boolean).join(' · ') }),
        ...(live ? liveCells(s, o, cands) : stillCells(o)),
        h('td', { text: o.content || '—' }),
        h('td', { class: o.previous !== 'NONE' && o.previous !== o.content ? 'wru-warn' : 'aw-text-tertiary', text: o.previous === 'NONE' ? 'nothing' : o.previous }),
        h('td', {}, cutTags(o))));
      return h('div', { class: 'aw-flex-col aw-gap-row-small' },
        h('div', { class: 'lpp-bgs-row' },
          h('span', { class: 'aw-font-body-1-bold', text: `${s.id}${s.label ? ` — ${s.label}` : ''}` }),
          h('span', { class: 'aw-text-tertiary', text: 'into' }), setPick,
          s.native.fitted ? null : h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'NATIVE layer not allocated — the set can be built, not shown, until it is (Preconfig ▸ Resources)' })),
        h('table', { class: 'wru-table' }, h('thead', {}, head), h('tbody', {}, rows)));
    });
    const freeSets = plan.screens.filter((s) => !s.set && firstFreeSet(readSets(store, s.id)) == null);
    return h('div', { class: 'aw-flex-col aw-gap-row-medium lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '4 · Plan — nothing is written yet' }),
      plan.source === 'stills'
        ? h('div', { class: 'aw-font-caption aw-text-tertiary', text: `Only free library slots and free stills are used. Library: ${lib.slots.filter((x) => x.free).length} of ${lib.slots.length} slots free, ${Math.round(lib.sizeKB / 1024)} of ${Math.round(lib.maxKB / 1024)} MB used.` })
        : h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Each output’s background is the input chosen for it; the media server behind that input has to play exactly the cut below — the exports at the bottom are that map.' }),
      blocks,
      freeSets.length ? h('div', { class: 'wru-warn', text: `${freeSets.map((s) => s.id).join(', ')}: every background set holds something — choose one to overwrite.` }) : null,
      plan.problems.length ? h('ul', { class: 'wru-warnings lpp-bgs-problems' }, plan.problems.map((p) => h('li', { text: p }))) : null,
      plan.warnings.length ? h('ul', { class: 'wru-warnings' }, plan.warnings.map((p) => h('li', { class: 'wru-warn', text: p }))) : null);
  }

  function stillCells(o) {
    const change = o.capacityChange;
    return [
      h('td', { text: o.librarySlot != null ? `slot ${o.librarySlot}` : '—' }),
      h('td', {},
        o.still ? `IMG ${o.still}` : '—',
        h('div', { class: change ? 'wru-warn' : 'aw-text-tertiary', text: change ? `${change.from} → ${change.to}${change.format ? ` (${change.format})` : ''}` : (o.stillCapability || '') }))
    ];
  }

  function liveCells(s, o, cands) {
    const k = `${s.id}/${o.key}`;
    const current = job.live[k] || '';
    const sel = h('select', {
      class: 'wru-select', 'data-lpp-key': `bgs-live-${k}`,
      onChange: (ev) => { job.live[k] = ev.target.value || null; changed(); }
    }, h('option', { value: '', text: '— choose —' }),
    cands.map((c) => h('option', {
      value: c.key, selected: c.key === current ? 'selected' : null,
      text: `${c.key.replace('_', ' ')}${c.label ? ` ${c.label}` : ''}${c.plug ? ` · ${c.plug}` : ''}${c.usedOnOutput && c.usedOnOutput !== o.key ? ` · on Out ${c.usedOnOutput}` : ''}`
    })));
    const e = job.edid[k];
    return [
      h('td', {}, sel),
      h('td', { class: e && e.kind ? '' : 'aw-text-tertiary', text: e ? (e.kind ? e.label : e.why) : '—' })
    ];
  }

  function cutTags(o) {
    const tags = [];
    if (!o.covered) tags.push(tag('plain', '', 'The picture does not reach this output'));
    else if (o.exact) tags.push(tag('pixel copy', 'good', 'Whole pixels, nothing scaled: the image is a copy of the picture’s pixels'));
    else tags.push(tag('resampled', 'warn', 'Scaled (Fit, a stretch, a pitch ratio or a fractional placement): the image is resampled, not copied'));
    for (const a of o.assumptions) tags.push(tag(a, 'warn', NOTES[a] ? NOTES[a].text : a));
    return tags;
  }

  const tag = (text, tone, title) => h('span', { class: ['lpp-bgs-tag', tone ? `lpp-bgs-tag--${tone}` : ''], title, text });

  /* -------------------------------------------------------------- generate */

  function generateSection(plan, key) {
    const g = job.generated;
    const count = plan.screens.reduce((n, s) => n + s.outputs.length, 0);
    const thumbs = g ? [...g.images.values()].map((img) => h('div', { class: 'lpp-bgs-thumb' },
      h('img', { src: img.url, alt: img.name }),
      h('span', { text: img.name }),
      h('span', { text: `${img.width} × ${img.height} · ${kb(img.blob.size)}` }))) : [];
    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '5 · Generate' }),
      h('div', { class: 'lpp-bgs-row' },
        button(g ? 'Generate again' : `Generate ${count} image${count === 1 ? '' : 's'}`, {
          variant: g ? 'default' : 'go', disabled: !job.picture || !count || job.running,
          title: job.picture ? 'Cut one PNG per output, in this page' : 'Choose a picture first',
          onClick: () => generate(plan, key)
        }),
        g ? button('Download images (.zip)', { onClick: () => downloadImages() }) : null,
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini', title: 'What an output shows where the picture does not reach' },
          h('span', { class: 'aw-text-tertiary', text: 'Background' }),
          h('input', { type: 'color', value: job.options.fill, onChange: (ev) => { job.options.fill = ev.target.value; changed({ stale: true }); } }))),
      thumbs.length ? h('div', { class: 'lpp-bgs-thumbs' }, thumbs) : null);
  }

  async function generate(plan, key) {
    if (!job.picture) return;
    job.stale();
    job.running = true;
    job.note = null;
    job.changed();
    const images = new Map();
    try {
      for (const s of plan.screens) {
        for (const o of s.outputs) {
          const blob = await renderOutput({ source: job.picture.bitmap, blits: o.blits, width: o.raster.width, height: o.raster.height, fill: job.options.fill });
          images.set(`${s.id}/${o.key}`, { blob, url: URL.createObjectURL(blob), name: imageName(s.id, o, job.picture.name), width: o.raster.width, height: o.raster.height });
        }
      }
      job.generated = { key, images };
    } catch (err) {
      job.note = `Could not generate the images: ${err.message}`;
    }
    job.running = false;
    job.changed();
  }

  async function downloadImages() {
    const g = job.generated;
    if (!g) return;
    const files = [];
    for (const img of g.images.values()) files.push({ name: img.name, data: new Uint8Array(await img.blob.arrayBuffer()) });
    download(zipStore(files), `${stem()}-backgrounds.zip`, 'application/zip', doc);
  }

  const stem = () => String((job.picture && job.picture.name) || 'backgrounds').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_') || 'backgrounds';

  /* ----------------------------------------------------------------- write */

  function writeSection(store, plan, key) {
    const live = plan.source === 'live';
    const ready = plan.ok && (live || (job.generated && job.generated.key === key));
    const onProgram = plan.screens.some((s) => s.set && s.set.onProgram);
    const noNative = plan.screens.filter((s) => !s.native.fitted).map((s) => s.id);
    const total = job.generated ? [...job.generated.images.values()].reduce((n, i) => n + i.blob.size, 0) : 0;
    const room = (plan.library.maxKB - plan.library.sizeKB) * 1024;
    const tooBig = !live && total > room;
    const options = h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('label', { class: 'lpp-bgs-fields' },
        h('span', { class: 'aw-text-tertiary', text: 'Name for the sets and stills' }),
        h('input', {
          type: 'text', class: 'wru-input', maxlength: String(LABEL_MAX), value: job.options.label, 'data-lpp-key': 'bgs-label',
          placeholder: 'e.g. Act 1 BG', onChange: (ev) => { job.options.label = String(ev.target.value).slice(0, LABEL_MAX); changed(); }
        })),
      checkbox('Load each set into its screen’s preview afterwards', job.options.loadPreview, (v) => { job.options.loadPreview = v; changed(); },
        noNative.length ? `${noNative.join(', ')}: NATIVE layer not allocated — those screens will be skipped` : 'Writes the preview buffer’s NATIVE layer source; never program, never a take'),
      live ? checkbox('Load each input plug with the switcher’s EDID for its output’s format', job.options.edids, (v) => { job.options.edids = v; changed(); },
        'The switcher builds the EDID itself (Inputs ▸ EDID ▸ load from template), so a media server offers exactly that mode') : null,
      onProgram ? checkbox('A chosen set is ON PROGRAM — write it anyway, live', job.options.allowProgram, (v) => { job.options.allowProgram = v; changed(); }, 'The new background goes to air the moment it is written') : null);

    const confirmText = live
      ? `Write ${plan.screens.map((s) => `${s.id} set ${s.setIndex}`).join(', ')} with ${plan.screens.reduce((n, s) => n + s.outputs.length, 0)} live inputs?`
      : `Upload ${job.generated ? job.generated.images.size : 0} images (${kb(total)}) into free library slots, set ${plan.screens.reduce((n, s) => n + s.outputs.length, 0)} free stills${plan.capacityChanges.length ? `, change ${plan.capacityChanges.length} still capacit${plan.capacityChanges.length === 1 ? 'y' : 'ies'} (a preconfig apply)` : ''}, and write ${plan.screens.map((s) => `${s.id} set ${s.setIndex}`).join(', ')}?`;

    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: live ? '5 · Write' : '6 · Write' }),
      options,
      tooBig ? h('div', { class: 'wru-warn', text: `The images come to ${kb(total)} and the library has ${kb(room)} free.` }) : null,
      job.confirming
        ? h('div', { class: 'lpp-bgs-row' },
          h('span', { class: 'aw-font-body-1-bold', text: confirmText }),
          button('Write', { variant: 'go', onClick: () => write(store, plan) }),
          button('Cancel', { variant: 'ghost', onClick: () => { job.confirming = false; changed(); } }))
        : h('div', { class: 'lpp-bgs-row' },
          button('Write to the switcher…', {
            variant: 'default', disabled: !ready || tooBig || job.running || (onProgram && !job.options.allowProgram),
            title: !plan.ok ? plan.problems[0] : (!ready ? 'Generate the images first' : 'Shows what will be written, then asks'),
            onClick: () => { job.confirming = true; changed(); }
          }),
          job.journal && !job.running ? button('Undo what was written', { variant: 'danger', onClick: () => undo() }) : null),
      job.progress.length ? h('ol', { class: 'lpp-bgs-steps' }, job.progress.map((p) => h('li', { class: `lpp-bgs-step--${p.state}`, text: p.text }))) : null);
  }

  function checkbox(label, on, onSet, title) {
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', title },
      h('input', { type: 'checkbox', checked: on ? 'checked' : null, onChange: (ev) => onSet(!!ev.target.checked) }),
      h('span', { text: label }),
      title ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: `— ${title}` }) : null);
  }

  async function write(store, plan) {
    job.confirming = false;
    job.running = true;
    job.progress = [];
    job.changed();
    const onStep = (text, state) => {
      const last = job.progress[job.progress.length - 1];
      if (last && last.state === 'running' && state !== 'note') job.progress.pop();
      job.progress.push({ text, state });
      job.changed();
    };
    const images = new Map();
    if (job.generated) for (const [k, v] of job.generated.images) images.set(k, { blob: v.blob, name: v.name });
    const result = await applyPlan({
      session, plan, images,
      options: { label: job.options.label, loadPreview: job.options.loadPreview, allowProgram: job.options.allowProgram, edids: job.options.edids },
      onStep
    });
    job.journal = result.journal;
    onStep(result.ok ? 'Done.' : 'Stopped. Everything above it was written; Undo takes it back off.', result.ok ? 'done' : 'failed');
    job.running = false;
    job.changed();
  }

  async function undo() {
    if (!job.journal) return;
    job.running = true;
    job.progress.push({ text: 'Undoing…', state: 'running' });
    job.changed();
    const result = await revert({ session, journal: job.journal, onStep: (text, state) => { job.progress.push({ text, state }); job.changed(); } });
    job.progress.push({ text: result.ok ? 'Undone.' : `Not everything came back: ${result.problems.join('; ')}`, state: result.ok ? 'done' : 'failed' });
    if (result.ok) job.journal = null;
    job.running = false;
    job.changed();
  }

  /* --------------------------------------------------------------- exports */

  function exportSection(plan, size) {
    const anything = plan.screens.some((s) => s.outputs.some((o) => o.blits.length));
    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-bgs-section' },
      h('div', { class: 'aw-font-subtitle-2', text: `${plan.source === 'live' ? '6' : '7'} · Media server` }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: plan.source === 'live'
        ? 'One media-server output per input, the size of the switcher output it backs; one slice per region of the content.'
        : 'The same map for a media server, should these outputs be fed live instead.' }),
      h('div', { class: 'lpp-bgs-row' },
        button('Everything (.zip)', { variant: 'go', disabled: !anything, onClick: () => downloadPack(plan, size) }),
        TARGETS.filter((t) => t.files).map((t) => button(t.name, { disabled: !anything, title: `${t.import} — ${t.verify}`, onClick: () => downloadTarget(t, plan, size) }))),
      h('details', {},
        h('summary', { class: 'aw-text-tertiary', text: 'What each media server can import, and how to set it up' }),
        h('div', { class: 'lpp-bgs-targets' }, TARGETS.flatMap((t) => [
          h('div', {}, h('span', { class: 'aw-font-body-1-bold', text: t.name }), h('div', {}, tag(KIND_TAG[t.kind][0], KIND_TAG[t.kind][1], t.import || 'no importable format'))),
          h('div', {}, h('div', { text: t.how }), t.verify ? h('div', { class: 'aw-font-caption aw-text-tertiary', text: t.verify }) : null)
        ]))));
  }

  async function downloadTarget(t, plan, size) {
    const files = t.files(plan, size);
    if (files.length === 1) download(files[0].data, files[0].name, 'text/plain', doc);
    else download(zipStore(files), `${t.id}.zip`, 'application/zip', doc);
  }

  async function downloadPack(plan, size) {
    const files = packFiles(plan, size);
    for (const t of templateList(plan)) {
      try {
        const blob = await renderTemplate(templateShapes(plan, size, t.which));
        files.push({ name: t.name, data: new Uint8Array(await blob.arrayBuffer()) });
      } catch { /* the SVG beside it says the same */ }
    }
    if (job.generated) for (const img of job.generated.images.values()) files.push({ name: `images/${img.name}`, data: new Uint8Array(await img.blob.arrayBuffer()) });
    download(zipStore(files), `${stem()}-pixel-map.zip`, 'application/zip', doc);
  }

  /* ------------------------------------------------------------------ notes */

  function notesSection() {
    return h('details', { class: 'lpp-bgs-section' },
      h('summary', { class: 'aw-text-tertiary', text: 'What is proven, and what is not' }),
      h('ul', { class: 'wru-warnings' }, Object.entries(NOTES).map(([k, n]) => h('li', {},
        tag(n.proven ? 'proven' : 'assumed', n.proven ? 'good' : 'warn'), h('span', { text: n.text }), h('span', { class: 'aw-text-tertiary', text: ` (${k})` })))),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'A simulator’s outputs are a static picture, so a background written there cannot be seen — check the first one on a real output.' }));
  }

  /* -------------------------------------------------------------- pop out */

  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open(POPOUT, 'lpp-bg-slicer', 'width=1400,height=950,menubar=no,toolbar=no,location=no');
    if (!child) { job.note = 'The browser blocked the window — allow pop-ups for this address.'; job.changed(); }
  }

  return { render, busy: () => dragging, stop: unlisten };
}

/** A fingerprint of everything a generated image depends on, so a stale one is never written. */
export function planKey(plan) {
  return JSON.stringify(plan.screens.map((s) => [s.id, s.outputs.map((o) => [o.key, o.raster.width, o.raster.height, o.blits])]));
}
