/*
 * Layer properties, drawn from the catalogue rather than from a hand-built form.
 *
 * Same reason the memories panel exists: the vendor's Properties tab is a
 * React pane and a React pane cannot be moved into a second window. Everything
 * structural is in `core/properties.js`; this file turns twelve groups of
 * specs into fields and sends what comes back.
 *
 * ## Nothing here knows the name of a single property
 *
 * The sections, the field types, the ranges and the enum members all come out
 * of `vendor/surface/catalogue.json`, which was generated from a device's own
 * bundle and store dump. So this panel has no list of parameters to keep in
 * step with a firmware — regenerate the catalogue and the fields change on
 * their own. The only thing written by hand is the group order, and a group
 * the catalogue grows that is not in that list still appears, at the end,
 * under its own name.
 *
 * ## The buffer is the dangerous part
 *
 * A layer property is addressed by preset LETTER, and which letter is on air
 * changes on every take. Choosing PREVIEW here means "whichever letter is
 * preview at the moment I press Enter", which is what an operator means, but
 * it also means the same field can be safe at one moment and live at the next.
 * So: the resolved letter is always shown beside the choice, a buffer that is
 * on air is banded in red, and mid-take — when there is no honest answer —
 * writes are refused rather than guessed. See `core/properties.js`.
 */

import { h, button, isEnter } from './dom.js';
import { panel } from './shell.js';
import { listDestinations, sourceLabel } from '../core/screens.js';
import { dialectFor, dialectOrDefault } from '../core/dialect.js';
import {
  layerSections, valuesFor, readValue, writeCmd, coerce, fittedLayers, bankLetter
} from '../core/properties.js';
import { label as paramLabel } from '../vendor/surface/catalogue.js';

/** Groups that are open the first time the panel is drawn. */
const OPEN_BY_DEFAULT = new Set(['source', 'position', 'opacity']);

/**
 * @param {{session: object, onRefresh: Function, popoutEnabled?: boolean,
 *          doc?: Document}} opts
 */
export function createPropertiesPanel({
  session, onRefresh = () => {}, popoutEnabled = true, doc = document
} = {}) {
  /*
   * Rebuilt per render rather than once: the catalogue is the platform's, and
   * the platform is only known once the store has arrived — and changes if
   * the operator re-points at a different frame.
   */
  const sections = () => layerSections(store());

  const view = {
    dest: null,
    layer: null,
    /* PREVIEW, PROGRAM, or a literal letter when someone deliberately picks
       the buffer rather than the role. */
    mode: 'PREVIEW',
    open: new Set(OPEN_BY_DEFAULT),
    showReadOnly: false,
    /* {id, text} while a numeric field is being typed into. */
    editing: null,
    note: null
  };

  const busy = () => view.editing != null;
  const store = () => session.store;

  function destinations() {
    return store().ready ? listDestinations(store()) : [];
  }

  function currentDest() {
    const all = destinations();
    if (!all.length) return null;
    return all.find((d) => d.id === view.dest) || all[0];
  }

  function currentLayer(dest) {
    if (!dest) return null;
    const layers = fittedLayers(store(), dest.id);
    if (!layers.length) return null;
    return (layers.find((l) => l.key === view.layer) || layers[0]).key;
  }

  /** The resolved address, plus what is risky about it. */
  function resolved() {
    const dest = currentDest();
    if (!dest) return null;
    const layer = currentLayer(dest);
    if (layer == null) return null;
    const bank = bankLetter(store(), dest.id, view.mode);
    if (!bank.letter) return null;
    return { id: dest.id, bank: bank.letter, layer, live: bank.live, settled: bank.settled, dest };
  }

  function note(tone, text) {
    view.note = { tone, text };
    onRefresh();
  }

  /* ---------------------------------------------------------------- write */

  function write(spec, raw) {
    const target = resolved();
    if (!target) { note('err', 'no layer to write to'); return; }
    /*
     * Mid-take PROGRAM and PREVIEW do not name a letter honestly — the device
     * is showing a mix of both. Writing anyway is how a "preview" edit lands
     * on the output for the length of a fade. A literal letter is still fine,
     * because the operator named the buffer rather than the role.
     */
    if (!target.settled && (view.mode === 'PROGRAM' || view.mode === 'PREVIEW')) {
      note('warn', 'a take is in flight — preview and program do not name a buffer until it lands');
      return;
    }
    const cmd = writeCmd(target, spec, raw, store());
    if (!cmd) {
      note('err', `${paramLabel(spec.id)}: ${coerce(spec, raw, store()).note || 'refused'}`);
      return;
    }
    const ok = session.send(cmd);
    const where = `${target.id} ${target.bank} L${target.layer}`;
    if (!ok) note('err', `${paramLabel(spec.id)} not sent — the socket is not open`);
    else note(cmd.note ? 'warn' : 'ok',
      `${where} ${paramLabel(spec.id)} = ${format(cmd.value)}${cmd.note ? ' (' + cmd.note + ')' : ''}`);
  }

  const format = (v) => (Array.isArray(v) ? (v.join(', ') || 'none') : String(v));

  /* -------------------------------------------------------------- popout */

  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open('/__lpp/properties', 'lpp-properties',
      'width=1000,height=880,menubar=no,toolbar=no,location=no');
    if (!child) note('warn', 'the browser blocked the window — allow pop-ups for this address');
  }

  /* ------------------------------------------------------------- toolbar */

  function chip(text, on, onClick, extra = '') {
    return h('button', {
      class: ['lpp-chip', on ? 'lpp-chip--on' : '', extra], type: 'button', onClick
    }, text);
  }

  function toolbar() {
    const dest = currentDest();
    const target = resolved();
    return [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large lpp-controls aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Layer' }),
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'On' }),
          h('select', {
            class: 'wru-select',
            onChange: (ev) => { view.dest = ev.target.value; view.layer = null; onRefresh(); }
          }, ...destinations().map((d) => h('option', {
            value: d.id, selected: dest && d.id === dest.id ? 'selected' : null
          }, d.label ? `${d.id} — ${d.label}` : d.id)))),
        layerPicker(dest, target)),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small lpp-controls aw-flex-wrap' },
        bufferChips(target),
        popoutEnabled
          ? button('Pop out', {
            iconId: 'set-layer-to-fullscreen-18',
            title: 'Open the layer properties in their own window',
            onClick: popOut
          })
          : null)
    ];
  }

  function layerPicker(dest, target) {
    const layers = dest ? fittedLayers(store(), dest.id) : [];
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Layer' }),
      h('select', {
        class: 'wru-select',
        onChange: (ev) => { view.layer = ev.target.value; onRefresh(); }
      }, ...layers.map((l) => h('option', {
        value: l.key, selected: target && l.key === target.layer ? 'selected' : null
      }, l.key === 'NATIVE' ? 'Native' : `L${l.key}`))));
  }

  /**
   * PRW / PGM, then the three letters.
   *
   * Both spellings are offered because they answer different questions.
   * PRW and PGM are roles and follow the take; the literal buffers — A, B and
   * C on LivePremier, UP and DOWN on Midra — stay put, which is what you want
   * when you are building a memory that is neither on air nor cued. The
   * resolved buffer is shown next to the roles so there is never any doubt
   * which one a write is about to land in. The platform says which literals
   * there are; a remembered literal from the other platform falls back to
   * preview rather than addressing a buffer that does not exist here.
   */
  function bufferChips(target) {
    const letter = target ? target.bank : null;
    const literals = dialectOrDefault(store()).bufferKeys;
    if (view.mode !== 'PREVIEW' && view.mode !== 'PROGRAM' && !literals.includes(view.mode)) view.mode = 'PREVIEW';
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Buffer' }),
      chip('PRW', view.mode === 'PREVIEW', () => { view.mode = 'PREVIEW'; onRefresh(); }, 'lpp-chip--prw'),
      chip('PGM', view.mode === 'PROGRAM', () => { view.mode = 'PROGRAM'; onRefresh(); }, 'lpp-chip--pgm'),
      ...literals.map((l) => chip(l, view.mode === l, () => { view.mode = l; onRefresh(); })),
      letter
        ? h('span', {
          class: ['wru-tag', target.live ? 'wru-warn' : 'wru-tag--good'],
          title: target.live ? 'This buffer is on air' : 'This buffer is not on air'
        }, target.live ? `${letter} · on air` : letter)
        : null);
  }

  /* ---------------------------------------------------------------- body */

  function body() {
    if (!store().ready) {
      return h('div', { class: 'wru-empty', text: 'Waiting for the device store…' });
    }
    const target = resolved();
    if (!target) {
      return h('div', { class: 'wru-empty' },
        h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: 'No layer to show' }),
        h('div', {
          class: 'wru-empty-copy',
          text: 'This switcher has no destination with an allocated layer on it. A screen has to be set up in Preconfig, with at least one layer, before it has properties to edit.'
        }));
    }
    return h('div', {},
      liveBanner(target),
      noteLine(),
      summary(target),
      ...sections().map((section) => sectionBlock(section, target)),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-margin-top-large' },
        h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('input', {
            type: 'checkbox', checked: view.showReadOnly ? 'checked' : null,
            onChange: (ev) => { view.showReadOnly = ev.target.checked; onRefresh(); }
          }),
          h('span', { class: 'aw-font-body-2 aw-text-tertiary', text: 'Show what the device reports back' }))));
  }

  /*
   * The one thing worth interrupting the layout for. Editing the buffer that
   * is on air is a legitimate thing to do — it is how you fix a live layer —
   * but it must never be something that happened without anyone noticing.
   */
  function liveBanner(target) {
    if (!target.live) return null;
    return h('div', { class: 'lpp-live-banner aw-margin-bottom-medium' },
      `Buffer ${target.bank} is on air on ${target.id}. Every change here goes straight to the output.`);
  }

  function noteLine() {
    if (!view.note) return null;
    const cls = { ok: 'wru-console-ok', warn: 'wru-console-warn', err: 'wru-console-err' };
    return h('div', {
      class: ['wru-console-row', cls[view.note.tone] || '', 'aw-margin-bottom-medium']
    }, h('span', { text: view.note.text }));
  }

  /** What the layer is showing, in one line, before the fields start. */
  function summary(target) {
    const dialect = dialectFor(store());
    const source = readValue(store(), target, specById(dialect && dialect.sourceParam));
    const reported = readValue(store(), target, specById(dialect && dialect.reportedSourceParam));
    const bits = [`${target.id} · buffer ${target.bank} · layer ${target.layer === 'NATIVE' ? 'Native' : target.layer}`];
    if (source) bits.push(sourceLabel(source) || String(source));
    return h('div', { class: 'aw-font-body-2 aw-text-tertiary aw-margin-bottom-large' },
      bits.join('  —  '),
      /* The device disagreeing with itself is worth a word: during a load the
         requested source and the one actually up are briefly different. */
      reported && source && reported !== source
        ? h('span', { class: 'wru-warn', text: `  (showing ${sourceLabel(reported) || reported})` })
        : null);
  }

  const specById = (id) =>
    (id && sections().flatMap((s) => s.params).find((spec) => spec.id === id)) || null;

  function sectionBlock(section, target) {
    const open = view.open.has(section.id);
    const params = section.params.filter((p) => view.showReadOnly || !p.readOnly);
    if (!params.length) return null;
    return h('div', { class: 'lpp-section' },
      h('button', {
        class: 'lpp-section-head', type: 'button',
        onClick: () => {
          if (open) view.open.delete(section.id); else view.open.add(section.id);
          onRefresh();
        }
      },
        h('span', { class: 'lpp-section-caret', text: open ? '▾' : '▸' }),
        h('span', { class: 'aw-font-subtitle-1', text: section.label }),
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: String(params.length) })),
      open
        ? h('div', { class: 'lpp-inspector-grid aw-margin-bottom-large' },
          ...params.map((spec) => field(spec, target)))
        : null);
  }

  /* -------------------------------------------------------------- fields */

  function field(spec, target) {
    const value = readValue(store(), target, spec);
    return h('div', { class: 'lpp-field' },
      h('label', {
        class: 'aw-font-overline aw-text-tertiary',
        title: `${spec.id}${range(spec)}`
      }, paramLabel(spec.id)),
      control(spec, target, value));
  }

  const range = (spec) =>
    (Number.isFinite(spec.min) && Number.isFinite(spec.max)) ? `  (${spec.min} … ${spec.max})` : '';

  function control(spec, target, value) {
    if (spec.readOnly) {
      return h('div', { class: 'lpp-readonly', text: value == null ? '—' : format(value) });
    }
    switch (spec.type) {
      case 'bool': return boolControl(spec, value);
      case 'enum': return enumControl(spec, value);
      case 'map': return mapControl(spec, value);
      default: return numberControl(spec, value);
    }
  }

  const boolControl = (spec, value) => h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
    h('input', {
      type: 'checkbox', checked: value === true ? 'checked' : null,
      onChange: (ev) => write(spec, ev.target.checked)
    }),
    h('span', { class: 'aw-font-body-2', text: value === true ? 'On' : 'Off' }));

  function enumControl(spec, value) {
    const values = valuesFor(spec, store());
    return h('select', {
      class: 'wru-select', onChange: (ev) => write(spec, ev.target.value)
    }, ...values.map((v) => h('option', {
      value: v, selected: v === value ? 'selected' : null
    }, prettyEnum(v))));
  }

  /*
   * A flag set is written whole — the device takes the new array, not a diff —
   * so every box in the group contributes to every write. Ticking one and
   * sending only that would silently clear the others.
   */
  function mapControl(spec, value) {
    const current = Array.isArray(value) ? value : [];
    const values = valuesFor(spec, store());
    return h('div', { class: 'lpp-flags' }, ...values.map((flag) =>
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
        h('input', {
          type: 'checkbox', checked: current.includes(flag) ? 'checked' : null,
          onChange: (ev) => {
            const next = ev.target.checked
              ? [...current, flag]
              : current.filter((f) => f !== flag);
            write(spec, next);
          }
        }),
        h('span', { class: 'aw-font-body-2', text: prettyEnum(flag) }))));
  }

  /*
   * Committed on Enter or blur, never on every keystroke: these fields drive a
   * live switcher and sending on input would put every intermediate number a
   * two-digit edit passes through onto the output.
   */
  function numberControl(spec, value) {
    const editing = view.editing && view.editing.id === spec.id;
    const shown = editing ? view.editing.text : (value == null ? '' : String(value));
    return h('input', {
      class: 'wru-input wru-input--narrow', value: shown, inputmode: 'decimal',
      'data-lpp-focus': editing ? '1' : null,
      title: `${spec.id}${range(spec)}`,
      onFocus: () => { view.editing = { id: spec.id, text: shown }; },
      onInput: (ev) => { view.editing = { id: spec.id, text: ev.target.value }; },
      onKeyDown: (ev) => {
        if (isEnter(ev)) { ev.preventDefault(); ev.target.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); view.editing = null; onRefresh(); }
      },
      onBlur: (ev) => {
        const text = ev.target.value;
        view.editing = null;
        if (text.trim() === '' || String(value) === text.trim()) onRefresh();
        else write(spec, text);
      }
    });
  }

  /** `BLACK_N_WHITE` reads better as `Black n white` in a checkbox list. */
  const prettyEnum = (v) => String(v).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

  /* ---------------------------------------------------------------- frame */

  function render() {
    const root = panel({ toolbar: toolbar(), body: body() });
    if (view.editing) {
      const win = doc.defaultView || window;
      win.requestAnimationFrame(() => {
        const f = root.querySelector('[data-lpp-focus]');
        if (f && doc.activeElement !== f) {
          f.focus();
          f.setSelectionRange(f.value.length, f.value.length);
        }
      });
    }
    return root;
  }

  return { render, view, busy, popOut, sections };
}
