/*
 * The Triggers panel: what is waiting to be put back, the destinations, the
 * triggers, and what was sent.
 *
 * Waiting restores come first, because they are the part that matters mid-show:
 * a hold left from before a restart, or a VT that will never end because its
 * Mitti cue loops, is something an operator has to see and deal with, and
 * Restore all is the one button that puts everything back.
 *
 * A trigger's lines are edited as text, one line each, and saved when the
 * field loses focus. A line that does not read is listed under its trigger
 * with the reason; it is kept, not dropped, because the usual cause is a
 * destination renamed or not added yet.
 */

import { h, button, sectionTitle } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { KINDS, kindOf, isDmx, formatUniverse, formatRestore, cueName, MSC_FORMATS } from './core.js';

const blankDest = () => ({ name: '', kind: 'osc', host: '', port: '', universe: '' });

const HELP = [
  ['OSC', 'Desk /ch/17/mix/on 1 — numbers are i or f by how they are written; "quoted" is a string; i:1, f:1, s:1 to say; true, false'],
  ['MIDI over TCP', 'Desk note 1 60 127 · off 1 60 · cc 1 7 100 · pc 1 5 · msc go 45 list 1 · msc fire 3 · hex F0 7F 01 F7'],
  ['Art-Net, sACN', 'House 1-4 @ 0 fade 3 · 1,3,5-8 @ 50% · 1 thru 4 @ full · 1-4 @ before fade 5 · release'],
  ['A cue', 'In the Timeline’s cue editor: VT audio; House down; restore when Mitti ends or after 5:00 then go'],
];

export function createTriggersPanel({ ctx, state, open, post, save }) {
  let root = null;
  const draft = blankDest();
  let newTrigger = '';

  const data = () => state.data || { destinations: [], triggers: [], holds: [], problems: [], universes: [], log: [], decks: [] };
  const setup = () => ({ destinations: data().destinations, triggers: data().triggers });
  const saveDest = (id, patch) => save({ ...setup(), destinations: data().destinations.map((d) => (d.id === id ? { ...d, ...patch } : d)) });
  const saveTrigger = (id, patch) => save({ ...setup(), triggers: data().triggers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  function render() {
    open();
    root = panel({
      toolbar: sectionTitle('Triggers', ...toolbar()),
      body: h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        state.error ? h('div', { class: 'wru-warn', text: state.error }) : null,
        state.data ? null : h('div', { class: 'wru-empty', text: 'Asking the launcher…' }),
        state.data ? holds() : null,
        state.data ? destinations() : null,
        state.data ? triggers() : null,
        help(),
        activity()),
    });
    return root;
  }

  /** Holds repaints while somebody is typing or has a list open in this panel. */
  function busy() {
    const el = globalThis.document && document.activeElement;
    return !!(root && el && root.contains(el) && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName));
  }

  function toolbar() {
    if (!data().holds.length) return [];
    return [button('Restore all', {
      variant: 'danger',
      title: 'Send every waiting restore’s back lines now, newest first',
      onClick: () => post('/restore', { all: true }),
    })];
  }

  /* ---------------------------------------------------------------- holds */

  function holds() {
    const list = data().holds;
    if (!list.length) return null;
    const triggerName = (id) => data().triggers.find((t) => t.id === id)?.name ?? id;
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Waiting to restore' }),
      ...list.slice().reverse().map((hold) => {
        const left = hold.deadline ? Math.max(0, Math.round((hold.deadline - Date.now()) / 1000)) : null;
        return h('div', { class: 'wru-groups-card aw-border-radius aw-flex-col aw-gap-row-mini', style: { padding: '0.6rem 0.8rem' } },
          h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
            h('div', { class: 'aw-font-body-1-bold', text: cueName(hold.cue) }),
            hold.stale ? h('span', { class: 'wru-tag wru-tag--warn', title: 'It was waiting when the app stopped. It will not restore by itself.', text: 'from before the restart' }) : null,
            left != null && !hold.stale ? h('span', { class: 'wru-tag', text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` }) : null),
          h('div', { class: 'aw-font-caption aw-text-tertiary', text: [
            hold.fire.length ? hold.fire.map(triggerName).join(', ') : 'no triggers',
            formatRestore(hold.restore, data().decks),
          ].join(' · ') }),
          h('div', { class: 'aw-flex-row aw-gap-col-small' },
            button('Restore now', { variant: 'go', onClick: () => post('/restore', { id: hold.id }) }),
            button('Discard', { title: 'Forget it without sending anything', onClick: () => post('/discard', { id: hold.id }) })));
      }));
  }

  /* ---------------------------------------------------------------- destinations */

  const text = (value, onCommit, extra = {}) => h('input', {
    class: 'wru-input', type: 'text', value: value ?? '', style: { maxWidth: '10rem' }, ...extra,
    onBlur: (ev) => { if (ev.target.value !== String(value ?? '')) onCommit(ev.target.value); },
    onKeyDown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); },
  });

  const small = (label, control) => h('label', { class: 'aw-flex-col aw-gap-row-mini' },
    h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  function destinations() {
    const list = data().destinations;
    const sending = new Map((data().universes || []).map((u) => [u.dest, u]));
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Destinations' }),
      ...list.map((d) => {
        const u = sending.get(d.id);
        return h('div', { class: 'wru-groups-card aw-border-radius aw-flex-col aw-gap-row-small', style: { padding: '0.6rem 0.8rem' } },
          h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
            h('div', { class: 'aw-font-subtitle-1', text: d.name }),
            h('span', { class: 'wru-tag', title: kindOf(d.kind).what, text: kindOf(d.kind).label }),
            !d.enabled ? h('span', { class: 'wru-tag', text: 'off' }) : null,
            u ? h('span', { class: `wru-tag ${u.error ? 'wru-tag--warn' : 'wru-tag--good'}`, title: u.error || '', text: u.fading ? 'fading' : `sending · ${u.lit} lit` }) : null),
          h('div', { class: 'aw-flex-row aw-gap-col-small aw-flex-wrap', style: { alignItems: 'flex-end' } },
            small('Name', text(d.name, (v) => saveDest(d.id, { name: v }))),
            small(d.kind === 'artnet' ? 'Node' : 'Address',
              text(d.host, (v) => saveDest(d.id, { host: v.trim() }),
                d.kind === 'sacn' ? { placeholder: 'multicast', title: 'Empty sends to the universe’s multicast group' } : {})),
            small('Port', text(String(d.port), (v) => saveDest(d.id, { port: Number(v) }), { style: { maxWidth: '5rem' } })),
            isDmx(d.kind) ? small('Universe', text(formatUniverse(d.universe, d.kind), (v) => saveDest(d.id, { universe: v }), { style: { maxWidth: '6rem' } })) : null,
            d.kind === 'sacn' ? small('Priority', text(String(d.priority), (v) => saveDest(d.id, { priority: Number(v) }), { style: { maxWidth: '4rem' }, title: '0–200. Above the desk’s (usually 100) wins the whole universe.' })) : null,
            d.kind === 'midi-tcp' ? small('MSC device', text(String(d.mscDevice), (v) => saveDest(d.id, { mscDevice: Number(v) }), { style: { maxWidth: '4rem' }, title: '0–127; 127 is all-call' })) : null,
            d.kind === 'midi-tcp' ? small('MSC format', h('select', {
              class: 'wru-select', onChange: (ev) => saveDest(d.id, { mscFormat: ev.target.value }),
            }, ...Object.keys(MSC_FORMATS).map((f) => h('option', { value: f, selected: f === d.mscFormat ? 'selected' : null, text: f })))) : null),
          h('div', { class: 'aw-flex-row aw-gap-col-small aw-flex-wrap' },
            button(d.enabled ? 'Switch off' : 'Switch on', { onClick: () => saveDest(d.id, { enabled: !d.enabled }) }),
            u ? button('Release', { title: 'Stop sending this universe. sACN tells receivers to let go at once.', onClick: () => post('/release', { dest: d.id }) }) : null,
            button('Remove', { onClick: () => save({ ...setup(), destinations: list.filter((x) => x.id !== d.id) }) })));
      }),
      list.length ? null : h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'None yet. A sound desk on OSC, an Allen & Heath desk on MIDI over TCP, a node on Art-Net or sACN.' }),
      addDestination());
  }

  function addDestination() {
    const kind = kindOf(draft.kind);
    const set = (k) => (ev) => { draft[k] = ev.target.value; };
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
      h('input', { class: 'wru-input', type: 'text', placeholder: 'Name', value: draft.name, onInput: set('name'), style: { maxWidth: '8rem' } }),
      h('select', { class: 'wru-select', onChange: (ev) => { set('kind')(ev); ctx.refresh(); } },
        ...KINDS.map((k) => h('option', { value: k.id, selected: k.id === draft.kind ? 'selected' : null, text: k.label }))),
      h('input', { class: 'wru-input', type: 'text', placeholder: kind.id === 'sacn' ? 'Address (optional)' : 'Address', value: draft.host, onInput: set('host'), style: { maxWidth: '9rem' } }),
      h('input', { class: 'wru-input', type: 'text', placeholder: String(kind.port), value: draft.port, onInput: set('port'), style: { maxWidth: '5rem' } }),
      isDmx(kind.id) ? h('input', { class: 'wru-input', type: 'text', placeholder: kind.id === 'artnet' ? 'Universe 0:0:0' : 'Universe 1', value: draft.universe, onInput: set('universe'), style: { maxWidth: '7rem' } }) : null,
      button('Add destination', {
        variant: 'go',
        disabled: !state.data,
        onClick: async () => {
          const next = { name: draft.name, kind: draft.kind, host: draft.host.trim(), port: Number(draft.port) || kind.port, universe: draft.universe || undefined };
          Object.assign(draft, blankDest());
          await save({ ...setup(), destinations: [...data().destinations, next] });
        },
      }));
  }

  /* ---------------------------------------------------------------- triggers */

  const area = (lines, onCommit, placeholder) => h('textarea', {
    class: 'wru-input', rows: String(Math.max(2, lines.length + 1)), placeholder,
    style: { width: '100%', maxWidth: '100%', fontFamily: 'ui-monospace, Menlo, monospace', resize: 'vertical' },
    onBlur: (ev) => {
      const next = ev.target.value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (next.join('\n') !== lines.join('\n')) onCommit(next);
    },
  }, lines.join('\n'));

  function triggers() {
    const list = data().triggers;
    const firstDest = data().destinations[0]?.name || 'Desk';
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Triggers' }),
      ...list.map((t) => {
        const problems = (data().problems || []).filter((p) => p.trigger === t.id);
        return h('div', { class: 'wru-groups-card aw-border-radius aw-flex-col aw-gap-row-small', style: { padding: '0.6rem 0.8rem' } },
          h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
            text(t.name, (v) => saveTrigger(t.id, { name: v }), { style: { maxWidth: '12rem' }, 'data-lpp-key': `trigger-name-${t.id}` }),
            problems.length ? h('span', { class: 'wru-tag wru-tag--warn', text: `${problems.length} line${problems.length === 1 ? '' : 's'} not understood` }) : null),
          small('Go', area(t.go, (go) => saveTrigger(t.id, { go }), `${firstDest} /ch/17/mix/on 1`)),
          small('Back', area(t.back, (back) => saveTrigger(t.id, { back }), `${firstDest} /ch/17/mix/on 0`)),
          problems.length ? h('ul', { class: 'wru-warnings wru-warn' },
            ...problems.map((p) => h('li', { text: `${p.side} “${p.line}”: ${p.error}` }))) : null,
          h('div', { class: 'aw-flex-row aw-gap-col-small aw-flex-wrap' },
            button('Test go', { title: 'Send the go lines now', onClick: () => post('/test', { trigger: t.id, side: 'go' }) }),
            button('Test back', { title: 'Send the back lines now', onClick: () => post('/test', { trigger: t.id, side: 'back' }) }),
            button('Remove', { onClick: () => save({ ...setup(), triggers: list.filter((x) => x.id !== t.id) }) })));
      }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('input', { class: 'wru-input', type: 'text', placeholder: 'New trigger’s name — VT audio', value: newTrigger, onInput: (ev) => { newTrigger = ev.target.value; }, style: { maxWidth: '14rem' } }),
        button('Add trigger', {
          variant: 'go',
          disabled: !state.data,
          onClick: async () => {
            const name = newTrigger;
            newTrigger = '';
            await save({ ...setup(), triggers: [...list, { name, go: [], back: [] }] });
          },
        })));
  }

  function help() {
    return h('details', { class: 'aw-font-caption aw-text-tertiary' },
      h('summary', { text: 'How lines are written' }),
      h('div', { class: 'aw-flex-col aw-gap-row-mini', style: { marginTop: '0.4rem' } },
        h('div', { text: 'A line starts with a destination’s name; the rest is in that destination’s own words.' }),
        ...HELP.map(([k, v]) => h('div', {}, h('b', { text: `${k}: ` }), v))));
  }

  function activity() {
    const log = data().log || [];
    if (!log.length) return null;
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'What was sent' }),
      ...log.slice(0, 15).map((e) => h('div', {
        class: ['aw-font-caption', e.warn ? 'wru-warn' : ''],
        text: `${new Date(e.at).toLocaleTimeString()}  ${e.text}`,
      })));
  }

  return { render, busy };
}
