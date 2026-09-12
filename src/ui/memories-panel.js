/*
 * The memory banks, as a panel you can put on a second monitor.
 *
 * The vendor has a Memories tab already and this does not try to replace it —
 * it exists because that tab cannot be popped out. It is a React pane whose
 * event listeners are delegated to the app's root container, so a copy of it
 * moved into a second window keeps repainting and stops responding. Reading
 * the bank ourselves is the only way to get it onto another screen. All of the
 * reading and every command lives in `core/memories.js`, with no DOM in it;
 * this file is only the drawing.
 *
 * ## Three deliberate differences from the vendor's tab
 *
 * **All the banks in one place.** Master, Screen and Layer on a LivePremier —
 * Master, Screen and Aux on a Midra 4K — are separate trees on the device and
 * separate sub-tabs in Web RCS. On a second monitor they are one list you
 * switch between, because the question an operator has mid-show is "where is
 * that memory" and not "which bank did I file it in". Which set this switcher
 * has comes from `core/dialect.js`; nothing here names a bank.
 *
 * **The destination is explicit.** The vendor's tab follows the screen you
 * have selected. That selection is React state we cannot read, so this asks
 * outright — which also means the window stays pointed where you left it
 * rather than moving under you when someone clicks a screen in the main tab.
 *
 * **Recall names its buffer every time.** There is no default. A recall that
 * lands on PROGRAM by accident is the worst thing this tool could do, so the
 * target is a visible, sticky choice and PROGRAM is coloured like the risk it
 * is. `core/memories.js` refuses a recall with no buffer rather than assuming
 * one — see the note there about why that is a required argument and not a
 * safe default.
 */

import { h, button, isEnter } from './dom.js';
import { panel } from './shell.js';
import { listDestinations } from '../core/screens.js';
import {
  banksFor, bankFor, targetsFor, listSlots, slotCount, assignments, recallCmd, saveCmd,
  labelCmd, deleteCmd, saveFilters
} from '../core/memories.js';
import { fittedLayers } from '../core/properties.js';
import { dialectFor } from '../core/dialect.js';

/** How long a destructive button stays armed before it goes back to safe. */
const ARM_MS = 4000;

/**
 * @param {{session: object, onRefresh: Function, popoutEnabled?: boolean,
 *          doc?: Document}} opts
 */
export function createMemoriesPanel({
  session, onRefresh = () => {}, popoutEnabled = true, doc = document
} = {}) {
  const view = {
    kind: 'screen',
    dest: null,
    layer: null,
    mode: 'PREVIEW',
    filter: '',
    showEmpty: false,
    /* {slot, text} while a label is being typed. Device frames must not
       repaint over it — see `busy()`. */
    editing: null,
    /* {slot, action, until} — a destructive button that has been armed once. */
    armed: null,
    note: null
  };

  /**
   * True while the operator is mid-edit and a repaint would destroy their work.
   *
   * The panel is rebuilt wholesale on every device frame, which is fine for a
   * table of numbers and fatal for a text field. The Console solves the same
   * problem by never repainting on device traffic; a bank list has to repaint,
   * so it says when it must not instead.
   */
  const busy = () => view.editing != null;

  const store = () => session.store;
  const banks = () => banksFor(store());
  /*
   * The chosen bank, or the platform's first when the choice does not exist
   * here — a remembered `layer` on a switcher that has no layer bank, which
   * happens the moment the store arrives and the platform turns out not to be
   * the one the default assumed.
   */
  const bank = () => bankFor(view.kind, store()) || banks()[0];

  /**
   * Destinations this bank can address, and a remembered choice that is
   * still valid. A Midra's screen bank serves screens only and its aux bank
   * auxes only; a LivePremier's screen bank serves both. The bank says.
   */
  function destinations() {
    return store().ready ? targetsFor(bank(), listDestinations(store())) : [];
  }

  function currentDest() {
    const all = destinations();
    if (!all.length) return null;
    const found = all.find((d) => d.id === view.dest);
    return found || all[0];
  }

  function currentLayer() {
    const dest = currentDest();
    if (!dest) return null;
    const layers = fittedLayers(store(), dest.id);
    if (!layers.length) return null;
    const found = layers.find((l) => l.key === view.layer);
    return (found || layers[0]).key;
  }

  /* ----------------------------------------------------------- commands */

  function note(tone, text) {
    view.note = { tone, text };
    onRefresh();
  }

  /** The target a command applies to, or a reason it cannot be built. */
  function target() {
    const scope = bank().scope;
    if (scope === 'device') return { mode: view.mode };
    const dest = currentDest();
    if (!dest) return null;
    if (scope === 'destination') return { mode: view.mode, id: dest.id };
    const layer = currentLayer();
    if (!layer) return null;
    return { mode: view.mode, id: dest.id, layer };
  }

  /* Every command is spelled for the platform the store says this is, and is
     refused while the store has not said. */
  const dialect = () => dialectFor(store());

  function fire(cmd, description) {
    if (!cmd) { note('err', 'nothing to send — pick a destination first'); return; }
    const ok = session.send(cmd);
    note(ok ? 'ok' : 'err', ok ? description : `${description} — not sent, the socket is not open`);
  }

  const recall = (slot) => {
    const t = target();
    fire(t && recallCmd(bank().kind, slot, t, dialect()),
      `recalled ${bank().kind} memory ${slot} to ${view.mode.toLowerCase()}${t && t.id ? ' on ' + t.id : ''}`);
  };

  const save = (slot) => {
    const t = target();
    fire(t && saveCmd(bank().kind, slot, t, dialect()),
      `saved ${view.mode.toLowerCase()}${t && t.id ? ' of ' + t.id : ''} into ${bank().kind} memory ${slot}`);
  };

  const erase = (slot) => {
    fire(deleteCmd(bank().kind, slot, dialect()), `erased ${bank().kind} memory ${slot}`);
  };

  /**
   * Arm a destructive button, or fire it if it is already armed.
   *
   * A confirm dialog would be the obvious thing and is the wrong one: it steals
   * focus from a window that may be on a second monitor behind a fader wing,
   * and it is modal over a UI that is driving a live show. Arming in place
   * costs one extra click and nothing else.
   */
  function arm(slot, action, run) {
    const live = view.armed && view.armed.slot === slot &&
      view.armed.action === action && view.armed.until > Date.now();
    if (live) { view.armed = null; run(); return; }
    view.armed = { slot, action, until: Date.now() + ARM_MS };
    onRefresh();
  }

  const isArmed = (slot, action) =>
    !!(view.armed && view.armed.slot === slot && view.armed.action === action &&
      view.armed.until > Date.now());

  /* -------------------------------------------------------------- popout */

  /*
   * Reused rather than re-opened, exactly as the console's and the timeline's
   * are: two of these would each repaint on every device frame for one
   * operator.
   */
  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open('/__lpp/memories', 'lpp-memories',
      'width=1100,height=820,menubar=no,toolbar=no,location=no');
    if (!child) note('warn', 'the browser blocked the window — allow pop-ups for this address');
  }

  /* -------------------------------------------------------------- toolbar */

  function chip(label, on, onClick, extra = '') {
    return h('button', {
      class: ['lpp-chip', on ? 'lpp-chip--on' : '', extra], type: 'button', onClick
    }, label);
  }

  function toolbar() {
    const scope = bank().scope;
    const dest = currentDest();
    return [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large lpp-controls aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Memories' }),
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          ...banks().map((b) => chip(b.label, bank().kind === b.kind, () => {
            view.kind = b.kind;
            view.armed = null;
            onRefresh();
          }))),
        scope !== 'device' ? destPicker(dest) : null,
        scope === 'layer' ? layerPicker(dest) : null),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small lpp-controls aw-flex-wrap' },
        h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'To' }),
          chip('PRW', view.mode === 'PREVIEW', () => { view.mode = 'PREVIEW'; onRefresh(); }, 'lpp-chip--prw'),
          chip('PGM', view.mode === 'PROGRAM', () => { view.mode = 'PROGRAM'; onRefresh(); }, 'lpp-chip--pgm')),
        h('input', {
          class: 'wru-input', type: 'search', placeholder: 'Find a memory',
          value: view.filter, style: { flex: '0 1 12rem' },
          onInput: (ev) => { view.filter = ev.target.value; onRefresh(); }
        }),
        popoutEnabled
          ? button('Pop out', {
            iconId: 'set-layer-to-fullscreen-18',
            title: 'Open the memory banks in their own window',
            onClick: popOut
          })
          : null)
    ];
  }

  function destPicker(dest) {
    const all = destinations();
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'On' }),
      h('select', {
        class: 'wru-select',
        onChange: (ev) => { view.dest = ev.target.value; view.layer = null; onRefresh(); }
      }, ...all.map((d) => h('option', {
        value: d.id, selected: dest && d.id === dest.id ? 'selected' : null
      }, d.label ? `${d.id} — ${d.label}` : d.id))));
  }

  function layerPicker(dest) {
    const layers = dest ? fittedLayers(store(), dest.id) : [];
    const current = currentLayer();
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Layer' }),
      h('select', {
        class: 'wru-select',
        onChange: (ev) => { view.layer = ev.target.value; onRefresh(); }
      }, ...layers.map((l) => h('option', {
        value: l.key, selected: l.key === current ? 'selected' : null
      }, l.key === 'NATIVE' ? 'Native' : `L${l.key}`))));
  }

  /* ----------------------------------------------------------------- body */

  function body() {
    if (!store().ready) {
      return h('div', { class: 'wru-empty', text: 'Waiting for the device store…' });
    }
    return h('div', {}, saveLine(), noteLine(), table());
  }

  /**
   * What a save would actually write.
   *
   * The device keeps a set of category and layer filters that decide how much
   * of a screen a save captures, and the vendor's UI is where they are set.
   * Widening them from here would make Save do more than the operator's last
   * visible choice said it would, so they are read and shown, never written.
   */
  function saveLine() {
    const dest = currentDest();
    const filters = saveFilters(store(), bank().kind, { id: dest && dest.id });
    if (!filters) return null;
    const bits = [];
    if (filters.mode) bits.push(filters.mode.replace(/_/g, ' ').toLowerCase());
    if (filters.categories.length) bits.push(`${filters.categories.length} categories`);
    if (filters.layers.length) bits.push(`${filters.layers.length} layers`);
    if (!bits.length) return null;
    return h('div', { class: 'aw-font-body-2 aw-text-tertiary aw-margin-bottom-medium' },
      `A save writes ${bits.join(', ')} — set in the vendor’s own Memories tab.`);
  }

  function noteLine() {
    if (!view.note) return null;
    const cls = { ok: 'wru-console-ok', warn: 'wru-console-warn', err: 'wru-console-err' };
    return h('div', {
      class: ['wru-console-row', cls[view.note.tone] || '', 'aw-margin-bottom-medium']
    }, h('span', { text: view.note.text }));
  }

  /** Slot → the preset buffers currently holding it, for a per-destination bank. */
  function heldBy() {
    const dest = currentDest();
    if (bank().scope !== 'destination' || !dest) return new Map();
    const out = new Map();
    for (const [letter, entry] of Object.entries(assignments(store(), dest.id))) {
      if (entry.slot == null) continue;
      if (!out.has(entry.slot)) out.set(entry.slot, []);
      out.get(entry.slot).push({ letter, unmodified: entry.unmodified });
    }
    return out;
  }

  function rows() {
    const all = listSlots(store(), bank().kind, { onlyValid: !view.showEmpty });
    const needle = view.filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((s) =>
      String(s.slot) === needle || s.label.toLowerCase().includes(needle));
  }

  function table() {
    const list = rows();
    const held = heldBy();
    if (!list.length) {
      return h('div', { class: 'wru-empty' },
        h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: 'Nothing here yet' }),
        h('div', {
          class: 'wru-empty-copy',
          text: view.filter
            ? 'No memory in this bank matches that.'
            : `This device has no ${bank().label.toLowerCase()} memories saved. Save one below, or turn on empty slots to pick where it goes.`
        }),
        h('div', { class: 'wru-empty-actions' }, emptyToggle()));
    }
    return h('div', {},
      h('div', { class: 'aw-flex-row-center-v-space-between aw-margin-bottom-small' },
        h('span', {
          class: 'aw-font-overline aw-text-tertiary',
          text: `${list.length} shown of ${slotCount(store(), bank().kind)} ${bank().label.toLowerCase()} slots`
        }),
        emptyToggle()),
      h('table', { class: 'wru-table' },
        h('thead', {}, h('tr', {},
          h('th', { text: 'Slot' }),
          h('th', { text: 'Name' }),
          h('th', { text: 'On air' }),
          h('th', { text: '' }))),
        h('tbody', {}, ...list.map((slot) => row(slot, held.get(slot.slot))))));
  }

  const emptyToggle = () => h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
    h('input', {
      type: 'checkbox', checked: view.showEmpty ? 'checked' : null,
      onChange: (ev) => { view.showEmpty = ev.target.checked; onRefresh(); }
    }),
    h('span', { class: 'aw-font-body-2 aw-text-tertiary', text: 'Show empty slots' }));

  function row(slot, holders) {
    const editing = view.editing && view.editing.slot === slot.slot;
    return h('tr', { class: ['wru-cue', slot.isValid ? '' : 'wru-cue--disabled'] },
      h('td', { class: 'wru-cue-number', text: String(slot.slot) }),
      h('td', {}, editing ? labelInput(slot) : labelCell(slot)),
      h('td', {}, ...(holders || []).map((held) => h('span', {
        class: ['wru-tag', held.unmodified ? 'wru-tag--good' : 'wru-warn'],
        title: held.unmodified
          ? `Buffer ${held.letter} still matches this memory`
          : `Buffer ${held.letter} started from this memory and has been changed since`
      }, held.unmodified ? held.letter : `${held.letter}*`))),
      h('td', { class: 'wru-cue-actions' }, actions(slot)));
  }

  /*
   * A name is not a button label, so it does not get the button's uppercase.
   * `Keynote 1_S1` typed by an operator has to come back as `Keynote 1_S1` —
   * these names are how they find a memory under pressure, and shouting them
   * loses the capitalisation they chose to tell two apart.
   */
  function labelCell(slot) {
    return h('button', {
      class: ['lpp-name', slot.label ? '' : 'aw-text-tertiary'],
      type: 'button',
      title: 'Rename this memory',
      onClick: () => { view.editing = { slot: slot.slot, text: slot.label }; onRefresh(); }
    }, slot.label || (slot.isValid ? '(unnamed)' : '(empty)'));
  }

  function labelInput(slot) {
    const commit = (send) => {
      const text = view.editing ? view.editing.text : slot.label;
      view.editing = null;
      if (send && text !== slot.label) {
        fire(labelCmd(bank().kind, slot.slot, text, dialect()), `renamed memory ${slot.slot}`);
      } else onRefresh();
    };
    return h('input', {
      class: 'wru-input', value: view.editing.text, 'data-lpp-focus': '1',
      onInput: (ev) => { view.editing.text = ev.target.value; },
      onKeyDown: (ev) => {
        if (isEnter(ev)) { ev.preventDefault(); commit(true); }
        else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
      },
      onBlur: () => commit(true)
    });
  }

  function actions(slot) {
    const armedSave = isArmed(slot.slot, 'save');
    const armedDel = isArmed(slot.slot, 'delete');
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-mini aw-flex-wrap' },
      button('Recall', {
        onClick: () => recall(slot.slot),
        disabled: !slot.isValid,
        variant: view.mode === 'PROGRAM' ? 'danger' : 'default',
        title: slot.isValid
          ? `Load memory ${slot.slot} into ${view.mode.toLowerCase()}`
          : 'This slot is empty'
      }),
      button(armedSave ? 'Overwrite?' : 'Save', {
        onClick: () => (slot.isValid
          ? arm(slot.slot, 'save', () => save(slot.slot))
          : save(slot.slot)),
        variant: armedSave ? 'go' : 'ghost',
        title: slot.isValid
          ? `Overwrite memory ${slot.slot} with the current ${view.mode.toLowerCase()}`
          : `Save the current ${view.mode.toLowerCase()} into empty slot ${slot.slot}`
      }),
      slot.isValid
        ? button(armedDel ? 'Erase?' : 'Erase', {
          onClick: () => arm(slot.slot, 'delete', () => erase(slot.slot)),
          variant: armedDel ? 'go' : 'ghost'
        })
        : null);
  }

  /* ---------------------------------------------------------------- frame */

  function render() {
    const root = panel({ toolbar: toolbar(), body: body() });
    /*
     * The panel is rebuilt wholesale, so a field being typed into has to be
     * given its focus and caret back after it lands in the document. One frame
     * later is the first moment it is there to focus.
     */
    if (view.editing) {
      const win = doc.defaultView || window;
      win.requestAnimationFrame(() => {
        const field = root.querySelector('[data-lpp-focus]');
        if (field && doc.activeElement !== field) {
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        }
      });
    }
    return root;
  }

  return { render, view, busy, popOut };
}
