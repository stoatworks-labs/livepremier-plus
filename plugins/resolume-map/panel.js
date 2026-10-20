/*
 * Resolume Mapping — the panel. Preconfig ▸ Resolume Mapping, beneath Canvas.
 *
 * Top to bottom, the job in the order it is done:
 *
 *   1. **Screens** — which in-service screens the composition holds, and
 *      whether they sit side by side or one above another; the composition
 *      drawn with every output's footprint on it.
 *   2. **Outputs** — per output: its raster, the rectangle of the
 *      composition its Arena output reads, and the switcher input it is
 *      cabled into (optional; it names the Arena output after the cable).
 *   3. **Resolume Arena** — the Advanced Output preset to download, and how
 *      to load it.
 *   4. **Background set** — optional: put those inputs into a set per
 *      screen, with each plug's EDID loaded for its output's format;
 *      confirmed, then step by step on the switcher's echo, with Undo.
 *
 * Immediate-mode like every panel here; the choices live in `job`, not in
 * the DOM, so a repaint loses nothing.
 *
 * ⚠️ Preview: the map is output-map's writer, held to files a real Arena
 * wrote, and has not been opened in Arena; the set writes are the Background
 * Slicer's, proved on a simulator and never on a frame.
 */

import { h, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { readScreens, liveCandidates, suggestInputs, sendingFormatOf } from '../../src/core/backgrounds.js';
import { readSets, firstFreeSet } from '../../src/core/stills.js';
import {
  buildPlan, arenaPreset, inputWord, defaultName, ARRANGEMENTS, NOTES, HOW, UNVERIFIED, LABEL_MAX
} from './core.js';
import { applyPlan, revert } from './apply.js';

const STYLE_ID = 'lpp-rsm-style';

const CSS = `
.lpp-rsm-section { border-top: 0.083333rem solid #283239; padding-top: 0.833333rem; }
.lpp-rsm-row { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; }
.lpp-rsm-view { position: relative; max-width: 64rem; background: #050B0F; border: 0.083333rem solid #283239; border-radius: 0.25rem; overflow: hidden; }
.lpp-rsm-screen { position: absolute; box-sizing: border-box; border: 0.083333rem solid #616D75; background: #0D1D26; }
.lpp-rsm-screen-tag { position: absolute; left: 0.25rem; top: 0.166667rem; font-size: 0.833333rem; color: #838B91; white-space: nowrap; }
.lpp-rsm-out { position: absolute; box-sizing: border-box; border: 0.125rem solid #2185D0; background: rgba(33,133,208,0.12); }
.lpp-rsm-out--assumed { border-style: dashed; border-color: #F39910; }
.lpp-rsm-out-tag { position: absolute; left: 0.166667rem; bottom: 0.166667rem; font-size: 0.75rem; line-height: 1.2; color: #fff; background: rgba(8,20,27,0.75); padding: 0 0.25rem; border-radius: 0.166667rem; white-space: nowrap; max-width: calc(100% - 0.5rem); overflow: hidden; text-overflow: ellipsis; }
.lpp-rsm-steps { margin: 0; padding: 0 0 0 1rem; font-size: 0.916667rem; line-height: 1.5; }
.lpp-rsm-step--failed { color: #F64747; }
.lpp-rsm-step--note { color: #F39910; }
.lpp-rsm-step--running { color: #2185D0; }
.lpp-rsm-problems { color: #F64747; }
.lpp-rsm-tag { display: inline-block; font-size: 0.75rem; padding: 0 0.333333rem; border-radius: 0.166667rem; margin-right: 0.25rem; background: rgba(255,255,255,0.08); color: #c8ced3; }
.lpp-rsm-tag--good { background: rgba(0,255,127,0.1); color: #00FF7F; }
.lpp-rsm-tag--warn { background: rgba(243,153,16,0.12); color: #F39910; }
.lpp-rsm-preview { color: #F39910; }
.lpp-rsm-text { width: 18rem; }
.lpp-rsm-how { margin: 0; padding: 0 0 0 1.25rem; font-size: 0.916667rem; line-height: 1.6; }
`;

/** The page's choices. Kept for the life of the tab; nothing here is saved. */
export function createJob() {
  return {
    screens: null,          // null until the store has said which are in service
    arrange: 'row',
    inputs: {},             // '<screen>/<out>' -> 'IN_5'
    name: '',
    set: { on: false, index: {}, label: '', edids: true, preview: false, allowProgram: false },
    confirming: false,
    running: false,
    journal: null,
    progress: []
  };
}

/**
 * @param {object} o
 * @param {object} o.session   the live store mirror + `send`
 * @param {Function} [o.onRefresh]
 * @param {Document} [o.doc]
 */
export function createResolumePanel({ session, onRefresh = () => {}, job = createJob(), doc = document } = {}) {
  function styles() {
    try {
      if (!doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
      const el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      doc.head.append(el);
    } catch { /* unstyled rather than not drawn */ }
  }

  const changed = () => onRefresh();

  function render() {
    styles();
    const store = session.store;
    const toolbar = h('div', { class: 'aw-flex-row-center-v-space-between aw-flex-wrap lpp-controls aw-gap-col-large' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Resolume Mapping' }),
        h('span', { class: 'aw-font-caption lpp-rsm-preview', text: 'Preview — no preset from here has been opened in Arena yet' })));

    if (!store || !store.ready) return panel({ toolbar, body: h('div', { class: 'wru-empty', text: 'Waiting for the device store…' }) });
    const inService = readScreens(store);
    if (!inService.length) return panel({ toolbar, body: h('div', { class: 'wru-empty', text: 'No screen with a canvas is in service on this switcher.' }) });
    reconcile(inService);

    const cands = liveCandidates(store);
    const plan = buildPlan(store, job, cands);
    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      screensSection(inService, plan),
      plan.screens.length ? outputsSection(store, plan, cands) : null,
      plan.screens.length ? arenaSection(plan) : null,
      plan.screens.length ? setSection(store, plan) : null,
      notesSection());
    return panel({ toolbar, body });
  }

  /** Keep only screens still in service; the first time, take every one. */
  function reconcile(inService) {
    const ids = inService.map((s) => s.id);
    if (job.screens == null) job.screens = ids.slice();
    else job.screens = ids.filter((id) => job.screens.includes(id));
  }

  /* -------------------------------------------------------------- screens */

  function screensSection(inService, plan) {
    const toggle = (id) => {
      job.screens = job.screens.includes(id) ? job.screens.filter((x) => x !== id) : inService.map((s) => s.id).filter((x) => x === id || job.screens.includes(x));
      job.confirming = false;
      changed();
    };
    const { width, height } = plan.composition;
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-2', text: '1 · Screens' }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'The Arena composition is these screens’ canvases, each at its own pixels.' }),
      h('div', { class: 'lpp-rsm-row' },
        inService.map((s) => chip(`${s.id}${s.label ? ` ${s.label}` : ''} · ${s.canvas.width} × ${s.canvas.height}`, job.screens.includes(s.id), () => toggle(s.id), `Put ${s.id} in the composition`))),
      h('div', { class: 'lpp-rsm-row' },
        ARRANGEMENTS.map((a) => chip(a.label, job.arrange === a.id, () => { job.arrange = a.id; changed(); }, a.what)),
        width && height ? h('span', { class: 'aw-font-body-1-bold', text: `Composition ${width} × ${height}` }) : null),
      width && height ? diagram(plan) : null,
      plan.xml.problems.length && !plan.screens.length ? h('ul', { class: 'wru-warnings lpp-rsm-problems' }, plan.xml.problems.map((p) => h('li', { text: p }))) : null);
  }

  /** The composition, scaled to the panel: each screen, and each output's footprint on it. */
  function diagram(plan) {
    const { width: W, height: H } = plan.composition;
    const pct = (n, of) => `${(n / of) * 100}%`;
    const box = (r) => ({ left: pct(r.x, W), top: pct(r.y, H), width: pct(r.w, W), height: pct(r.h, H) });
    const shapes = [];
    for (const s of plan.screens) {
      shapes.push(h('div', { class: 'lpp-rsm-screen', style: box({ x: s.at.x, y: s.at.y, w: s.canvas.width, h: s.canvas.height }) },
        h('span', { class: 'lpp-rsm-screen-tag', text: `${s.id} · ${s.canvas.width} × ${s.canvas.height} at ${s.at.x}, ${s.at.y}` })));
      for (const o of s.outputs) {
        for (const r of o.regions) {
          shapes.push(h('div', {
            class: ['lpp-rsm-out', o.assumptions.length ? 'lpp-rsm-out--assumed' : ''], style: box(r.input),
            title: `${o.arena}: composition ${r.input.x}, ${r.input.y} · ${r.input.w} × ${r.input.h}`
          }, h('span', { class: 'lpp-rsm-out-tag', text: `${o.name}${o.regions.length > 1 ? ` s${r.slice}` : ''}${o.input ? ` · ${inputWord(o.input)}` : ''}` })));
        }
      }
    }
    /* No taller than 22rem: a tall composition is narrowed, never squashed. */
    return h('div', { class: 'lpp-rsm-view', style: { aspectRatio: `${W} / ${H}`, width: `min(100%, ${((22 * W) / H).toFixed(3)}rem)` } }, shapes);
  }

  /* -------------------------------------------------------------- outputs */

  function outputsSection(store, plan, cands) {
    const setOn = job.set.on;
    const blocks = plan.screens.map((s) => {
      const head = h('tr', {}, ['Output', 'Raster', 'Reads from the composition', 'Connector', 'Cabled into', ...(setOn ? ['EDID', 'Set holds'] : []), 'Arena output', ''].map((t) => h('th', { text: t })));
      const rows = s.outputs.map((o) => h('tr', {},
        h('td', {}, h('div', { class: 'aw-font-body-1-bold', text: o.name }), o.label ? h('div', { class: 'aw-text-tertiary', text: o.label }) : null),
        h('td', {}, `${o.raster.width} × ${o.raster.height}`, h('div', { class: 'aw-text-tertiary', text: [o.format, o.rate ? `${o.rate / 1000} Hz` : ''].filter(Boolean).join(' · ') })),
        h('td', {}, o.regions.length
          ? o.regions.map((r) => h('div', { text: `${o.regions.length > 1 ? `s${r.slice}: ` : ''}${r.input.x}, ${r.input.y} · ${r.input.w} × ${r.input.h}${r.rotation ? ` · ⟲${r.rotation}°` : ''}` }))
          : h('span', { class: 'aw-text-tertiary', text: 'off the canvas' })),
        h('td', { text: [o.plugs.join('/') || '—', o.group, o.rotation ? `⟲${o.rotation}°` : ''].filter(Boolean).join(' · ') }),
        h('td', {}, inputPick(s, o, cands)),
        ...(setOn ? [edidCell(o), setCell(s, o)] : []),
        h('td', { text: o.arena }),
        h('td', {}, tags(o))));
      return h('div', { class: 'aw-flex-col aw-gap-row-small' },
        h('div', { class: 'aw-font-body-1-bold', text: `${s.id}${s.label ? ` — ${s.label}` : ''} · at ${s.at.x}, ${s.at.y} in the composition` }),
        h('table', { class: 'wru-table' }, h('thead', {}, head), h('tbody', {}, rows)));
    });
    const empty = plan.screens.some((s) => s.outputs.some((o) => !o.input));
    return h('div', { class: 'aw-flex-col aw-gap-row-medium lpp-rsm-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '2 · Outputs' }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'One Arena output per switcher output, the size of its raster. The input it is cabled into is optional: it names the Arena output after the cable, and is what a background set below would show.' }),
      blocks,
      h('div', { class: 'lpp-rsm-row' },
        button('Suggest inputs', {
          disabled: !empty || !cands.length,
          title: 'Fill the empty ones: inputs on the output’s own frame that are not another output’s background, not on air, and already receiving its format first',
          onClick: () => suggest(plan, cands)
        }),
        button('Clear inputs', { variant: 'ghost', disabled: !Object.values(job.inputs).some(Boolean), onClick: () => { job.inputs = {}; job.confirming = false; changed(); } })),
      problemsList(plan.xml.problems),
      plan.warnings.length ? h('ul', { class: 'wru-warnings' }, plan.warnings.map((p) => h('li', { class: 'wru-warn', text: p }))) : null);
  }

  function inputPick(s, o, cands) {
    const k = `${s.id}/${o.key}`;
    const current = job.inputs[k] || '';
    const listed = cands.some((c) => c.key === current);
    return h('select', {
      class: 'wru-select', 'data-lpp-key': `rsm-input-${k}`,
      onChange: (ev) => { job.inputs[k] = ev.target.value || null; job.confirming = false; changed(); }
    }, h('option', { value: '', text: '— none —' }),
    current && !listed ? h('option', { value: current, selected: 'selected', text: `${inputWord(current)} · not available` }) : null,
    cands.map((c) => h('option', {
      value: c.key, selected: c.key === current ? 'selected' : null,
      text: `${inputWord(c.key)}${c.label ? ` ${c.label}` : ''}${c.plug ? ` · ${c.plug}` : ''}`
        + `${c.signal && c.signal.valid ? ` · ${c.signal.width}×${c.signal.height} ${c.signal.rate} Hz${sendingFormatOf(c, o) ? ' ✓' : ''}` : ' · no signal'}`
        + `${c.usedOnOutput && c.usedOnOutput !== o.key ? ` · BG of Out ${c.usedOnOutput}` : ''}${c.onAir ? ' · on air' : ''}`
    })));
  }

  function edidCell(o) {
    const e = o.edid;
    return h('td', { class: e && e.kind ? '' : 'aw-text-tertiary', title: 'The switcher builds this EDID from its own template. Blanking is not compared — the output’s total is beside it for checking.' },
      e ? (e.kind ? e.label : e.why) : '—',
      e && o.total && o.total.h ? h('div', { class: 'aw-text-tertiary', text: `output total ${o.total.h} × ${o.total.v}` }) : null);
  }

  function setCell(s, o) {
    if (!s.assign) return h('td', { class: 'aw-text-tertiary', text: '—' });
    const replaces = o.content && o.previous !== 'NONE' && o.previous !== o.content;
    return h('td', { class: replaces ? 'wru-warn' : 'aw-text-tertiary' },
      o.previous === 'NONE' ? 'nothing' : o.previous,
      h('div', { text: o.content ? `→ ${o.content}` : 'kept' }));
  }

  function tags(o) {
    const out = [];
    if (!o.regions.length) out.push(tag('nothing', '', 'This output’s footprint is off its screen’s canvas'));
    else if (o.exact) out.push(tag('1:1', 'good', 'Whole pixels, nothing scaled: the Arena slice copies the composition’s pixels to the raster'));
    else out.push(tag('scaled', 'warn', 'A pitch ratio or a fractional footprint: Arena scales this rectangle of the composition to the raster'));
    for (const a of o.assumptions) out.push(tag(a, 'warn', NOTES[a] ? NOTES[a].text : a));
    return out;
  }

  function suggest(plan, cands) {
    const taken = new Set(Object.values(job.inputs).filter(Boolean));
    for (const s of plan.screens) {
      for (const o of s.outputs) {
        const k = `${s.id}/${o.key}`;
        if (job.inputs[k]) continue;
        const pick = suggestInputs(cands, o, taken, o.device)[0];
        if (pick) { job.inputs[k] = pick.key; taken.add(pick.key); }
      }
    }
    job.confirming = false;
    changed();
  }

  /* ---------------------------------------------------------------- arena */

  function arenaSection(plan) {
    const ok = plan.xml.ok;
    const count = plan.screens.reduce((n, s) => n + s.outputs.length, 0);
    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-rsm-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '3 · Resolume Arena' }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: `An Advanced Output preset: ${count} screen${count === 1 ? '' : 's'}, one per switcher output, on a ${plan.composition.width} × ${plan.composition.height} composition.` }),
      h('div', { class: 'lpp-rsm-row' },
        h('label', { class: 'lpp-rsm-row' },
          h('span', { class: 'aw-text-tertiary', text: 'Preset name' }),
          h('input', {
            type: 'text', class: 'wru-input lpp-rsm-text', value: job.name, 'data-lpp-key': 'rsm-name',
            placeholder: defaultName(plan.screens.map((s) => s.id)),
            onChange: (ev) => { job.name = String(ev.target.value); changed(); }
          })),
        button('Download preset (.xml)', {
          variant: 'go', disabled: !ok,
          title: ok ? 'Arena’s Advanced Output preset for these screens' : plan.xml.problems[0],
          onClick: () => downloadPreset(plan)
        })),
      h('ol', { class: 'lpp-rsm-how' }, HOW.map((t) => h('li', { text: t }))),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: UNVERIFIED }));
  }

  function downloadPreset(plan) {
    const { name, xml } = arenaPreset(plan);
    const blob = new Blob([xml], { type: 'application/xml' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    doc.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  /* ------------------------------------------------------------------ set */

  function setSection(store, plan) {
    const on = job.set.on;
    const head = h('div', { class: 'lpp-rsm-row' },
      checkbox('Put the chosen inputs into a background set', on, (v) => { job.set.on = v; job.confirming = false; changed(); },
        'Each output’s background becomes the input its Arena output is cabled into; an output with none keeps what its set holds'));
    if (!on) {
      return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-rsm-section' },
        h('div', { class: 'aw-font-subtitle-2', text: '4 · Background set — optional' }), head);
    }
    const setRows = plan.screens.map((s) => {
      if (!s.assign) return h('div', { class: 'lpp-rsm-row' }, h('span', { class: 'aw-font-body-1-bold', text: s.id }), h('span', { class: 'aw-text-tertiary', text: 'no input chosen — its sets are left alone' }));
      const sets = readSets(store, s.id);
      const pick = h('select', {
        class: 'wru-select', 'data-lpp-key': `rsm-set-${s.id}`,
        onChange: (ev) => { job.set.index[s.id] = Number(ev.target.value); job.confirming = false; changed(); }
      }, sets.map((x) => h('option', { value: String(x.index), selected: x.index === s.setIndex ? 'selected' : null },
        `Set ${x.index}${x.label ? ` “${x.label}”` : ''}${x.onProgram ? ' · ON PROGRAM' : x.onPreview ? ' · on preview' : ''}${Object.keys(x.contents).length ? ` · holds ${Object.keys(x.contents).length}` : x.empty ? ' · free' : ''}`)));
      return h('div', { class: 'lpp-rsm-row' },
        h('span', { class: 'aw-font-body-1-bold', text: s.id }),
        h('span', { class: 'aw-text-tertiary', text: 'into' }), pick,
        firstFreeSet(sets) == null && !job.set.index[s.id] ? h('span', { class: 'wru-warn', text: 'every set holds something — choose one to overwrite' }) : null,
        s.display ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: s.display }) : null);
    });
    const onProgram = plan.screens.some((s) => s.set && s.set.onProgram);
    const noDisplay = plan.screens.filter((s) => s.assign && s.display).map((s) => s.id);
    const fed = plan.screens.filter((s) => s.assign);
    const n = fed.reduce((k, s) => k + s.outputs.filter((o) => o.content).length, 0);
    const edids = job.set.edids ? fed.reduce((k, s) => k + s.outputs.filter((o) => o.content && o.edid && o.edid.kind).length, 0) : 0;
    const confirmText = `Write ${fed.map((s) => `${s.id} set ${s.setIndex}`).join(', ')} with ${n} live input${n === 1 ? '' : 's'}${edids ? `, and load ${edids} input EDID${edids === 1 ? '' : 's'} (not undoable)` : ''}?`;
    return h('div', { class: 'aw-flex-col aw-gap-row-small lpp-rsm-section' },
      h('div', { class: 'aw-font-subtitle-2', text: '4 · Background set — optional' }),
      head,
      setRows,
      h('label', { class: 'lpp-rsm-row' },
        h('span', { class: 'aw-text-tertiary', text: 'Name for the sets' }),
        h('input', {
          type: 'text', class: 'wru-input lpp-rsm-text', maxlength: String(LABEL_MAX), value: job.set.label, 'data-lpp-key': 'rsm-label', placeholder: 'e.g. Resolume',
          onChange: (ev) => { job.set.label = String(ev.target.value).slice(0, LABEL_MAX); changed(); }
        })),
      checkbox('Load each input plug with the switcher’s EDID for its output’s format', job.set.edids, (v) => { job.set.edids = v; changed(); },
        'The switcher builds it (Inputs ▸ EDID ▸ load from template), so Arena’s graphics card is offered exactly the mode a live background must match. Not undoable'),
      checkbox('Load each set into its screen’s preview afterwards', job.set.preview, (v) => { job.set.preview = v; changed(); },
        noDisplay.length ? `${noDisplay.join(', ')}: NATIVE layer not allocated — those screens will be skipped` : 'Writes the preview buffer’s NATIVE layer source; never program, never a take'),
      onProgram ? checkbox('A chosen set is ON PROGRAM — write it anyway, live', job.set.allowProgram, (v) => { job.set.allowProgram = v; changed(); }, 'The new background goes to air the moment it is written') : null,
      problemsList(plan.write.problems.filter((p) => !plan.xml.problems.includes(p))),
      job.confirming
        ? h('div', { class: 'lpp-rsm-row' },
          h('span', { class: 'aw-font-body-1-bold', text: confirmText }),
          button('Write', { variant: 'go', onClick: () => write(plan) }),
          button('Cancel', { variant: 'ghost', onClick: () => { job.confirming = false; changed(); } }))
        : h('div', { class: 'lpp-rsm-row' },
          button('Write to the switcher…', {
            disabled: !plan.write.ok || job.running,
            title: plan.write.ok ? 'Shows what will be written, then asks' : plan.write.problems[0],
            onClick: () => { job.confirming = true; changed(); }
          }),
          job.journal && !job.running ? button('Undo what was written', { variant: 'danger', onClick: () => undo() }) : null),
      job.progress.length ? h('ol', { class: 'lpp-rsm-steps' }, job.progress.map((p) => h('li', { class: `lpp-rsm-step--${p.state}`, text: p.text }))) : null);
  }

  async function write(plan) {
    job.confirming = false;
    job.running = true;
    job.progress = [];
    changed();
    const onStep = (text, state) => {
      const last = job.progress[job.progress.length - 1];
      if (last && last.state === 'running' && state !== 'note') job.progress.pop();
      job.progress.push({ text, state });
      changed();
    };
    const result = await applyPlan({
      session, plan,
      options: { label: job.set.label, edids: job.set.edids, preview: job.set.preview, allowProgram: job.set.allowProgram },
      onStep
    });
    job.journal = result.journal;
    onStep(result.ok ? 'Done.' : 'Stopped. Everything above it was written; Undo takes it back off.', result.ok ? 'done' : 'failed');
    job.running = false;
    changed();
  }

  async function undo() {
    if (!job.journal) return;
    job.running = true;
    job.progress.push({ text: 'Undoing…', state: 'running' });
    changed();
    const result = await revert({ session, journal: job.journal, onStep: (text, state) => { job.progress.push({ text, state }); changed(); } });
    job.progress.push({ text: result.ok ? 'Undone.' : `Not everything came back: ${result.problems.join('; ')}`, state: result.ok ? 'done' : 'failed' });
    if (result.ok) job.journal = null;
    job.running = false;
    changed();
  }

  /* ---------------------------------------------------------------- bits */

  function notesSection() {
    return h('details', { class: 'lpp-rsm-section' },
      h('summary', { class: 'aw-text-tertiary', text: 'What is proven, and what is not' }),
      h('ul', { class: 'wru-warnings' },
        h('li', {}, tag('assumed', 'warn'), h('span', { text: UNVERIFIED })),
        Object.entries(NOTES).map(([k, n]) => h('li', {},
          tag(n.proven ? 'proven' : 'assumed', n.proven ? 'good' : 'warn'), h('span', { text: n.text }), h('span', { class: 'aw-text-tertiary', text: ` (${k})` })))));
  }

  function problemsList(list) {
    return list.length ? h('ul', { class: 'wru-warnings lpp-rsm-problems' }, list.map((p) => h('li', { text: p }))) : null;
  }

  function chip(label, on, onClick, title) {
    return h('button', { class: ['lpp-chip', on ? 'lpp-chip--on' : ''], type: 'button', title, onClick }, label);
  }

  function checkbox(label, on, onSet, title) {
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', title },
      h('input', { type: 'checkbox', checked: on ? 'checked' : null, onChange: (ev) => onSet(!!ev.target.checked) }),
      h('span', { text: label }),
      title ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: `— ${title}` }) : null);
  }

  const tag = (text, tone, title) => h('span', { class: ['lpp-rsm-tag', tone ? `lpp-rsm-tag--${tone}` : ''], title, text });

  return { render, job };
}
