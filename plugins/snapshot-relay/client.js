/*
 * Thumbnail relay — the plugin's page half.  ** PREVIEW **
 *
 * One card on the settings page: the three settings, and what the relay has
 * done since it started — the bytes it took from the switcher against the
 * bytes it served, and how often each source's picture actually changed.
 * That last column is the reason to switch this on at a rehearsal: it is how
 * fast the firmware really refreshes a thumbnail, which decides whether
 * polling faster than the vendor's once a second is worth building.
 *
 * The numbers follow `/__lpp/snapshot-relay/stream` and are written into the
 * card in place, so the page is not repainted once a second to show them.
 * The stream is closed whenever the card is not on screen.
 */

import { LIMITS } from './core.js';

const mbit = (bytes, seconds) => `${((bytes * 8) / 1e6 / seconds).toFixed(1)} Mbit/s`;
const kb = (bytes) => (bytes >= 10240 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024).toFixed(1)} KB`);

export default function activate(ctx) {
  const { h, readout, card, note } = ctx.kit;

  let settings = ctx.settings.get();
  let saving = false;
  let error = null;
  let stats = null;
  let stream = null;
  /* The live half of the card, rebuilt from `stats` without touching the rest. */
  const live = h('div', { class: 'aw-flex-col aw-gap-row-small' });

  async function put(patch) {
    saving = true; error = null; ctx.refresh();
    try { settings = await ctx.settings.set(patch); }
    catch (err) { error = err.message; }
    saving = false; ctx.refresh();
  }

  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('stats', (ev) => {
        if (!live.isConnected) { stream.close(); stream = null; return; }
        try { stats = JSON.parse(ev.data); } catch { return; }
        paint();
      });
    } catch { /* no EventSource: the card shows its settings and no numbers */ }
  }

  function paint() {
    live.replaceChildren();
    if (!stats || !stats.requests) {
      live.append(h('div', { class: 'aw-font-caption aw-text-tertiary',
        text: 'Nothing relayed yet. Open Screens / Aux. — its source cards are what ask.' }));
      return;
    }
    const s = stats;
    const saved = s.bytesIn ? 1 - s.bytesOut / s.bytesIn : 0;
    live.append(h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('From the switcher', `${mbit(s.bytesIn, s.seconds)} · ${s.fetches} fetches`),
      readout('To the pages', `${mbit(s.bytesOut, s.seconds)} · ${s.requests} requests`),
      readout('Saved', `${Math.round(saved * 100)} %`, { tone: saved > 0.5 ? null : 'tertiary' }),
      readout('Shared', String(s.shared)),
      readout('Unchanged', String(s.unchanged)),
      readout('Encode', s.encoded ? `${(s.encodeMs / s.encoded).toFixed(1)} ms` : '—'),
      readout('Passed through', String(s.passthrough), { tone: s.passthrough ? 'warn' : null }),
      readout('Errors', String(s.errors), { tone: s.errors ? 'warn' : null })));
    if (s.sources.length) {
      const cell = (text, cls = '') => h('td', { class: cls, text, style: { padding: '2px 12px 2px 0' } });
      live.append(h('table', { class: 'aw-font-caption' },
        h('thead', {}, h('tr', { class: 'aw-text-tertiary' },
          ['Source', 'Frames', 'Changes every', 'Switcher sent', 'Served'].map((t) => cell(t)))),
        h('tbody', {}, s.sources.map((src) => h('tr', {},
          cell(src.path),
          cell(String(src.frames)),
          cell(src.changeMs == null ? '—' : `${(src.changeMs / 1000).toFixed(2)} s`),
          cell(kb(src.bytesIn)),
          cell(`${kb(src.bytesOut)} ${src.type === 'image/jpeg' ? 'JPEG' : 'PNG'}`,
            src.type === 'image/jpeg' ? '' : 'aw-text-tertiary'))))));
      /* Measured on a simulator with a 2 Hz stand-in: 32 inputs read 1.28 s,
         because the vendor asks for one input every 40 ms at the fastest. */
      live.append(h('div', { class: 'aw-font-caption aw-text-tertiary',
        text: 'Rates are averages since the app started. “Changes every” cannot be shorter than the '
          + 'pages ask — the Web RCS asks for each input once a second, or every 40 ms × the number '
          + 'of inputs past 25 — so a source that reads exactly that may be changing faster.' }));
    }
  }

  function render() {
    listen();
    paint();

    const number = (label, key, [min, max], hint) => h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: 'number', min: String(key === 'maxWidth' ? 0 : min), max: String(max),
        value: String(settings[key]), title: hint,
        style: { maxWidth: '6rem' },
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ [key]: Number(ev.target.value) })
      }));

    const notes = [
      note('warn',
        'Preview. Built and tested against simulators and synthetic frames only — switch it off '
        + 'if a thumbnail looks wrong. Off, every thumbnail comes from the switcher as before.'),
      note('info',
        'The switcher still sends each PNG in full; what shrinks is everything after this app. '
        + 'The difference is largest for pages on another machine — a tablet on the show Wi-Fi.')
    ];
    if (error) notes.unshift(note('warn', `Could not save: ${error}`));

    return card('Thumbnail relay',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        number('JPEG quality', 'quality', LIMITS.quality, '30–95. 70 is hard to tell from the PNG on a card.'),
        number('Max width (0 = as sent)', 'maxWidth', LIMITS.maxWidth, '0, or 128–1024 px.'),
        number('Share for (ms)', 'maxAgeMs', LIMITS.maxAgeMs,
          'How old a frame may be and still be handed to another page instead of asking the switcher again.')),
      live,
      ...notes);
  }

  ctx.ui.settingsSection({ id: 'snapshot-relay', order: 20, render });
}
