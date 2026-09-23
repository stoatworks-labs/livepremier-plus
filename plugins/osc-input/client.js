/*
 * OSC input — the plugin's page half: its card on the settings page.
 *
 * The only setting in this app that opens a port, which is why it is off by
 * default, binds loopback unless told otherwise, and says in as many words
 * what the other option means. This fires takes on a video switcher.
 */

import { OSC_BIND_CHOICES } from '../../src/core/settings.js';
import { OSC_ROOT } from '../../src/vendor/mynah-lang.mjs';

/** How often the card asks the listener what it has done, while it is drawn. */
const POLL_MS = 2000;

export default function activate(ctx) {
  let live = null;
  let asked = 0;
  let problem = null;

  /* The counts move while the card is open, so it asks again now and then —
     only when it is being drawn, and never more than every two seconds. */
  function poll() {
    if (Date.now() - asked < POLL_MS) return;
    asked = Date.now();
    fetch(ctx.url('/state'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((state) => {
        if (state && JSON.stringify(state) !== JSON.stringify(live)) { live = state; ctx.refresh(); }
      })
      .catch(() => { /* the next draw asks again */ });
  }

  const save = (patch) => ctx.settings.set(patch).then(
    () => { problem = null; asked = 0; ctx.refresh(); },
    (err) => { problem = err.message; ctx.refresh(); });

  function commitPort(raw, current) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 1024 || n >= 65536) {
      /* Refused rather than clamped, and the field is repainted with what is
         actually in force — a silently corrected port is one an operator
         will spend an hour sending to. */
      problem = `${raw} is not a usable port — pick something above 1024`;
      ctx.refresh();
      return;
    }
    if (n !== current) void save({ oscPort: n });
  }

  function render() {
    poll();
    const { h, card, note, readout, picker } = ctx.kit;
    const s = ctx.settings.get();

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: s.oscEnabled ? 'checked' : null,
        onChange: (ev) => void save({ oscEnabled: ev.target.checked })
      }),
      h('span', { class: 'aw-font-body-1', text: 'Listen for OSC' }));

    const port = h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'UDP port' }),
      h('input', {
        class: 'wru-input', type: 'text', value: String(s.oscPort),
        style: { maxWidth: '7rem' },
        /* Committed on blur and on Enter, not per keystroke: rebinding a UDP
           socket on the way from 8000 to 9000 would bind 900 first. */
        onBlur: (ev) => commitPort(ev.target.value, s.oscPort),
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      }));

    const rows = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('State', live.listening ? `listening on ${live.address}:${live.port}` : 'not listening',
          { tone: live.listening ? null : 'tertiary' }),
        readout('Received', String(live.received)),
        readout('Writes sent', String(live.sent)),
        readout('Refused', String(live.failed), { tone: live.failed ? null : 'tertiary' }),
        /* Which platform the addresses are spelled for. The listener asks the
           switcher on the first packet; until then it has not decided. */
        readout('Spelled for', live.platform || 'asked on the first message',
          { tone: live.platform ? null : 'tertiary' }))
      : null;

    const notes = [];
    if (problem) notes.push(note('warn', problem));
    if (live && live.lastError) notes.push(note('warn', live.lastError));
    if (s.oscEnabled) {
      notes.push(note('info',
        `Addresses start ${OSC_ROOT}/ — the full dictionary is in docs/OSC.md. `
        + 'Messages are written to the switcher over AWJ on TCP 10606, which works with no '
        + 'browser open; that port can be switched off in the Web RCS security settings.'));
      notes.push(note('info',
        'preview and program are refused here and answered only in the console: naming a '
        + 'buffer needs the device’s take state, which this process does not hold. Address a '
        + 'buffer directly — /a, /b or /c.'));
    }

    return card('OSC input',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle, port,
        picker('Accept from', OSC_BIND_CHOICES, s.oscBind, (v) => void save({ oscBind: v }))),
      rows, ...notes);
  }

  /* Where the app's own OSC card used to be: first among the plugins' cards. */
  ctx.ui.settingsSection({ id: 'osc-input', order: 5, render });
}
