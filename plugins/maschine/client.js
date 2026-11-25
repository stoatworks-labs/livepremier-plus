/*
 * Maschine — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page: the switch, and what the panel is
 * doing. It follows the server over `/__lpp/maschine/stream`. Nothing here
 * drives the panel: the server does, with or without this page open.
 */

import { normaliseMaschine } from './core.js';

const PADS = { LIVE: 'inputs', STILL: 'stills', SCREEN: 'screens', MEMORY: 'memories' };

export default function activate(ctx) {
  const { h, readout, card, note } = ctx.kit;

  /* Normalised here as well: before the first save the page may hold nothing at all. */
  let settings = normaliseMaschine(ctx.settings.get());
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
      settings = normaliseMaschine(await ctx.settings.set(patch));
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  function panelLine(p) {
    if (!p) return { text: 'no device host', tone: 'tertiary' };
    if (p.connected) return { text: p.screens ? 'connected, screens on' : 'connected, no screens', tone: p.screens ? null : 'warn' };
    if (p.present) return { text: 'found, not held', tone: 'tertiary' };
    if (!p.available) return { text: 'not available', tone: 'tertiary' };
    return { text: 'not found', tone: 'tertiary' };
  }

  function tallyLine(t) {
    if (!t) return '—';
    const word = (s) => (s ? `${{ LIVE: 'IN', STILL: 'STILL', SCREEN: 'S' }[s.kind]} ${s.number}` : 'nothing');
    return `layer ${t.layer}: ${word(t.program)} on air, ${word(t.preview)} in preview`;
  }

  function render() {
    if (!asked) { asked = true; void load(); }
    listen();
    const on = settings.maschineEnabled;
    const p = live && live.panel;
    const line = panelLine(p);
    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ maschineEnabled: ev.target.checked }),
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive a Maschine MK3' }));
    const readouts = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Panel', line.text, { tone: line.tone }),
        readout('Driving', (live.selection && live.selection.destinations.join(' ')) || 'nothing',
          { tone: live.selection && live.selection.destinations.length ? null : 'tertiary' }),
        readout('Pads', live.view ? PADS[live.view.padKind] || '—' : '—'),
        readout('Tally', tallyLine(live.tally), { tone: live.tally ? null : 'tertiary' }))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', error));
    notes.push(note('warn',
      'Preview. This has never been run against a Maschine. Its bytes follow OpenAV Ctlra’s MK3 driver, and it '
      + 'has been tested only against a pretend panel. Treat the first show with one as a rehearsal.'));
    if (on && p && !p.available && p.reason) notes.push(note('warn', p.reason));
    if (on && live && live.host && !live.host.running) {
      notes.push(note('warn', live.host.reason || 'The device host is not running, so nothing here can hold a USB panel.'));
    }
    if (on && p && p.error && !p.connected) notes.push(note('warn', p.error));
    if (on && p && p.connected && !p.screens && p.screenError) notes.push(note('warn', `No screens: ${p.screenError}.`));
    if (on) {
      notes.push(note('info',
        'GROUP A–H pick the screen (hold one and press another for several). The pads put input 1–16 on the '
        + 'selected layer in preview; the soft keys above the left screen switch them to stills, screens or '
        + 'memories, and SHIFT gives 17–32. PLAY takes, RESTART cuts, and the touch strip is a T-bar: touch it '
        + 'at the lit dot and slide. The encoder walks the layers; knobs 1–5 set the layer’s opacity, position '
        + 'and size in preview. Soft keys 5–7 are MATCH, FREEZE and FADE TO BLACK. docs/MASCHINE.md has the rest.'));
      notes.push(note('info',
        'Quit NIHostIntegrationAgent while this is on: it holds the panel for Maschine 2 and Komplete Kontrol, '
        + 'hears every press too, and keeps the screens from this app. It comes back at the next login.'));
    }
    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.key, e.note || e.error || e.kind].filter(Boolean).join(' — '),
        })))
      : null;

    return card('Maschine MK3',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' }, toggle),
      readouts, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'maschine', order: 14, render });
}
