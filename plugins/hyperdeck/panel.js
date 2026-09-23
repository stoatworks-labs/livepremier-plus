/*
 * The HyperDecks panel: the decks in the rack, what each is doing, the
 * buttons to drive it, and its rules.
 *
 * A whole-installation view, like Matrix Routing, so it is a sidebar entry.
 * One card per deck, because a deck is several things at once — a link, a
 * transport, a clip list, a plug on the back of the frame and a set of rules —
 * and a table row would hide most of them.
 *
 * Everything it shows about a deck comes from the server's stream, which is
 * what the deck said. A Play press does not light Play; the deck reporting
 * `play` does. That is the same rule the matrix grid keeps, for the same
 * reason: a deck with no disk refuses play, and a button that lit anyway would
 * be lying at exactly the moment it mattered.
 */

import { h, button, sectionTitle } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { readConnectors, describeConnector } from '../../src/core/connectors.js';
import { listDestinations } from '../../src/core/screens.js';
import { PROFILES, HYPERDECK_PORT, profileOf } from './protocol.js';
import { ROLES, ON_PROGRAM, ON_PREVIEW, ON_LEAVE, ON_END, plays, records } from './core.js';

const blankDraft = () => ({ name: '', host: '', port: String(HYPERDECK_PORT), profile: 'hyperdeck', role: 'player' });

const fmt = (s) => {
  if (s == null || !Number.isFinite(s)) return '—';
  const t = Math.max(0, s);
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`;
};

export function createDeckPanel({ ctx, state, load, command, saveDecks, airOf }) {
  let root = null;
  const draft = blankDraft();
  const open = new Set();   /* deck ids whose settings are unfolded */
  const recordName = {};    /* deck id -> what is typed in its Record name */

  const decks = () => (state.data && state.data.decks) || [];
  const liveOf = (id) => ((state.data && state.data.live) || []).find((d) => d.id === id) || null;
  const store = () => ctx.session.store;

  /** Change one deck's configuration and save the whole list. */
  const update = (id, patch) => saveDecks(decks().map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const updateRules = (deck, patch) => update(deck.id, { rules: { ...deck.rules, ...patch } });

  function render() {
    load();
    root = panel({
      toolbar: sectionTitle('HyperDecks', ...toolbar()),
      body: h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        state.error ? h('div', { class: 'wru-warn', text: state.error }) : null,
        runnerNote(),
        ...(state.data ? decks().map(deckCard) : [h('div', { class: 'wru-empty', text: 'Asking the launcher…' })]),
        state.data && !decks().length
          ? h('div', { class: 'wru-empty', text: 'No decks yet. Add a HyperDeck, or Mitti with its HyperDeck control switched on.' })
          : null,
        addForm(),
        activity()),
    });
    return root;
  }

  /** Holds repaints while somebody is typing or has a list open in this panel. */
  function busy() {
    const el = globalThis.document && document.activeElement;
    return !!(root && el && root.contains(el) && (el.tagName === 'INPUT' || el.tagName === 'SELECT'));
  }

  function toolbar() {
    const out = [];
    const recorders = decks().filter(records);
    if (recorders.length) {
      out.push(button('Record all', { variant: 'danger', title: 'Start every recorder', onClick: () => command('recorders', [{ command: 'record' }]) }));
      out.push(button('Stop recorders', { onClick: () => command('recorders', [{ command: 'stop' }]) }));
    }
    return out;
  }

  function runnerNote() {
    if (!decks().some((d) => d.rules.automate)) return null;
    if (state.runner === state.pageId) {
      return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'This page is running the rules.' });
    }
    if (state.runner) {
      return h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Another open page is running the rules; this one takes over if it closes.' });
    }
    return h('div', { class: 'wru-warn', text: 'No page holds the rules yet — they run only while a Web RCS page with this app is open.' });
  }

  /* ---------------------------------------------------------------- a deck */

  function deckCard(deck) {
    const live = liveOf(deck.id);
    const profile = profileOf(deck.profile);
    const link = !deck.enabled ? 'off' : !deck.host ? 'no address' : live ? live.status : 'disconnected';
    const air = airOf(deck.id);
    const onAir = air && air.program.size ? [...air.program] : [];
    const inPreview = air && air.preview.size ? [...air.preview] : [];

    return h('div', { class: 'wru-groups-card aw-border-radius aw-flex-col aw-gap-row-small', style: { padding: '0.8rem' } },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: deck.name }),
        h('span', { class: `wru-tag ${link === 'connected' ? 'wru-tag--good' : ''}`, title: live?.error || '', text: link }),
        h('span', { class: 'wru-tag', text: ROLES.find((r) => r.id === deck.role).label }),
        onAir.length ? h('span', { class: 'wru-tag wru-tag--warn', text: `ON AIR ${onAir.join(' ')}` }) : null,
        inPreview.length ? h('span', { class: 'wru-tag', text: `PVW ${inPreview.join(' ')}` }) : null,
        deck.rules.automate && plays(deck) ? h('span', { class: 'wru-tag wru-tag--good', text: 'rules on' }) : null,
        h('span', { class: 'aw-font-caption aw-text-tertiary', text: [
          profile.label, deck.host ? `${deck.host}:${deck.port}` : '',
          live?.device?.model && live.device.model !== profile.label ? live.device.model : '',
        ].filter(Boolean).join(' · ') })),
      live && live.status === 'connected' ? transport(deck, live) : null,
      live?.remoteDisabled ? h('div', { class: 'wru-warn', text: 'The deck said remote control is off; the next command switches it on.' }) : null,
      open.has(deck.id) ? settings(deck) : null,
      h('div', { class: 'aw-flex-row aw-gap-col-small' },
        button(open.has(deck.id) ? 'Close settings' : 'Settings and rules', {
          onClick: () => { if (open.has(deck.id)) open.delete(deck.id); else open.add(deck.id); ctx.refresh(); },
        })));
  }

  function transport(deck, live) {
    const t = live.transport || {};
    const clips = live.clips || [];
    const clip = clips.find((c) => c.id === t.clip);
    const pos = live.position || {};
    const status = t.status || '—';
    const run = (cmd, extra = {}) => command(deck.id, [{ command: cmd, ...extra }]);

    const rows = [
      h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readoutTone('Transport', status, status === 'record' ? 'danger' : status === 'play' ? 'success' : null),
        readoutTone('Clip', clip ? `${clip.id} · ${clip.name}` : t.clip != null ? String(t.clip) : '—'),
        readoutTone('Elapsed', fmt(pos.elapsed)),
        readoutTone('Remaining', fmt(pos.remaining), pos.remaining != null && pos.remaining < 10 && status === 'play' ? 'warning' : null),
        t.videoFormat ? readoutTone('Format', t.videoFormat) : null,
        live.slot && live.slot.status ? readoutTone('Disk', [live.slot.volume, live.slot.status].filter(Boolean).join(' · ')) : null),
    ];

    const controls = [];
    if (plays(deck)) {
      controls.push(
        button('Prev', { title: 'Previous clip', onClick: () => run('prev') }),
        button('Top', { title: 'Back to the start of this clip', onClick: () => run('rewind') }),
        button('Play', { variant: 'go', active: status === 'play', onClick: () => run('play') }),
        button('Stop', { active: status === 'stopped', onClick: () => run('stop') }),
        button('Next', { title: 'Next clip', onClick: () => run('next') }),
        h('select', {
          class: 'wru-select', title: 'Cue a clip',
          onChange: (ev) => { if (ev.target.value) run('clip', { clip: Number(ev.target.value) }); },
        }, h('option', { value: '', text: clips.length ? `Cue a clip (${clips.length})` : 'No clips' }),
        ...clips.map((c) => h('option', { value: String(c.id), selected: c.id === t.clip ? 'selected' : null, text: `${c.id}  ${c.name}` }))));
    }
    if (records(deck)) {
      controls.push(
        h('input', {
          class: 'wru-input', type: 'text', placeholder: deck.recordName || 'Clip name (optional)',
          value: recordName[deck.id] ?? '', style: { maxWidth: '12rem' },
          onInput: (ev) => { recordName[deck.id] = ev.target.value; },
        }),
        button(status === 'record' ? 'Recording' : 'Record', {
          variant: 'danger', active: status === 'record',
          onClick: () => run('record', { name: recordName[deck.id] || deck.recordName || undefined }),
        }),
        status === 'record' ? button('Stop recording', { onClick: () => run('stop') }) : null);
    }
    rows.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' }, ...controls.filter(Boolean)));
    return h('div', { class: 'aw-flex-col aw-gap-row-small' }, ...rows);
  }

  function readoutTone(label, value, tone) {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('div', { class: ['aw-font-body-1-bold', tone ? `aw-text-${tone}` : ''], text: String(value) }));
  }

  /* ---------------------------------------------------------------- settings */

  function field(label, control, hint) {
    return h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { minWidth: '12rem' } },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      control,
      hint ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: hint }) : null);
  }

  const select = (choices, current, onPick, extra = {}) => h('select', {
    class: 'wru-select', onChange: (ev) => onPick(ev.target.value), ...extra,
  }, ...choices.map((c) => h('option', { value: c.id, selected: c.id === current ? 'selected' : null, text: c.label })));

  const text = (value, onCommit, extra = {}) => h('input', {
    class: 'wru-input', type: 'text', value: value ?? '', style: { maxWidth: '14rem' }, ...extra,
    onBlur: (ev) => { if (ev.target.value !== String(value ?? '')) onCommit(ev.target.value); },
    onKeyDown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); },
  });

  function connectorChoices(side, none) {
    const s = store();
    const list = s && s.ready ? readConnectors(s, side) : [];
    return [{ id: '', label: none }, ...list.map((c) => ({ id: c.id, label: describeConnector(c) }))];
  }

  function settings(deck) {
    const profile = profileOf(deck.profile);
    const roles = profile.record ? ROLES : ROLES.filter((r) => r.id === 'player');
    const parts = [
      h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
        field('Name', text(deck.name, (v) => update(deck.id, { name: v }))),
        field('Address', text(deck.host, (v) => update(deck.id, { host: v.trim() }), { placeholder: '192.168.1.50' })),
        field('Port', text(String(deck.port), (v) => update(deck.id, { port: Number(v) }), { style: { maxWidth: '6rem' } })),
        field('Kind', select(PROFILES, deck.profile, (v) => update(deck.id, { profile: v, ...(profileOf(v).record ? {} : { role: 'player' }) })), profile.what),
        field('Role', select(roles, deck.role, (v) => update(deck.id, { role: v }))),
        field('Connected', h('input', {
          type: 'checkbox', checked: deck.enabled ? 'checked' : null,
          onChange: (ev) => update(deck.id, { enabled: ev.target.checked }),
        }), 'Off hangs the link up and keeps the settings.')),
      h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
        plays(deck)
          ? field('Plays into', select(connectorChoices('input', 'Not linked to an input'), deck.input, (v) => update(deck.id, { input: v })),
            'The plug on the back of the frame this deck’s output is cabled to. The rules watch it.')
          : null,
        deck.role !== 'player'
          ? field('Records', select(connectorChoices('output', 'Not linked to an output'), deck.output, (v) => update(deck.id, { output: v })),
            'The switcher output cabled to this deck’s input — for the record; nothing switches it.')
          : null,
        records(deck)
          ? field('Default clip name', text(deck.recordName, (v) => update(deck.id, { recordName: v }), { placeholder: 'the deck’s own naming' }))
          : null),
    ];
    if (plays(deck)) parts.push(rulesEditor(deck));
    parts.push(h('div', {},
      button('Remove this deck', { variant: 'danger', onClick: () => { open.delete(deck.id); saveDecks(decks().filter((d) => d.id !== deck.id)); } })));
    return h('div', { class: 'aw-flex-col aw-gap-row-medium', style: { paddingTop: '0.4rem' } }, ...parts);
  }

  function rulesEditor(deck) {
    const r = deck.rules;
    const s = store();
    const screens = s && s.ready ? listDestinations(s) : [];
    const toggleScreen = (id, on) => updateRules(deck, { screens: on ? [...r.screens, id] : r.screens.filter((x) => x !== id) });
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Rules — what the deck does as its input goes on and off air, and what the switcher does when a clip ends.' }),
      !deck.input ? h('div', { class: 'wru-warn', text: 'Link the deck to an input first: the rules follow that input.' }) : null,
      h('label', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('input', { type: 'checkbox', checked: r.automate ? 'checked' : null, onChange: (ev) => updateRules(deck, { automate: ev.target.checked }) }),
        h('span', { class: 'aw-font-body-1-bold', text: 'Follow the switcher' })),
      h('div', { class: 'aw-flex-row aw-gap-col-large aw-flex-wrap' },
        field('Put on program', select(ON_PROGRAM, r.onProgram, (v) => updateRules(deck, { onProgram: v }))),
        field('Put in preview', select(ON_PREVIEW, r.onPreview, (v) => updateRules(deck, { onPreview: v }))),
        field('Taken off program', select(ON_LEAVE, r.onLeave, (v) => updateRules(deck, { onLeave: v }))),
        field('When a clip ends', select(ON_END, r.onEnd, (v) => updateRules(deck, { onEnd: v })),
          'On the screens the deck is on air on, the way the screen’s own TAKE or CUT would.'),
        field('Seconds early', text(String(r.lead), (v) => updateRules(deck, { lead: Number(v) }), { style: { maxWidth: '5rem' } }),
          'Fire the end action this long before the last frame — the length of the mix, so it lands on the end.')),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: r.screens.length ? 'Only on these screens' : 'On every screen (tick some to narrow it)' }),
        h('div', { class: 'aw-flex-row aw-gap-col-medium aw-flex-wrap' },
          ...screens.map((d) => h('label', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
            h('input', { type: 'checkbox', checked: r.screens.includes(d.id) ? 'checked' : null, onChange: (ev) => toggleScreen(d.id, ev.target.checked) }),
            h('span', { text: d.label ? `${d.id} ${d.label}` : d.id }))),
          screens.length ? null : h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting for the switcher’s screen list…' }))));
  }

  /* ---------------------------------------------------------------- add */

  function addForm() {
    const profile = profileOf(draft.profile);
    const roles = profile.record ? ROLES : ROLES.filter((r) => r.id === 'player');
    const set = (k) => (ev) => { draft[k] = ev.target.value; if (k === 'profile' && !profileOf(draft.profile).record) draft.role = 'player'; };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Add a deck' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('input', { class: 'wru-input', type: 'text', placeholder: 'Name', value: draft.name, onInput: set('name'), style: { maxWidth: '10rem' } }),
        h('input', { class: 'wru-input', type: 'text', placeholder: 'Address', value: draft.host, onInput: set('host'), style: { maxWidth: '10rem' } }),
        h('input', { class: 'wru-input', type: 'text', placeholder: 'Port', value: draft.port, onInput: set('port'), style: { maxWidth: '5rem' } }),
        h('select', { class: 'wru-select', onChange: (ev) => { set('profile')(ev); ctx.refresh(); } },
          ...PROFILES.map((p) => h('option', { value: p.id, selected: p.id === draft.profile ? 'selected' : null, text: p.label }))),
        h('select', { class: 'wru-select', onChange: set('role') },
          ...roles.map((r) => h('option', { value: r.id, selected: r.id === draft.role ? 'selected' : null, text: r.label }))),
        button('Add', {
          variant: 'go',
          disabled: !state.data,
          onClick: async () => {
            const next = { name: draft.name, host: draft.host.trim(), port: Number(draft.port) || HYPERDECK_PORT, profile: draft.profile, role: draft.role };
            Object.assign(draft, blankDraft());
            await saveDecks([...decks(), next]);
            const added = decks()[decks().length - 1];
            if (added) open.add(added.id);
            ctx.refresh();
          },
        })));
  }

  function activity() {
    if (!state.log.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'What the rules did' }),
      ...state.log.slice(0, 12).map((e) => h('div', {
        class: ['aw-font-caption', e.warn ? 'wru-warn' : ''],
        text: `${e.at.toLocaleTimeString()}  ${e.text}`,
      })));
  }

  return { render, busy };
}
