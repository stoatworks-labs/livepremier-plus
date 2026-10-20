/*
 * ATEM Micro Panel — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page: the switch, the program row's tick,
 * and what the panel is doing. It follows the server over
 * `/__lpp/atem-micro-panel/stream`. Nothing here drives the panel: the server
 * does, with or without this page open.
 */

import { normaliseAtemMicro } from './core.js';

const BUS = { LIVE: 'inputs', STILL: 'stills', SCREEN: 'screens' };

export default function activate(ctx) {
  const { h, readout, card, note } = ctx.kit;

  /* Normalised here as well: before the first save the page may hold nothing at all. */
  let settings = normaliseAtemMicro(ctx.settings.get());
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
      settings = normaliseAtemMicro(await ctx.settings.set(patch));
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  async function hotCut(on) {
    error = null;
    try {
      const res = await fetch(ctx.url('/hot-cut'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) error = body.error || `the app answered ${res.status}`;
      else live = body;
    } catch (err) {
      error = err.message;
    }
    ctx.refresh();
  }

  function panelLine(p) {
    if (!p) return { text: 'no device host', tone: 'tertiary' };
    if (p.connected && p.authed) {
      const battery = p.battery && Number.isFinite(p.battery.level) ? `, battery ${p.battery.level}%` : '';
      return { text: `connected${battery}`, tone: null };
    }
    if (p.connected) return { text: 'found, not answered yet', tone: 'warn' };
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
    const on = settings.atemMicroEnabled;
    const p = live && live.panel;
    const line = panelLine(p);
    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ atemMicroEnabled: ev.target.checked }),
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive an ATEM Micro Panel' }));
    const cuts = on
      ? h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
        h('input', {
          type: 'checkbox',
          checked: live && live.hotCut ? 'checked' : null,
          onChange: (ev) => hotCut(ev.target.checked),
        }),
        h('span', { class: 'aw-font-body-1', text: 'Program row cuts to air' }))
      : null;
    const readouts = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Panel', line.text, { tone: line.tone }),
        readout('Driving', (live.selection && live.selection.destinations.join(' ')) || 'nothing',
          { tone: live.selection && live.selection.destinations.length ? null : 'tertiary' }),
        readout('Buses', live.view ? (live.view.macro ? 'memories (MACRO)' : BUS[live.view.busKind] || '—') : '—'),
        readout('Tally', tallyLine(live.tally), { tone: live.tally ? null : 'tertiary' }))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', error));
    notes.push(note('warn',
      'Preview. This has never been run against a panel. It speaks the protocol Bitfocus Companion drives '
      + 'the panel with (node-blackmagic-controller) and the handshake proven here on a Speed Editor, and has '
      + 'only been tested against a pretend panel. Treat the first show with one as a rehearsal.'));
    if (on && p && !p.available && p.reason) notes.push(note('warn', p.reason));
    if (on && live && live.host && !live.host.running) {
      notes.push(note('warn', live.host.reason || 'The device host is not running, so nothing here can hold a USB panel.'));
    }
    if (on && p && p.error && !(p.connected && p.authed)) notes.push(note('warn', p.error));
    if (on && live && live.hotCut) {
      notes.push(note('warn',
        'The program row is live: a press puts that source on the selected layer of every selected screen '
        + 'IN PROGRAM, on air at once, with no take. Untick to go back to tally only. This is forgotten when '
        + 'the panel is switched off or the app restarts.'));
    }
    if (on) {
      notes.push(note('info',
        'Plug the panel into this machine by USB, or pair it over Bluetooth. M/E 1–4 pick the screen (hold one '
        + 'and press another for several), BKGD and KEY 1–4 its layers, and PREVIEW 1–10 put input 1–10 on the '
        + 'selected layer in preview — SHIFT for 11–20. KEY 1, 2 and 3 ON AIR switch the buses between inputs, '
        + 'stills and screens; MACRO turns the preview row into memories 1–10. CUT cuts, AUTO and the T-bar take. '
        + 'DSK 1 CUT freezes, DSK 1 AUTO copies program to preview, DSK 2 AUTO fades to black. '
        + 'docs/ATEM-MICRO-PANEL.md has the rest.'));
      notes.push(note('info',
        'Quit ATEM Software Control on this machine while this is on: it drives the same panel, and with both '
        + 'running every press would switch your ATEM as well. Tally is read every five seconds and after each '
        + 'press, so a take fired from the Web RCS relights the buses within that.'));
    }
    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.key, e.note || e.error || e.kind].filter(Boolean).join(' — '),
        })))
      : null;

    return card('ATEM Micro Panel',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' }, toggle, cuts),
      readouts, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'atem-micro-panel', order: 12, render });
}
