/*
 * Desk control — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page: the switch, the patch and where it
 * sits, the fixture files to import, and which desk is in control of what. It
 * follows the server over `/__lpp/desk-control/stream`. Nothing here drives
 * the switcher: the server does, with or without this page open.
 */

import { PROTOCOLS, normaliseDesk } from './core.js';
import { MODES, FIXTURES } from '../../src/core/dmx-personality.js';

const CONTROL_TEXT = { off: 'not the desk’s', preview: 'desk edits preview', program: 'desk edits PROGRAM' };

export default function activate(ctx) {
  const { h, readout, card, note, picker } = ctx.kit;

  /* Normalised here as well: before the first save the page may hold nothing at all. */
  let settings = normaliseDesk(ctx.settings.get());
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
      stream.addEventListener('desk', (ev) => {
        try { live = JSON.parse(ev.data); ctx.refresh(); } catch { /* one bad frame is not worth the card */ }
      });
    } catch { /* no EventSource: the card still works, just not live */ }
  }

  async function put(patch) {
    saving = true;
    error = null;
    ctx.refresh();
    try {
      settings = normaliseDesk(await ctx.settings.set(patch));
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  /* Committed on blur and on Enter, not per keystroke: a patch that moves
     while somebody types "12" through "1" is a desk driving the wrong screen. */
  function field(label, value, onCommit, { width = '7rem', placeholder = '' } = {}) {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: 'text', value, placeholder,
        style: { maxWidth: width },
        disabled: saving ? 'disabled' : null,
        onBlur: (ev) => { if (ev.target.value !== value) onCommit(ev.target.value); },
        onKeyDown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); ev.target.blur(); } },
      }));
  }

  function check(label, on, onChange) {
    return h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => onChange(ev.target.checked),
      }),
      h('span', { class: 'aw-font-body-1', text: label }));
  }

  function download(label, path) {
    return h('a', {
      class: ['wru-button', 'aw-font-button', 'aw-border-radius', 'aw-flex-row-center', 'wru-button--default'],
      href: ctx.url(path), download: '', text: label,
    });
  }

  function socketLine(s, name) {
    if (!s) return { text: '—', tone: 'tertiary' };
    if (s.error) return { text: s.error, tone: 'warn' };
    return s.open ? { text: `${name} on UDP ${s.port}`, tone: null } : { text: 'closed', tone: 'tertiary' };
  }

  function patchTable(patch) {
    if (!patch || !patch.fixtures.length) return note('info', 'Nothing patched: name at least one screen, or keep the Master.');
    const cell = (text, extra = {}) => h('td', { class: 'aw-font-caption', style: { padding: '0.1rem 0.8rem 0.1rem 0' }, text, ...extra });
    const screen = new Map(((live && live.screens) || []).map((s) => [s.id, s]));
    return h('table', { style: { borderCollapse: 'collapse' } },
      h('thead', {}, h('tr', {}, ['Fixture', 'Type', 'Universe.Address', 'Channels', ''].map((t) => h('th', {
        class: 'aw-font-overline aw-text-tertiary', style: { textAlign: 'left', paddingRight: '0.8rem' }, text: t,
      })))),
      h('tbody', {}, patch.fixtures.map((f) => {
        const s = f.kind === 'screen' ? screen.get(f.destination) : null;
        const state = f.kind === 'master' ? (live && live.master ? CONTROL_TEXT[live.master] : '')
          : s ? [CONTROL_TEXT[s.control], s.held ? `waiting: ${s.held}` : ''].filter(Boolean).join(' — ') : '';
        return h('tr', {},
          cell(f.name),
          cell(FIXTURES[f.kind].name),
          cell(`${f.universe}.${f.address}`),
          cell(String(f.footprint)),
          cell(state, { class: ['aw-font-caption', s && s.control === 'program' ? 'wru-warn' : 'aw-text-tertiary'] }));
      })));
  }

  function render() {
    if (!asked) { asked = true; void load(); }
    listen();
    const on = settings.deskEnabled;
    const toggle = check('Listen for a lighting desk', on, (v) => put({ deskEnabled: v }));

    const interfaces = [{ id: '', label: 'Automatic (the desk’s own subnet)' },
      ...((live && live.interfaces) || []).map((a) => ({ id: a, label: a }))];
    if (settings.deskInterface && !interfaces.some((i) => i.id === settings.deskInterface)) {
      interfaces.push({ id: settings.deskInterface, label: `${settings.deskInterface} (not on this machine now)` });
    }
    const network = h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
      picker('Protocol', PROTOCOLS, settings.deskProtocol, (v) => put({ deskProtocol: v }), { disabled: saving }),
      picker('Network', interfaces, settings.deskInterface, (v) => put({ deskInterface: v }), { disabled: saving }),
      field('Only these desks', settings.deskAllow.join(' '), (v) => put({ deskAllow: v }),
        { width: '18rem', placeholder: 'any desk' }));

    const inService = live && live.switcher && live.switcher.destinations.length
      ? live.switcher.destinations.map((d) => d.id).join(' ') : '';
    const patchRow = h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
      field('Screens', settings.deskDestinations.join(' '), (v) => put({ deskDestinations: v.split(/[\s,]+/).filter(Boolean) }),
        { width: '16rem', placeholder: inService ? `in service: ${inService}` : 'S1 S2 A1' }),
      field('Layers per screen', String(settings.deskLayers), (v) => put({ deskLayers: Number(v) }), { width: '5rem' }),
      field('First universe', String(settings.deskFirstUniverse), (v) => put({ deskFirstUniverse: Number(v) }), { width: '6rem' }),
      picker('Mode', MODES, settings.deskMode, (v) => put({ deskMode: v }), { disabled: saving }),
      check('Master fixture', settings.deskMaster, (v) => put({ deskMaster: v })));

    const files = h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
      download('Master .gdtf', '/gdtf/master'),
      download('Screen .gdtf', '/gdtf/screen'),
      download('Layer .gdtf', '/gdtf/layer'),
      download('Patch .csv', '/patch.csv'));

    const universes = (live && live.universes) || [];
    const inControl = universes.map((u) => {
      const s = u.sources.find((x) => x.inControl);
      return `${u.universe}: ${s ? `${s.protocol === 'artnet' ? 'Art-Net' : 'sACN'} ${s.label}` : 'nobody'}${u.sources.length > 1 ? ` (+${u.sources.length - 1})` : ''}`;
    }).join(', ');
    const art = socketLine(live && live.sockets && live.sockets.artnet, 'Art-Net');
    const sacn = socketLine(live && live.sockets && live.sockets.sacn, 'sACN');
    const readouts = live && on
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Art-Net', art.text, { tone: art.tone }),
        readout('sACN', sacn.text, { tone: sacn.tone }),
        readout('In control', inControl || '—', { tone: inControl ? null : 'tertiary' }),
        readout('Writes', String(live.counts.written)),
        readout('Refused', String(live.counts.refused), { tone: live.counts.refused ? null : 'tertiary' }),
        readout('Dropped', String(live.counts.dropped), { tone: live.counts.dropped ? 'warn' : 'tertiary' }))
      : null;

    const notes = [];
    if (error) notes.push(note('warn', `Could not save: ${error}`));
    notes.push(note('warn',
      'Preview. This has driven the simulator from MagicQ PC and from a pretend desk sending real Art-Net, '
      + 'never a real switcher in a show. Treat the first one as a rehearsal.'));
    if (on && live) {
      if (live.switcher && live.switcher.error) notes.push(note('warn', live.switcher.error));
      if (live.sockets && live.sockets.sacn && live.sockets.sacn.multicastError) {
        notes.push(note('warn', `sACN multicast could not be joined (${live.sockets.sacn.multicastError}). Unicast sACN still works.`));
      }
      if (universes.some((u) => u.exceeded)) {
        notes.push(note('warn', 'More than four desks are sending to one universe; the extra ones are ignored.'));
      }
    }
    if (on) {
      notes.push(note('info',
        'A screen ignores the desk until its Screen fixture’s Control channel is raised: 25–49% edits '
        + 'preview, 50% and above edits program. Memory recalls to preview, Take and Cut fire on a rise '
        + 'past 50%, and nothing fires on the first frame after this starts or a desk takes over. Each Layer '
        + 'fixture is a source folder and file, and an opacity that follows the desk’s grand master.'));
      notes.push(note('info',
        'This listens on the network (UDP 6454 and 5568) whatever address the app itself is bound to. '
        + '“Only these desks” is the lock: list the desks’ addresses and nothing else can drive the switcher. '
        + 'Writes go over AWJ on TCP 10606, which can be switched off in the Web RCS security settings.'));
      notes.push(note('info',
        `Cue mode is ${FIXTURES.screen.modes.cue.length} channels a screen and ${FIXTURES.layer.modes.cue.length} a layer — `
        + 'a parameter count grandMA3 onPC with a small node, MagicQ PC and Titan Go all carry. '
        + 'Import the .gdtf files into the desk (grandMA3 and MagicQ read them directly; Titan converts '
        + 'them in Personality Builder) and patch as the table says. docs/DESK-CONTROL.md has the rest.'));
    }
    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 6).map((e) => h('div', {
          class: ['aw-font-caption', e.error || e.kind === 'dropped' ? 'wru-warn' : 'aw-text-tertiary'],
          text: e.note || e.error || e.kind,
        })))
      : null;

    return card('Lighting desk control',
      toggle, network, patchRow, files, patchTable(live ? live.patch : null), readouts, history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'desk-control', order: 13, render });
}
