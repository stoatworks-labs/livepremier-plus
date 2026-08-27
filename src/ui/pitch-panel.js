/*
 * Pitch compensation.
 *
 * A screen spanning LED walls of different pixel pitches needs each output
 * group told how much canvas its raster is worth, or a layer crossing the join
 * changes physical size the instant it crosses. The device has two fields for
 * it — Preconfig > Canvas > Pitch, H Ratio and V Ratio — and no help at all
 * working out what to put in them.
 *
 * The device knows every number but one. It has the rasters, it knows which
 * outputs belong to the screen, and it will say what ratios are set. It has no
 * idea how far apart the LEDs are and never will, because that is a fact about
 * the room. So this panel reads the first lot and asks for the pitches.
 *
 * All of the arithmetic is the vendored engine in `../vendor/pitch-engine.js`,
 * which is aquilon-pitch's own — including the parts that are easy to get
 * backwards and still look right: the ratio MULTIPLIES the raster, the field
 * holds 0.100 to 10.000 in thousandths, out-of-range writes are discarded
 * rather than clamped, and the canvas footprint FLOORS. This file only draws,
 * and adapts the store through `../core/pitch.js`.
 */

import { h, button, readout, sectionTitle } from './dom.js';
import { panel } from './shell.js';
import { listDestinations } from '../core/screens.js';
import { screenOutputs, toProject, pitchWrites, alreadyApplied } from '../core/pitch.js';
import { compensate, PITCH_UNITY, UI_LOCATION } from '../vendor/pitch-engine.js';

export function createPitchPanel({ session, onRefresh }) {
  /* Typed pitches, keyed by output. Deliberately NOT persisted to the device —
     there is nowhere on a LivePremier to put a pixel pitch, and inventing a
     place to stash it in someone's show file is not this panel's business. */
  const pitches = {};
  const view = { screenId: null, referenceKey: '', arrangement: 'row', confirming: false };

  function screens(store) {
    return listDestinations(store).filter((d) => d.kind === 'screen');
  }

  function render() {
    const store = session.store;
    if (!store.ready) {
      return panel({
        toolbar: sectionTitle('Pitch compensation'),
        body: h('div', { class: 'wru-empty', text: 'Waiting for the device store…' })
      });
    }

    const list = screens(store);
    if (!list.length) {
      return panel({
        toolbar: sectionTitle('Pitch compensation'),
        body: h('div', { class: 'wru-empty', text: 'No screens are configured on this device.' })
      });
    }

    if (!view.screenId || !list.some((s) => s.id === view.screenId)) {
      view.screenId = list[0].id;
    }

    const outputs = screenOutputs(store, view.screenId);
    const project = toProject(outputs, pitches, {
      referenceKey: view.referenceKey,
      arrangement: view.arrangement,
      name: view.screenId
    });
    const result = compensate(project);

    return panel({
      toolbar: sectionTitle('Pitch compensation', screenPicker(list)),
      body: h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        outputs.length
          ? [
              h('div', { class: 'aw-font-caption aw-text-tertiary', text: UI_LOCATION }),
              table(outputs, result),
              controls(outputs, result),
              summary(result),
              warnings(result)
            ]
          : h('div', {
              class: 'wru-empty',
              text: `No outputs are assigned to ${view.screenId}.`
            }))
    });
  }

  function screenPicker(list) {
    const sel = h('select', {
      class: 'wru-select',
      onChange: (ev) => {
        view.screenId = ev.target.value;
        /* The reference is an output key, and output keys do not carry across
           screens. Keeping it would silently name an output on the old one. */
        view.referenceKey = '';
        onRefresh && onRefresh();
      }
    });
    for (const s of list) {
      sel.append(h('option', { value: s.id, selected: s.id === view.screenId ? 'selected' : null },
        `${s.id}${s.label && s.label !== s.id ? ` — ${s.label}` : ''}`));
    }
    return sel;
  }

  function table(outputs, result) {
    const byKey = new Map(result.groups.map((g) => [g.group.outputKey, g]));

    const head = h('tr', {},
      h('th', { text: 'Out' }),
      h('th', { text: 'Raster' }),
      h('th', { text: 'Pitch mm' }),
      h('th', { text: 'H' }),
      h('th', { text: 'V' }),
      h('th', { text: 'Canvas' }),
      h('th', { text: 'Now' }));

    const rows = outputs.map((o) => {
      const g = byKey.get(o.key);
      const isRef = g && g.isReference;

      return h('tr', { class: isRef ? 'wru-row--active' : null },
        h('td', {},
          h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
            h('input', {
              type: 'radio', name: 'wru-pitch-ref',
              checked: isRef ? 'checked' : null,
              title: 'Hold this output at 1.000',
              onChange: () => { view.referenceKey = o.key; onRefresh && onRefresh(); }
            }),
            h('span', { text: o.key }))),
        h('td', { class: 'aw-text-tertiary', text: `${o.pxWidth}×${o.pxHeight}` }),
        h('td', {}, pitchInput(o)),
        h('td', { class: cellTone(g, 'h'), text: ratioText(g, 'h') }),
        h('td', { class: cellTone(g, 'v'), text: ratioText(g, 'v') }),
        h('td', { class: 'aw-text-tertiary', text: footprintText(g) }),
        h('td', { class: 'aw-text-tertiary', text: liveText(o) }));
    });

    return h('table', { class: 'wru-table wru-pitch-table' },
      h('thead', {}, head), h('tbody', {}, rows));
  }

  /*
   * One field, not two.
   *
   * The device holds H and V separately and the engine carries them
   * separately, so a genuinely non-square wall is expressible — but typing two
   * numbers per output for the square pixels everybody actually has is a tax
   * on the common case. Type "2.6" and both axes take it; type "2.6 x 3.0" and
   * they part company.
   */
  function pitchInput(o) {
    const p = pitches[o.key];
    const value = !p ? ''
      : p.hMm === p.vMm ? String(p.hMm)
        : `${p.hMm} x ${p.vMm}`;

    return h('input', {
      class: 'wru-input wru-input--narrow',
      type: 'text',
      value,
      placeholder: '2.6',
      title: 'Pixel pitch in mm. "2.6" sets both axes; "2.6 x 3.0" sets them apart.',
      onChange: (ev) => {
        const parsed = parsePitch(ev.target.value);
        if (parsed) pitches[o.key] = parsed;
        else delete pitches[o.key];
        onRefresh && onRefresh();
      }
    });
  }

  function controls(outputs, result) {
    const writes = pitchWrites(result);
    const applied = alreadyApplied(result, outputs);
    const blocked = result.warnings.filter((w) => w.level === 'error').length;
    const ready = writes.length > 0 && result.reference;

    const apply = () => {
      let sent = 0;
      for (const w of writes) if (session.send({ path: w.path, value: w.value })) sent += 1;
      console.info('[wru] pitch', `sent ${sent}/${writes.length} writes`);
      view.confirming = false;
      onRefresh && onRefresh();
    };

    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini aw-font-caption' },
        h('span', { text: 'Outputs run' }),
        h('select', {
          class: 'wru-select',
          onChange: (ev) => { view.arrangement = ev.target.value; onRefresh && onRefresh(); }
        },
        h('option', { value: 'row', selected: view.arrangement === 'row' ? 'selected' : null }, 'left to right'),
        h('option', { value: 'column', selected: view.arrangement === 'column' ? 'selected' : null }, 'top to bottom'))),

      view.confirming
        /*
         * Two presses, on purpose.
         *
         * This writes a preconfig change to a machine that may be in a show,
         * and it moves every output on the screen at once. Nothing else in
         * this panel touches the device; the one control that does should be
         * hard to hit by accident.
         */
        ? [
            button('Confirm — write to device', { onClick: apply, variant: 'primary', iconId: 'check-14' }),
            button('Cancel', { onClick: () => { view.confirming = false; onRefresh && onRefresh(); } })
          ]
        : button(applied ? 'Already set on the device' : 'Apply to device', {
            onClick: () => { view.confirming = true; onRefresh && onRefresh(); },
            variant: 'primary',
            disabled: !ready || applied,
            title: !ready
              ? 'Type a pitch for at least two outputs first'
              : applied
                ? 'The device already holds these ratios'
                : `Writes ${writes.length} values across ${writes.length / 3} outputs`
          }),

      blocked
        ? h('span', {
            class: 'aw-font-caption aw-text-error',
            text: `${blocked} ratio${blocked === 1 ? '' : 's'} the device would refuse — not included`
          })
        : null);
  }

  function summary(result) {
    if (!result.reference) {
      return h('div', {
        class: 'aw-font-caption aw-text-tertiary',
        text: 'Type a pixel pitch against at least one output to begin.'
      });
    }
    return h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
      readout('Screen canvas', `${result.canvas.width} × ${result.canvas.height}`),
      readout('Canvas pixel', `${result.canvasPitch.meanMm.toFixed(3)} mm`),
      readout('Reference', `Output ${result.reference.group.outputKey}`));
  }

  function warnings(result) {
    if (!result.warnings.length) return null;
    return h('ul', { class: 'wru-warnings' },
      result.warnings.map((w) => h('li', {
        class: w.level === 'error' ? 'aw-text-error' : w.level === 'warn' ? 'aw-text-warning' : 'aw-text-tertiary',
        text: w.message
      })));
  }

  return { render };
}

/* ------------------------------------------------------------------ format */

function ratioText(g, axis) {
  if (!g) return '—';
  const a = g[axis];
  /* An out-of-range ratio is shown as the number that was wanted, marked, not
     as the clamped value the device would never have taken. */
  return a.outOfRange ? `${a.exact.toFixed(3)} ✕` : a.ratio.toFixed(3);
}

function cellTone(g, axis) {
  if (!g) return 'aw-text-tertiary';
  const a = g[axis];
  if (a.outOfRange) return 'aw-text-error';
  if (a.raw === PITCH_UNITY) return 'aw-text-tertiary';
  return null;
}

function footprintText(g) {
  if (!g) return '—';
  if (g.h.outOfRange || g.v.outOfRange) return '—';
  return `${g.h.footprint}×${g.v.footprint}`;
}

/** What the device is holding right now, in the units the operator reads. */
function liveText(o) {
  if (o.liveRawH == null || o.liveRawV == null) return '—';
  const hh = (o.liveRawH / 1000).toFixed(3);
  const vv = (o.liveRawV / 1000).toFixed(3);
  return hh === vv ? hh : `${hh}/${vv}`;
}

/**
 * "2.6" -> both axes. "2.6 x 3.0", "2.6*3", "2.6/3" -> separately.
 *
 * Returns null for anything that is not a usable pitch, including zero and
 * negatives, so a half-typed field leaves the output out of the calculation
 * rather than poisoning it.
 */
export function parsePitch(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const parts = s.split(/\s*[x×*/]\s*/i).map((t) => Number(t.replace(',', '.')));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  if (parts.length === 1) return { hMm: parts[0], vMm: parts[0] };
  if (parts.length === 2) return { hMm: parts[0], vMm: parts[1] };
  return null;
}
