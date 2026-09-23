/*
 * Pixelhue panel — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page, which is where it lived before it was
 * a plugin: the switch, the console's address and model, and what the link is
 * doing. It follows the console live over `/__lpp/pixelhue/stream` — the card
 * used to learn about the link only when a setting was next saved.
 *
 * Marked preview in as many words, because it has never been run against a
 * console: every byte of it was worked out from firmware and proved against
 * the vendor's own control service running headless in a VM. That is a long
 * way from a panel on a desk, and an operator deciding whether to rig one
 * deserves to be told which it is.
 *
 * It is also the second setting on that page that writes to a switcher without
 * anybody looking at a browser, so it is off until somebody turns it on,
 * exactly like the OSC listener.
 */

import { CONSOLE_MODELS, TRANSPORT_TARGETS } from './core.js';

/* How often an open page renews its claim to run the panel's page-side
   actions. Well inside the server's lease, so one missed beat loses nothing. */
const RUNNER_BEAT_MS = 4000;
/* How long to wait for the Screens / Aux. page to draw its sources after
   being opened, before giving up on an input's backup menu. */
const SOURCES_WAIT_MS = 4000;

export default function activate(ctx) {
  const { h, readout, card, note, picker } = ctx.kit;

  let settings = ctx.settings.get();
  let live = null;
  let saving = false;
  let error = null;
  let stream = null;
  /* This page's claim to the panel's page-side actions: the cue stack, and
     opening a page when MVR or SOURCE BACKUP is pressed. The server names one
     holder at a time, so two open tabs do not both fire GO. */
  const pageId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `p${Math.random().toString(36).slice(2)}`;
  let runner = null;
  /* Asked once and then followed; a card that re-fetched on every repaint
     would ask about once a second while the settings page is open. */
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
      stream.addEventListener('page', (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.runner === pageId) void act(msg);
      });
    } catch { /* no EventSource: the card still works, just not live */ }
  }

  /* ---------------------------------------------------- page-side actions */

  async function beat() {
    try {
      const res = await fetch(ctx.url('/runner'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: pageId }),
      });
      if (res.ok) runner = (await res.json()).runner;
    } catch { /* the next beat tries again */ }
  }

  /** Open one of the vendor's pages by its path, as its own sidebar link does. */
  function openPath(path) {
    const link = document.querySelector(`a[href="${path}"]`);
    if (link) { link.click(); return true; }
    ctx.log.warn(`no link to ${path} on this page`);
    return false;
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * An input's own menu on Screens / Aux. — the one its card's ⋮ opens, with
   * the input's backup in it. Found by the card's number and the ⋮'s icon,
   * because every class on that page is hashed.
   */
  async function openInputBackup(input) {
    if (location.pathname !== '/live/screens') openPath('/live/screens');
    const deadline = Date.now() + SOURCES_WAIT_MS;
    while (Date.now() < deadline) {
      const button = inputMenuButton(input);
      if (button) {
        button.closest('.aw-card').scrollIntoView({ block: 'center' });
        button.click();
        return true;
      }
      await wait(150);
    }
    ctx.log.warn(`input ${input} is not on the Screens / Aux. page's live inputs`);
    return false;
  }

  function inputMenuButton(input) {
    for (const card of document.querySelectorAll('.aw-card')) {
      const header = card.querySelector('.aw-header');
      const number = header && /^\d+/.exec(header.textContent.trim());
      if (!number || Number(number[0]) !== Number(input)) continue;
      for (const button of card.querySelectorAll('.aw-card--displayed-hover button')) {
        const use = button.querySelector('use');
        const icon = use && (use.getAttribute('href') || use.getAttribute('xlink:href'));
        if (icon === '#more-vertical-12') return button;
      }
    }
    return null;
  }

  function transport(action) {
    const stack = ctx.use('stack');
    if (!stack) { ctx.log.warn(`cue ${action}: the Timeline is off, so there is no cue stack`); return; }
    const cues = stack.cues();
    const standby = stack.standby;
    const at = standby ? cues.findIndex((c) => c.id === standby.id) : -1;
    switch (action) {
      case 'play': stack.go(); break;
      case 'stop': stack.stop(); break;
      case 'previous': stack.back(); break;
      case 'restart': if (cues.length) stack.gotoId(cues[0].id); break;
      case 'next': if (cues[at + 1]) stack.gotoId(cues[at + 1].id); break;
      default: break;
    }
  }

  async function act(msg) {
    if (msg.type === 'transport') transport(msg.action);
    else if (msg.type === 'navigate') openPath(msg.path);
    else if (msg.type === 'inputBackup') await openInputBackup(msg.input);
  }

  void beat();
  const beating = setInterval(beat, RUNNER_BEAT_MS);
  if (typeof ctx.onDispose === 'function') ctx.onDispose(() => clearInterval(beating));
  listen();

  async function put(patch) {
    saving = true;
    error = null;
    ctx.refresh();
    try {
      settings = await ctx.settings.set(patch);
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  function commitHost(raw) {
    const value = String(raw || '').trim();
    if (value === settings.pixelhueHost) return;
    if (value && !/^[A-Za-z0-9._-]+$/.test(value)) {
      error = `${raw} is not a host name or address`;
      ctx.refresh();
      return;
    }
    void put({ pixelhueHost: value });
  }

  function render() {
    if (!asked) { asked = true; void load(); }
    listen();

    const on = settings.pixelhueEnabled;
    const link = live && live.link;
    const model = CONSOLE_MODELS.find((m) => m.id === settings.pixelhueModel);

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ pixelhueEnabled: ev.target.checked })
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive a Pixelhue console' }));

    const host = h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Console address' }),
      h('input', {
        class: 'wru-input', type: 'text', value: settings.pixelhueHost,
        placeholder: model && model.overLan ? '192.168.2.50' : '127.0.0.1',
        style: { maxWidth: '12rem' },
        disabled: saving ? 'disabled' : null,
        /* On blur, not per keystroke: a link is rebuilt on every change and
           retyping an address would dial four consoles that do not exist. */
        onBlur: (ev) => commitHost(ev.target.value),
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } }
      }));

    const rows = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Link', link && link.connected ? `connected to ${link.host}:${link.port}` : 'not connected',
          { tone: link && link.connected ? null : 'tertiary' }),
        readout('Published', link ? String(link.published) : '0'),
        readout('Commands', link ? String(link.commands) : '0'),
        readout('Selected', live.selection.destinations.join(' ') || 'nothing on the panel',
          { tone: live.selection.destinations.length ? null : 'tertiary' }),
        readout('Editing', live.selection.buffer, { tone: live.selection.buffer === 'PROGRAM' ? 'warn' : null }))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', `Could not save: ${error}`));
    notes.push(note('warn',
      'Preview. This has never been run against a console — it was built from the '
      + 'firmware and proved against the vendor’s own control service running with no '
      + 'hardware. Treat the first show with one as a rehearsal.'));
    if (model && !model.overLan) {
      notes.push(note('warn',
        `A ${model.label} serves its control port on loopback only, so this app has to be `
        + 'running on the console itself to reach one. A U5 mini answers on the network.'));
    }
    if (link && link.lastError) notes.push(note('warn', link.lastError));
    if (on) {
      notes.push(note('info',
        'The console is handed a model of this switcher — its screens, inputs and memories — '
        + 'and labels, lights and pages its own keys from it. What comes back is what the '
        + 'operator meant, so there is no key mapping to keep. docs/PIXELHUE.md has the rest.'));
      notes.push(note('info',
        'A recall from the panel always lands in preview, whatever PGM EDIT is doing, for the '
        + 'same reason every other recall in this app does. Fade to black and freeze are '
        + 'reported by the console and not yet sent anywhere.'));
      notes.push(note('info',
        'Tally is read when the panel connects and after each change it makes. A take fired '
        + 'from the Web RCS or the front panel does not relight the console’s keys until then.'));
    }

    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.command, e.note || e.error || e.kind].filter(Boolean).join(' — ')
        })))
      : null;

    const number = (label, key, min, max) => h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: 'number', min: String(min), max: String(max), value: String(settings[key]),
        style: { maxWidth: '5rem' },
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ [key]: Number(ev.target.value) })
      }));
    const transportRow = h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
      picker('Cue transport keys', TRANSPORT_TARGETS, settings.pixelhueTransport,
        (v) => put({ pixelhueTransport: v }), { disabled: saving }),
      settings.pixelhueTransport === 'companion' ? number('Companion page', 'pixelhueCompanionPage', 1, 99) : null,
      settings.pixelhueTransport === 'companion' ? number('Row', 'pixelhueCompanionRow', 0, 99) : null);
    if (on && settings.pixelhueTransport === 'companion') {
      notes.push(note('info',
        `The five cue transport keys press Companion buttons ${settings.pixelhueCompanionPage}/`
        + `${settings.pixelhueCompanionRow}/0 to /4 — play, restart, stop, previous, next — for a `
        + 'media player or anything else Companion drives.'));
    }
    if (on && live && !live.runner) {
      notes.push(note('warn',
        'No page holds the panel’s page-side actions yet — the cue stack, and MVR and SOURCE '
        + 'BACKUP opening pages — so they are refused until a page of this app is open.'));
    }

    return card('Pixelhue panel',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle, host,
        picker('Console', CONSOLE_MODELS, settings.pixelhueModel, (v) => put({ pixelhueModel: v }),
          { disabled: saving })),
      transportRow, rows, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'pixelhue', order: 10, render });
}
