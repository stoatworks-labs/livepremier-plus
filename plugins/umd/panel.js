/*
 * UMD Generator — the tab on the Screens / Aux. strip.
 *
 * One destination at a time, top to bottom in the order the work is done:
 * the layout (a template, or the layers as they are), what each box is
 * called, how the UMD looks, a preview, and what to do with it. Like every
 * panel here it is immediate-mode and redrawn in place — the same element
 * while nothing it shows has changed, nothing rebuilt while the pointer is
 * down in it (see Pixel Map's panel for why "pressed" and not "focused").
 */

import { h, fill, note, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { LABEL_MODES, LABEL_FROM, BUFFERS, withDest, withStyle, fileName } from './core.js';
import { drawPreview } from './render.js';

const PREVIEW_WIDTH = 320;

/**
 * @param {object} o
 * @param {() => boolean} o.ready
 * @param {() => object} o.doc
 * @param {(next: object) => void} o.change
 * @param {() => object[]} o.destinations
 * @param {() => string|null} o.selected
 * @param {(id: string) => object|null} o.model     `client.js`'s model of one destination
 * @param {() => object} o.run                     `{ running, steps, journal, error }`
 * @param {() => boolean} o.canWrite               a LivePremier with an image library
 * @param {() => object|null} o.backgrounds        the Background Slicer's service
 * @param {object} o.actions
 */
export function createUmdPanel({ ready, doc, change, destinations, selected, model, run, canWrite, backgrounds, actions }) {
  let root = null;
  let shown = null;
  let pressed = false;
  let confirming = null;

  const select = (choices, current, onPick, attrs = {}) =>
    h('select', { class: 'wru-input', onChange: (ev) => onPick(ev.target.value), ...attrs },
      choices.map((c) => h('option', { value: c.id, selected: c.id === current ? 'selected' : null, text: c.label })));

  const labelled = (label, control, flex = '1 1 6rem') =>
    h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { flex, minWidth: '0' } },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  const heading = (text) => h('div', { class: 'aw-font-subtitle-2', text });

  const setDest = (id, patch) => change(withDest(doc(), id, patch));
  const setStyle = (patch) => change(withStyle(doc(), patch));

  function toolbar(dests, id, m) {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
      h('div', { class: 'aw-font-subtitle-1', text: 'UMD' }),
      dests.length
        ? select(dests.map((d) => ({ id: d.id, label: `${d.id}${d.label ? ` ${d.label}` : ''} · ${d.canvas.width}×${d.canvas.height}` })),
          id, (v) => actions.select(v), { 'aria-label': 'Destination', style: { flex: '1 1 8rem', minWidth: '0' } })
        : null,
      m ? h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', title: BUFFERS.find((b) => b.id === m.entry.buffer).what },
        select(BUFFERS, m.entry.buffer, (v) => setDest(id, { buffer: v }), { 'aria-label': 'Buffer', style: { width: '4.5rem' } }))
        : null);
  }

  /** A template drawn small: its cells over a canvas-shaped box. */
  function miniature(template, canvas) {
    const box = h('div', {
      class: 'lpp-umd-mini', 'aria-hidden': 'true',
      style: { position: 'relative', width: '4rem', aspectRatio: `${canvas.width} / ${canvas.height}`, background: '#000', flex: 'none', borderRadius: '0.15rem' }
    });
    for (const [x, y, s] of template.cells) {
      box.append(h('div', {
        style: {
          position: 'absolute', left: `${x * 100}%`, top: `${y * 100}%`, width: `${s * 100}%`, height: `${s * 100}%`,
          boxSizing: 'border-box', border: '1px solid #9aa4b2', background: '#3a4048'
        }
      }));
    }
    return box;
  }

  function layoutSection(m) {
    const { dest, layers, target } = m;
    const n = layers.layers.length;
    let say;
    if (target === 'layer') {
      if (n < 2) {
        say = note('warn', `${dest.id} has ${n === 1 ? 'one layer' : 'no layers'}, and needs two: one for the UMD over at least one box. An advanced aux’s layers come with its capability — 4K gives 2, 5K 4, “6” 6 and 8K 8 (Preconfig ▸ Resources, on its output).`);
      } else {
        say = note('', `${dest.id} has ${n} layers: L${layers.umd} carries the UMD, L${layers.boxes[0]}–L${layers.boxes[layers.boxes.length - 1]} are the boxes.`);
      }
    } else {
      say = note('', `${dest.id}’s ${n} layer${n === 1 ? ' is' : 's are'} the boxes. The UMD goes on its background, under them.`);
    }
    const choices = [{ id: '', label: 'Layers as they are' }, ...m.templates.map((t) => ({ id: t.id, label: `${t.boxes} · ${t.label}` }))];
    const t = m.template && m.templates.some((x) => x.id === m.template.id) ? m.template : null;
    const gap = h('input', {
      type: 'number', class: 'wru-input', min: '0', max: '200', step: '2', value: String(m.entry.gap),
      'aria-label': 'Gap between boxes, pixels', dataset: { lppKey: `umd-gap-${dest.id}` },
      style: { width: '4.5rem' },
      onChange: (ev) => setDest(dest.id, { gap: Number(ev.target.value) || 0 })
    });
    const write = canWrite();
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      heading('Layout'),
      say,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        labelled('Template', select(choices, t ? t.id : '', (v) => setDest(dest.id, { template: v || null }),
          { 'aria-label': `${dest.id} template` }), '1 1 8rem'),
        labelled('Gap', gap, '0 0 auto'),
        t ? miniature(t, dest.canvas) : null),
      t ? note('', `${t.what} Writes the position and size of L${layers.boxes.slice(0, t.boxes).join(', L')} in ${m.entry.buffer === 'program' ? 'program — on air' : 'preview'}${layers.boxes.length > t.boxes ? `, and empties L${layers.boxes.slice(t.boxes).join(', L')}` : ''}. Sources are left as they are.`) : null,
      t ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button(`Lay out ${m.entry.buffer === 'program' ? 'PGM' : 'PRW'}`, {
          variant: m.entry.buffer === 'program' ? 'danger' : 'default',
          disabled: !write || run().running || !m.bank.settled,
          title: write ? `Lay out ${dest.id}’s layers as ${t.label}` : 'Writing to the switcher is LivePremier only',
          onClick: () => actions.layOut(dest.id)
        }))
        : null,
      !m.templates.length && layers.boxes.length === 0 ? null
        : (m.templates.length < 2 && target === 'layer' && layers.boxes.length < 3
          ? note('', 'More layers give more templates: 3, 5 and 7 boxes need 4, 6 and 8 layers.') : null));
  }

  function boxesSection(m) {
    if (!m.rows.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      heading('Names'),
      m.rows.map((r) => h('div', { class: 'aw-flex-row-center-v aw-gap-col-small', dataset: { lppUmdRow: r.key } },
        h('div', { class: 'aw-font-body-1-bold', style: { width: '2.2rem', flex: 'none' }, text: `L${r.key}` }),
        h('input', {
          type: 'text', class: 'wru-input', value: r.name, placeholder: r.auto || (r.shows ? '' : 'empty — not drawn'),
          maxlength: '32', 'aria-label': `L${r.key} name`, dataset: { lppKey: `umd-name-${m.dest.id}-${r.key}` },
          style: { flex: '1 1 auto', minWidth: '0' },
          onChange: (ev) => setDest(m.dest.id, { names: { [r.key]: ev.target.value } })
        }),
        h('div', { class: 'aw-font-caption aw-text-tertiary', style: { flex: 'none' }, text: r.source === 'NONE' ? '—' : r.source.replace('_', ' ') }))),
      note('', 'Blank uses the source’s own name. A name of your own also draws an empty layer’s box.'));
  }

  function lookSection(d, m) {
    const s = d.style;
    const range = (label, min, max, stepV, value, onSet, fmt) => {
      const out = h('span', { class: 'aw-font-caption aw-text-tertiary', style: { width: '2.6rem', textAlign: 'right' }, text: fmt(value) });
      return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', style: { width: '4.5rem' }, text: label }),
        h('input', {
          type: 'range', min: String(min), max: String(max), step: String(stepV), value: String(value),
          'aria-label': label, style: { flex: '1 1 auto', minWidth: '4rem' },
          onInput: (ev) => { out.textContent = fmt(Number(ev.target.value)); },
          onChange: (ev) => onSet(Number(ev.target.value))
        }), out);
    };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      heading('Look'),
      h('div', { class: 'aw-flex-row aw-gap-col-small' },
        labelled('Labels', select(LABEL_MODES, m.labels, (v) => setDest(m.dest.id, { labels: v }),
          { title: LABEL_MODES.find((x) => x.id === m.labels).what, 'aria-label': 'Label position' })),
        labelled('Name from', select(LABEL_FROM, s.labelFrom, (v) => setStyle({ labelFrom: v }),
          { title: LABEL_FROM.find((x) => x.id === s.labelFrom).what, 'aria-label': 'Name from' }))),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('input', { type: 'checkbox', checked: s.border ? 'checked' : null, onChange: (ev) => setStyle({ border: ev.target.checked }) }),
          h('span', { class: 'aw-font-caption', text: 'Borders' })),
        h('input', {
          type: 'number', class: 'wru-input', min: '0', max: '32', value: s.borderWidth ? String(s.borderWidth) : '',
          placeholder: `auto (${m.plan.border || 2})`, 'aria-label': 'Border width, pixels', dataset: { lppKey: 'umd-border-width' },
          disabled: s.border ? null : 'disabled', style: { width: '5.5rem' },
          onChange: (ev) => setStyle({ borderWidth: Number(ev.target.value) || 0 })
        }),
        h('input', {
          type: 'color', value: s.borderColour, 'aria-label': 'Border colour', disabled: s.border ? null : 'disabled',
          style: { width: '2.2rem', height: '1.6rem', padding: '0', border: 'none', background: 'none' },
          onChange: (ev) => setStyle({ borderColour: ev.target.value })
        }),
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini aw-margin-left-auto' },
          h('input', { type: 'checkbox', checked: s.uppercase ? 'checked' : null, onChange: (ev) => setStyle({ uppercase: ev.target.checked }) }),
          h('span', { class: 'aw-font-caption', text: 'CAPITALS' }))),
      range('Text size', 50, 200, 5, Math.round(s.textScale * 100), (v) => setStyle({ textScale: v / 100 }), (v) => `${v}%`),
      range('Tab', 0, 100, 5, Math.round(s.tabOpacity * 100), (v) => setStyle({ tabOpacity: v / 100 }), (v) => `${v}%`));
  }

  function previewSection(m) {
    /* Drawn at the screen's own density: at a sixth of the canvas a 2 px
       line is a third of a pixel, and only a high-density preview shows it. */
    const density = Math.min(3, Math.max(1, Math.round((typeof window !== 'undefined' && window.devicePixelRatio) || 1)));
    const scale = (PREVIEW_WIDTH * density) / m.plan.width;
    const canvas = h('canvas', {
      class: 'lpp-umd-preview', width: String(Math.round(m.plan.width * scale)), height: String(Math.round(m.plan.height * scale)),
      'aria-label': `${m.dest.id} UMD preview`, role: 'img',
      style: { width: '100%', height: 'auto', borderRadius: '0.2rem', display: 'block' }
    });
    const ctx = canvas.getContext ? canvas.getContext('2d') : null;
    if (ctx) {
      try { drawPreview(ctx, m.plan, { scale, target: m.target, boxes: m.boxes }); } catch { /* no canvas in this browser */ }
    }
    const notes = [
      ...m.plan.warnings,
      ...m.plan.items.flatMap((i) => i.notes.map((n) => `L${i.key}: ${n}`))
    ];
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      heading('Preview'),
      canvas,
      note('', `${m.plan.width}×${m.plan.height}, transparent but for ${m.plan.items.length} box${m.plan.items.length === 1 ? '' : 'es'}${m.target === 'background' ? ', shown under grey stand-ins for the layers' : ', over grey stand-ins for the pictures'}.`),
      notes.map((n) => note('warn', n)));
  }

  function placedLine(m) {
    const p = m.placed;
    if (!p) return null;
    if (!p.file || !p.stillShows) return note('warn', `The UMD put on ${m.dest.id} before is gone: library slot ${p.slot} or still ${p.still} holds something else now. Putting it on again takes a fresh pair.`);
    const where = [p.inProgram ? 'PGM' : null, p.inPreview ? 'PRW' : null].filter(Boolean);
    const said = where.length
      ? `On ${m.dest.id} L${p.layer} in ${where.join(' and ')}: still ${p.still}, library slot ${p.slot}.`
      : `In still ${p.still} (library slot ${p.slot}), but no buffer of ${m.dest.id} shows it on L${p.layer} now.`;
    return note(p.current ? '' : 'warn', `${said} ${p.current ? 'Up to date.' : 'Out of date — the layers have moved or been renamed since. Update it.'}`);
  }

  function actionsSection(m) {
    const r = run();
    const write = canWrite();
    const buttons = [button('Download PNG', { onClick: () => actions.download(m.dest.id), title: `Save ${fileName(m.dest.id)}`, disabled: !m.boxes.length })];
    const lines = [];
    if (m.target === 'layer') {
      const p = m.placed;
      const update = p && p.file && p.stillShows;
      const air = (update && p.onProgram) || m.entry.buffer === 'program';
      const armed = confirming === m.dest.id;
      const label = armed ? 'Confirm — changes program' : update ? 'Update UMD' : `Put on L${m.layers.umd || '?'} · ${m.entry.buffer === 'program' ? 'PGM' : 'PRW'}`;
      buttons.push(button(label, {
        variant: armed ? 'danger' : 'go',
        disabled: !write || r.running || !m.layers.umd || !m.boxes.length || !m.bank.settled,
        title: write ? (update ? `Upload the new picture into library slot ${p.slot}: still ${p.still} and L${p.layer} follow it` : `Upload into the image library, load a still, and show it on ${m.dest.id} L${m.layers.umd}`) : 'Writing to the switcher is LivePremier only',
        onClick: () => {
          if (air && !armed) { confirming = m.dest.id; shown = null; root && render(); return; }
          confirming = null;
          actions.put(m.dest.id);
        }
      }));
      if (armed) lines.push(note('warn', update && p.onProgram ? 'This UMD is on program: the new one is on air the moment it lands.' : 'Program is on air: this goes straight to the output.'));
      if (!write) lines.push(note('', 'Putting a UMD on the switcher is LivePremier only. Download the PNG and load it by hand.'));
    } else {
      const service = backgrounds();
      buttons.push(button('To Background Slicer', {
        variant: 'go', disabled: !service || r.running || !m.boxes.length,
        title: service ? 'Hand the UMD to the Background Slicer, which cuts it per output and writes a background set' : 'Switch the Background Slicer on first',
        onClick: () => actions.offer(m.dest.id)
      }));
      if (!service) lines.push(note('', 'A screen’s background is cut per output by the Background Slicer — switch it on in Preconfig ▸ LivePremier Plus → Plugins, or download the PNG.'));
    }
    if (r.journal && r.journal.id === m.dest.id && !r.running) {
      buttons.push(button('Undo', { variant: 'ghost', onClick: () => actions.undo(), title: `Put back what the last action wrote to ${m.dest.id}` }));
    }
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' }, buttons),
      lines,
      placedLine(m),
      r.steps.length ? h('ol', { class: 'aw-flex-col aw-gap-row-mini', style: { margin: '0', paddingLeft: '1.1rem' } },
        r.steps.map((s, i) => h('li', {
          class: ['aw-font-caption', s.state === 'failed' ? 'wru-warn' : s.state === 'note' ? 'aw-text-tertiary' : ''],
          text: `${s.state === 'running' && r.running && i === r.steps.length - 1 ? '… ' : s.state === 'failed' ? '✗ ' : ''}${s.text}`
        }))) : null);
  }

  function body(d, dests, id, m) {
    if (!ready()) return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting for the switcher…' });
    if (!dests.length || !m) return note('', 'No screens or auxiliaries in service.');
    return h('div', { class: 'aw-flex-col aw-gap-row-big' },
      layoutSection(m),
      boxesSection(m),
      lookSection(d, m),
      previewSection(m),
      actionsSection(m));
  }

  function signature(d, dests, id, m) {
    return JSON.stringify([
      ready(), d, id, confirming, canWrite(), !!backgrounds(), run(),
      dests.map((x) => [x.id, x.label, x.canvas.width, x.canvas.height]),
      m && [m.target, m.labels, m.layers, m.bank, m.rows, m.print, m.placed, m.plan.warnings, m.plan.items.map((i) => i.notes), m.templates.map((t) => t.id)]
    ]);
  }

  const busy = () => pressed;

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
    const id = ready() ? selected() : null;
    const m = id ? model(id) : null;
    if (confirming && confirming !== id) confirming = null;
    const sig = signature(d, dests, id, m);
    if (root && sig === shown) return root;
    if (root && busy()) return root;
    const fresh = panel({ toolbar: toolbar(dests, id, m), body: body(d, dests, id, m) });
    if (root) fill(root, ...fresh.childNodes);
    else { root = fresh; watch(root); }
    shown = sig;
    return root;
  }

  return { render, busy };
}
