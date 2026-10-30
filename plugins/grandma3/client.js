/*
 * grandMA3 — the plugin's page half.  ** PREVIEW **
 *
 * One card on the settings page: the switch, the lines, what the desk has been
 * heard sending, and what went to the switcher. It follows the server over
 * `/__lpp/grandma3/stream`. Nothing here drives anything: the server does,
 * with or without this page open.
 *
 * The lines are a text box, and the card redraws on every message a desk
 * sends — a fader sends dozens a second. A redraw while somebody types would
 * take their caret away, so the box and its Save button are elements kept
 * across redraws, redraws wait while the box has focus, and the rest come at
 * most four a second. "Add a line" acts on mousedown: a redraw between press
 * and release would otherwise replace the button under the pointer and lose
 * the click.
 */

import { normaliseGrandma3, lineFor } from './core.js';

export default function activate(ctx) {
  const { h, button, readout, card, note } = ctx.kit;

  let settings = normaliseGrandma3(ctx.settings.get());
  let live = null;
  let osc = null;
  let saving = false;
  let error = null;
  let stream = null;
  let asked = false;
  let deferred = false;
  let draft = settings.grandma3Map;

  const box = h('textarea', {
    class: 'wru-input',
    rows: '8',
    spellcheck: 'false',
    style: { fontFamily: 'ui-monospace, Menlo, monospace', width: '100%' },
    onInput: (ev) => { draft = ev.target.value; deferred = true; },
  });
  box.value = draft;
  box.addEventListener('blur', () => { if (deferred) { deferred = false; ctx.refresh(); } });

  const save = button('Save lines', { onClick: () => put({ grandma3Map: box.value }) });

  let timer = null;
  const redraw = () => {
    if (box.ownerDocument && box.ownerDocument.activeElement === box) { deferred = true; return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; ctx.refresh(); }, 250);
  };

  async function load() {
    try {
      const res = await fetch(ctx.url('/state'), { cache: 'no-store' });
      if (res.ok) live = await res.json();
    } catch { /* the card draws from the settings alone */ }
    try {
      /* OSC input's own state: this plugin hears nothing while it is off. */
      const res = await fetch('/__lpp/osc/state', { cache: 'no-store' });
      osc = res.ok ? await res.json() : null;
    } catch { osc = null; }
    redraw();
  }

  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('ma3', (ev) => {
        try { live = JSON.parse(ev.data); redraw(); } catch { /* one bad frame is not worth the card */ }
      });
    } catch { /* no EventSource: the card still works, just not live */ }
  }

  async function put(patch) {
    saving = true;
    error = null;
    ctx.refresh();
    try {
      settings = normaliseGrandma3(await ctx.settings.set(patch));
      if ('grandma3Map' in patch) draft = settings.grandma3Map;
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  function addLine(heard) {
    const text = box.value.replace(/\s*$/, '');
    draft = (text ? `${text}\n` : '') + lineFor(heard);
    box.value = draft;
    box.focus();
    /* Caret after the arrow, where the target goes. */
    const at = draft.lastIndexOf('-> ') + 3;
    box.setSelectionRange(at, at);
  }

  function oscLine() {
    if (!osc) return { text: 'OSC input is off — this hears nothing until it is on', tone: 'warn' };
    if (!osc.listening) return { text: osc.lastError ? `OSC input is not listening: ${osc.lastError}` : 'OSC input is not listening', tone: 'warn' };
    return { text: `${osc.address}:${osc.port}`, tone: null };
  }

  function heardRow(e) {
    const value = e.kind === 'key' ? (e.value ? 'pressed' : 'released') : `${Math.round(e.value * 10) / 10}`;
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
      h('span', { class: 'aw-font-caption', style: { fontFamily: 'ui-monospace, Menlo, monospace' }, text: `${e.object} ${e.fn}` }),
      h('span', { class: 'aw-font-caption aw-text-tertiary', text: [e.via, value, e.cue && `“${e.cue}”`].filter(Boolean).join(' · ') }),
      e.mapped
        ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'mapped' })
        : addButton(e));
  }

  function addButton(e) {
    const b = button('Add a line', { variant: 'ghost' });
    b.addEventListener('mousedown', (ev) => { ev.preventDefault(); addLine(e); });
    return b;
  }

  function render() {
    if (!asked) { asked = true; void load(); }
    listen();
    const on = settings.grandma3Drive;
    const line = oscLine();
    save.disabled = saving;
    save.querySelector('span').textContent = saving ? 'Saving…' : 'Save lines';
    if (box.ownerDocument && box.ownerDocument.activeElement !== box && draft === settings.grandma3Map) {
      box.value = settings.grandma3Map;
    }
    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ grandma3Drive: ev.target.checked }),
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive the switcher from grandMA3' }));
    const readouts = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Listening on', line.text, { tone: line.tone }),
      readout('Lines', live ? String(live.rules.length) : '—'),
      readout('Heard', live ? String(live.heard.length) : '—'));
    const errors = live && live.errors.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.errors.map((e) => h('div', { class: 'aw-font-caption wru-warn', text: `Line ${e.line}: ${e.message}` })))
      : null;
    const lines = h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Lines — address, function -> target' }),
      box,
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        save,
        draft !== settings.grandma3Map ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'not saved' }) : null),
      errors);
    const heard = live && live.heard.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Heard from the desk, newest first' }),
        live.heard.slice(0, 12).map(heardRow))
      : null;
    const history = live && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Sent' }),
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.rule, e.note || e.error].filter(Boolean).join(' — '),
        })))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', `Could not save: ${error}`));
    notes.push(note('warn',
      'Preview. Built from grandMA3 onPC 2.4.2.2’s own messages, recorded on a Mac with no wing, and tested '
      + 'against the simulator. A physical fader on a command or fader wing has not been seen yet. Treat the '
      + 'first show with it as a rehearsal.'));
    notes.push(note('info',
      'On the desk: Menu ▸ In & Out ▸ OSC, Enable Output, and a line with Destination IP this machine, Port the '
      + 'OSC input’s, Prefix ma3, Send Yes. Set Preferred IP to the network this machine is on — on a Mac with '
      + 'Parallels the default picks the virtual-machine bridge and nothing arrives. Move a fader or press a key '
      + 'and it appears under Heard; Add a line, then write the target after the arrow.'));
    notes.push(note('info',
      'A target is one of this app’s OSC addresses (docs/OSC.md), with at most one value after it, or tbar and '
      + 'its screens. A key sends it when pressed. A fader sends its position to an address ending /norm, throws '
      + 'the T-bar for tbar, and on anything else fires once on the way up past halfway, then again only after '
      + 'it has been back to the bottom. Recalls go to preview, as everywhere in this app; over OSC a layer is '
      + 'addressed by its preset letter (/a, /b, /c), not preview or program.'));

    return card('grandMA3',
      toggle, readouts, lines, heard, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'grandma3', order: 13, render });
}
