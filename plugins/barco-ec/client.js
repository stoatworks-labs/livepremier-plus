/*
 * Barco EC panel — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page: the switch, the model, what each
 * Assign row holds, and what the panel is doing. It follows the server over
 * `/__lpp/barco-ec/stream`. Nothing here drives the panel: the server does,
 * with or without this page open.
 */

import { CONSOLE_MODELS, ROW_KINDS, normaliseBarcoEc } from './core.js';

const ROW_NAMES = ['Top row (EC-40 and EC-50)', 'Middle row', 'Bottom row'];

export default function activate(ctx) {
  const { h, readout, card, note, picker } = ctx.kit;

  /* Normalised here as well: before the first save the page may hold nothing at all. */
  let settings = normaliseBarcoEc(ctx.settings.get());
  let live = null;
  let saving = false;
  let error = null;
  let stream = null;
  let asked = false;

  async function load() {
    try {
      const res = await fetch(ctx.url('/state'), { cache: 'no-store' });
      if (res.ok) live = await res.json();
    } catch { /* the card draws from the settings alone */ }
    ctx.refresh();
  }

  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('panel', (ev) => {
        try { live = JSON.parse(ev.data); ctx.refresh(); } catch { /* one bad frame is not worth the card */ }
      });
    } catch { /* no EventSource: the card still works, just not live */ }
  }

  async function put(patch) {
    saving = true;
    error = null;
    ctx.refresh();
    try {
      settings = normaliseBarcoEc(await ctx.settings.set(patch));
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  function panelLine(p) {
    if (!p) return { text: 'no device host', tone: 'tertiary' };
    if (p.connected) return { text: `connected${p.serial ? ` (${p.serial})` : ''} over ${p.backend}`, tone: null };
    if (p.busy) return { text: 'in use by another program', tone: 'warn' };
    if (p.present) return { text: 'found, not held', tone: 'tertiary' };
    if (!p.available) return { text: 'not available', tone: 'tertiary' };
    return { text: 'not found', tone: 'tertiary' };
  }

  function render() {
    if (!asked) { asked = true; void load(); }
    listen();
    const on = settings.barcoEcEnabled;
    const p = live && live.panel;
    const line = panelLine(p);
    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ barcoEcEnabled: ev.target.checked }),
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive a Barco EC panel' }));
    const rowPickers = h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
      settings.barcoEcRows.map((kind, r) => (settings.barcoEcModel === 'ec-30' && r === 0 ? null
        : picker(ROW_NAMES[r], ROW_KINDS, kind, (v) => {
          const rows = [...settings.barcoEcRows];
          rows[r] = v;
          void put({ barcoEcRows: rows });
        }, { disabled: saving }))));
    const readouts = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Panel', line.text, { tone: line.tone }),
        readout('Selected', (live.selection && live.selection.destinations.join(' ')) || 'nothing on the panel',
          { tone: live.selection && live.selection.destinations.length ? null : 'tertiary' }),
        readout('Layer', live.selection ? String(live.selection.layer) : '—'),
        readout('Keys read', p ? String(p.keys ?? 0) : '0'))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', `Could not save: ${error}`));
    notes.push(note('warn',
      'Preview. This has never been run against a panel. It speaks the protocol qubered/ec50-panel '
      + 'worked out from Barco’s own software and proved on an EC-50, and has only been tested against a '
      + 'pretend panel here. Treat the first show with one as a rehearsal.'));
    if (on && p && !p.available && p.reason) notes.push(note('warn', p.reason));
    if (on && live && live.host && !live.host.running) {
      notes.push(note('warn', live.host.reason || 'The device host is not running, so nothing here can hold a USB panel.'));
    }
    if (on && p && p.busy) {
      notes.push(note('warn',
        'Another program has the panel open — almost certainly the Event Master Toolset. The panel takes '
        + 'one program at a time: close the Toolset and this takes it within a couple of seconds.'));
    } else if (on && p && p.error && !p.connected) {
      notes.push(note('warn', p.error));
    }
    if (on) {
      notes.push(note('info',
        'Plug the panel’s USB into this machine. Destination keys select screens, layer keys the active '
        + 'screen’s layers, and the Assign rows put a source on the selected layer in preview or recall a '
        + 'memory to preview. ALL TRANS takes, CUT cuts, MATCH copies program to preview, and the T-bar '
        + 'takes by hand. A row’s label key changes what it holds. docs/BARCO-EC.md has the rest.'));
      notes.push(note('info',
        'While this holds the panel the Event Master Toolset cannot, and the other way round. Turning this '
        + 'off hands it back, dark. Lamps follow the switcher when the panel connects, after each press and '
        + 'every fifteen seconds — a take fired from the Web RCS does not relight them until then.'));
    }
    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.key, e.note || e.error || e.kind].filter(Boolean).join(' — '),
        })))
      : null;

    return card('Barco EC panel',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle,
        picker('Panel', CONSOLE_MODELS, settings.barcoEcModel, (v) => put({ barcoEcModel: v }), { disabled: saving })),
      rowPickers, readouts, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'barco-ec', order: 11, render });
}
