/*
 * Transitions — the panel: one destination, one card per fitted layer.
 *
 * The tab sits in the vendor's fixed-width side panel, so a layer is a card
 * rather than a table row: its effects in and out, and its windows as seconds
 * of the take with a bar under each. Under the cards, three ways to write
 * several layers at once — the same effect, a move worked out across the
 * screen, a saved style — each to the ticked layers only.
 *
 * ## The buffer, by role
 *
 * PRW by default. PGM is offered because which copy a CLOSING is read from is
 * one of the things no frame has answered, and finding out needs a way to
 * write the copy on air; it says so in a warning while it is chosen. Either
 * way the letter is resolved at the moment of writing, and nothing is written
 * mid-take, the same refusal the Layer tab makes.
 *
 * ## Seconds are a view
 *
 * The switcher keeps a window as a fraction of the take. Shown in seconds it
 * is only true for the take time it was read against, and a memory recall
 * replaces that time. So seconds are worked out on every render from the
 * screen's time as it is, and a typed time is turned into the switcher's
 * units against the time as it is when it is typed. Nothing keeps seconds.
 */

import { h, button, isEnter } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, presetBanks, sourceLabel } from '../../src/core/screens.js';
import { fittedLayers, bankLetter, readValue, layerSpec } from '../../src/core/properties.js';
import { layerLabel } from '../../src/core/layer-names.js';
import {
  FULL, ACROSS, MOVES, CASCADE_ORDERS, effectsOn, waysOn, takesWay, prettyEffect, prettyWay,
  takeTenths, secondsAt, unitsAt, readLook, lookWrites, planMove, styleOf, cleanLook, MAX_STYLE_NAME
} from '../../src/core/transitions.js';

const ROLES = [
  { id: 'PREVIEW', label: 'PRW' },
  { id: 'PROGRAM', label: 'PGM' }
];

const OPEN_COLOUR = '#00FF7F';
const CLOSE_COLOUR = '#F39910';

/**
 * @param {object} o
 * @param {object} o.session                 `store` and `send`
 * @param {() => object} o.styles             the style document, normalised
 * @param {(next: object) => void} o.setStyles
 * @param {() => object} [o.names]            layer names, `S1/2` → name
 * @param {Function} [o.onRefresh]
 */
export function createTransitionsPanel({ session, styles, setStyles, names = () => ({}), onRefresh = () => {} }) {
  const store = () => session.store;
  const view = {
    id: null,
    role: 'PREVIEW',
    skip: new Set(),
    brush: { openingType: '', openingWay: 'LEFT_TO_RIGHT', closingType: '', closingWay: 'LEFT_TO_RIGHT', speed: '' },
    move: { id: 'wipe', way: 'LEFT_TO_RIGHT', order: 'stack', overlap: '0', split: '50' },
    style: { name: '', from: '' },
    note: null
  };

  const say = (tone, text) => { view.note = { tone, text }; onRefresh(); };

  /* ---------------------------------------------------------- reading */

  /** Destinations in service whose layers this platform can address. */
  function destinations() {
    const s = store();
    if (!s || !s.ready) return [];
    const d = dialectFor(s);
    if (!d) return [];
    return listDestinations(s).filter((dest) => {
      const layers = fittedLayers(s, dest.id);
      return layers.length && d.layerParamPath(dest.id, presetBanks(s, dest.id).preview, layers[0].key, []);
    });
  }

  const current = (list) => list.find((d) => d.id === view.id) || list[0] || null;
  const ticked = (id) => fittedLayers(store(), id).map((l) => l.key).filter((k) => !view.skip.has(`${id}/${k}`));

  function shows(id, letter, key) {
    const spec = layerSpec(store(), 'source');
    const v = spec ? readValue(store(), { id, bank: letter, layer: key }, spec) : null;
    return v && v !== 'NONE' ? (sourceLabel(v, store()) || v) : null;
  }

  /* ---------------------------------------------------------- writing */

  /**
   * The letter `view.role` names on `id` right now, or a reason there is
   * none to write to: not reported yet, or mid-take.
   */
  function letterFor(id) {
    const b = bankLetter(store(), id, view.role);
    if (!b.reported) return { refused: `${id}: the switcher has not said which buffer is ${view.role === 'PROGRAM' ? 'program' : 'preview'}` };
    if (!b.settled) return { refused: `${id} is mid-take — nothing is written until it lands` };
    return { letter: b.letter };
  }

  /** Build writes for some layers and send them, saying what happened. */
  function apply(id, what, looksFor) {
    const at = letterFor(id);
    if (at.refused) { say('warn', at.refused); return; }
    const writes = looksFor(at.letter).flatMap(({ layer, look }) => (look ? lookWrites(store(), id, at.letter, layer, look) : []));
    if (!writes.length) { say('ok', `${what}: already so — nothing to write.`); return; }
    let sent = 0;
    for (const w of writes) if (session.send({ path: w.path, value: w.value })) sent++;
    const role = view.role === 'PROGRAM' ? 'program' : 'preview';
    say(sent === writes.length ? 'ok' : 'warn',
      `${what}: ${sent} of ${writes.length} write${writes.length === 1 ? '' : 's'} sent to ${id} ${role} (${at.letter}).`);
  }

  const setOne = (id, key, look, what) => apply(id, what, () => [{ layer: key, look }]);

  /* ---------------------------------------------------------- controls */

  const select = (key, choices, current, onPick, attrs = {}) => h('select', {
    class: 'wru-input', 'data-lpp-key': key, onChange: (ev) => onPick(ev.target.value), ...attrs
  }, choices.map((c) => h('option', { value: c.id, selected: c.id === current ? 'selected' : null, text: c.label })));

  const labelled = (label, control) => h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { minWidth: '0' } },
    h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  /** A number field committed on Enter or leaving it, never on each keystroke. */
  const field = (key, value, onCommit, attrs = {}) => h('input', {
    class: 'wru-input wru-input--narrow', value, inputmode: 'decimal', 'data-lpp-key': key,
    onKeyDown: (ev) => { if (isEnter(ev)) { ev.preventDefault(); ev.target.blur(); } },
    onChange: (ev) => onCommit(ev.target.value.trim()),
    ...attrs
  });

  const effects = () => effectsOn(store()).map((v) => ({ id: v, label: prettyEffect(v) }));
  const ways = () => waysOn(store()).map((v) => ({ id: v, label: prettyWay(v) }));

  /* ---------------------------------------------------------- rendering */

  function render() {
    const s = store();
    const list = destinations();
    const dest = current(list);
    if (dest) view.id = dest.id;
    return panel({
      toolbar: h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Transitions' }),
        h('span', { class: ['wru-tag', 'wru-tag--warn'], text: 'experimental' }),
        list.length ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-margin-left-auto' },
          select('tr-dest', list.map((d) => ({ id: d.id, label: d.label ? `${d.id} — ${d.label}` : d.id })), view.id,
            (v) => { view.id = v; view.note = null; onRefresh(); }, { 'aria-label': 'Screen or aux' }),
          select('tr-role', ROLES, view.role, (v) => { view.role = v; onRefresh(); }, { 'aria-label': 'Buffer' })) : null),
      body: h('div', { class: 'aw-flex-col aw-gap-row-big' },
        h('div', { class: ['wru-console-row', 'wru-console-warn', 'aw-font-caption'],
          text: 'Experimental: the switcher takes all of this and reports it back, but no frame has been seen to show it. '
            + 'Try it on a simulator or a spare box, and tell me what a real output does.' }),
        view.note ? h('div', { class: ['wru-console-row', 'wru-console-' + view.note.tone], text: view.note.text }) : null,
        !s || !s.ready ? h('div', { class: 'aw-text-tertiary', text: 'Waiting for the device store…' }) : null,
        s && s.ready && !list.length ? h('div', { class: 'aw-text-tertiary', text: 'No screen or aux in service has a layer this switcher lets me address.' }) : null,
        dest ? destBody(dest) : null)
    });
  }

  function destBody(dest) {
    const id = dest.id;
    const tenths = takeTenths(store(), id);
    const b = bankLetter(store(), id, view.role);
    const live = view.role === 'PROGRAM';
    return [
      live ? h('div', { class: ['wru-console-row', 'wru-console-warn', 'aw-font-caption'],
        text: 'PGM is the buffer on air. These are settings for the next take rather than the picture, but no frame has confirmed '
          + 'that writing them here leaves the output alone.' }) : null,
      !b.settled ? h('div', { class: ['wru-console-row', 'wru-console-warn'], text: `${id} is mid-take — nothing is written until it lands.` }) : null,
      h('div', { class: 'aw-font-caption aw-text-tertiary',
        text: Number.isFinite(tenths)
          ? `${id}’s take time is ${(tenths / 10).toFixed(1)} s. The seconds below are fractions of it, so a memory recall that changes it changes them too.`
          : `${id} has not reported a take time, so windows are shown as fractions of the take.` }),
      fittedLayers(store(), id).map((l) => layerCard(id, l.key, b.letter, tenths)),
      brushCard(id),
      movesCard(id),
      stylesCard(id)
    ];
  }

  /* ---------------------------------------------------------- a layer */

  function layerCard(id, key, letter, tenths) {
    const look = readLook(store(), id, letter, key);
    const label = layerLabel(names(), id, key);
    const on = !view.skip.has(`${id}/${key}`);
    const shown = shows(id, letter, key);
    const k = (f) => `tr-${id}-${key}-${f}`;
    const side = (which) => {
      const s = look[which];
      return h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-caption aw-text-tertiary', style: { width: '3.5rem' }, text: which === 'opening' ? 'In' : 'Out' }),
        select(k(which + '-type'), withCurrent(effects(), s.type, prettyEffect), s.type || '',
          (v) => setOne(id, key, { [which]: { type: v } }, `${label} ${which === 'opening' ? 'in' : 'out'}: ${prettyEffect(v)}`),
          { 'aria-label': `${label} ${which} effect` }),
        takesWay(s.type) ? select(k(which + '-way'), withCurrent(ways(), s.way, prettyWay), s.way || '',
          (v) => setOne(id, key, { [which]: { way: v } }, `${label} ${which === 'opening' ? 'in' : 'out'}: ${prettyWay(v)}`),
          { 'aria-label': `${label} ${which} direction` }) : null);
    };
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-small', 'data-lpp-transition-layer': `${id}/${key}` },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        h('input', {
          type: 'checkbox', checked: on ? 'checked' : null, 'aria-label': `Include ${label}`,
          onChange: (ev) => { if (ev.target.checked) view.skip.delete(`${id}/${key}`); else view.skip.add(`${id}/${key}`); onRefresh(); }
        }),
        h('div', { class: 'aw-font-body-1-bold', text: label }),
        h('div', { class: 'aw-font-caption aw-text-tertiary aw-margin-left-auto', text: shown || 'nothing' })),
      side('opening'),
      side('closing'),
      windowRow(id, key, label, 'opening', look.window.opening, tenths),
      windowRow(id, key, label, 'closing', look.window.closing, tenths));
  }

  /** One window: its two edges as fields, and a bar of where it sits in the take. */
  function windowRow(id, key, label, which, w, tenths) {
    const start = Number.isFinite(w.start) ? w.start : 0;
    const end = Number.isFinite(w.end) ? w.end : FULL;
    const timed = Number.isFinite(tenths) && tenths > 0;
    const show = (u) => (timed ? secondsAt(u, tenths).toFixed(2) : `${Math.round((u / FULL) * 100)}%`);
    /* The take time and the other edge as they are when the edit is committed,
       not when the card was drawn: that is the time the typed seconds mean. */
    const commit = (edge) => (text) => {
      const t = takeTenths(store(), id);
      if (!Number.isFinite(t) || t <= 0) { say('warn', 'With no take time to measure against, windows cannot be typed in seconds.'); return; }
      const u = unitsAt(text, t);
      if (u == null) { say('warn', `“${text}” is not a number of seconds.`); return; }
      const at = bankLetter(store(), id, view.role);
      const was = readLook(store(), id, at.letter, key).window[which];
      const next = {
        start: Number.isFinite(was.start) ? was.start : 0,
        end: Number.isFinite(was.end) ? was.end : FULL,
        [edge]: u
      };
      if (next.start > next.end) { say('warn', `${label}: a window cannot end before it starts.`); return; }
      setOne(id, key, { window: { [which]: { [edge]: u } } }, `${label} ${which === 'opening' ? 'in' : 'out'} window`);
    };
    const colour = which === 'opening' ? OPEN_COLOUR : CLOSE_COLOUR;
    const pct = (u) => `${(u / FULL) * 100}%`;
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        h('div', { class: 'aw-font-caption aw-text-tertiary', style: { width: '3.5rem' }, text: which === 'opening' ? 'Opens' : 'Closes' }),
        field(`tr-${id}-${key}-${which}-start`, show(start), commit('start'), { 'aria-label': `${label} ${which} starts`, disabled: timed ? null : 'disabled' }),
        h('span', { class: 'aw-text-tertiary', text: '–' }),
        field(`tr-${id}-${key}-${which}-end`, show(end), commit('end'), { 'aria-label': `${label} ${which} ends`, disabled: timed ? null : 'disabled' }),
        timed ? h('span', { class: 'aw-font-caption aw-text-tertiary', text: 's' }) : null),
      h('div', { class: 'wru-bar', title: `${which === 'opening' ? 'Opens' : 'Closes'} from ${show(start)} to ${show(end)}` },
        h('span', { style: { width: pct(start), background: 'transparent' } }),
        h('span', { style: { width: pct(Math.max(0, end - start)), background: colour } })));
  }

  /* ---------------------------------------------------------- several at once */

  function brushCard(id) {
    const br = view.brush;
    const set = (patch) => { view.brush = { ...view.brush, ...patch }; onRefresh(); };
    const leave = { id: '', label: 'Leave' };
    const speeds = [leave, { id: 'LINEAR', label: 'Linear' }, { id: 'SMOOTH', label: 'Smooth' }];
    const count = ticked(id).length;
    /* Read at the moment it is asked, not when the card was drawn: a button
       from the last repaint can still take the click after a choice changed. */
    const look = () => {
      const now = view.brush;
      const side = (type, way) => (type ? (takesWay(type) ? { type, way } : { type }) : null);
      return cleanLook({ opening: side(now.openingType, now.openingWay), closing: side(now.closingType, now.closingWay), speed: now.speed || null });
    };
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-1', text: 'The same on every ticked layer' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
        labelled('In', select('tr-brush-in', [leave, ...effects()], br.openingType, (v) => set({ openingType: v }))),
        takesWay(br.openingType) ? labelled('Direction', select('tr-brush-in-way', ways(), br.openingWay, (v) => set({ openingWay: v }))) : null),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
        labelled('Out', select('tr-brush-out', [leave, ...effects()], br.closingType, (v) => set({ closingType: v }))),
        takesWay(br.closingType) ? labelled('Direction', select('tr-brush-out-way', ways(), br.closingWay, (v) => set({ closingWay: v }))) : null,
        labelled('Speed', select('tr-brush-speed', speeds, br.speed, (v) => set({ speed: v })))),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button(`Apply to ${count} layer${count === 1 ? '' : 's'}`, {
          disabled: !count || !look(),
          title: look() ? 'Write these to every ticked layer’s copy in the buffer chosen above' : 'Choose something to change first',
          onClick: () => {
            const l = look();
            if (l) apply(id, 'Applied', () => ticked(id).map((layer) => ({ layer, look: l })));
          }
        })));
  }

  function movesCard(id) {
    const m = view.move;
    const set = (patch) => { view.move = { ...view.move, ...patch }; onRefresh(); };
    const chosen = MOVES.find((x) => x.id === m.id) || MOVES[0];
    const percent = (text, lo, hi) => {
      const n = Number(String(text).replace('%', '').trim());
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) / 100 : null;
    };
    const options = {
      wipe: () => labelled('Direction', select('tr-move-way', ACROSS.map((v) => ({ id: v, label: prettyWay(v) })), m.way, (v) => set({ way: v }))),
      cascade: () => [
        labelled('Order', select('tr-move-order', CASCADE_ORDERS, m.order, (v) => set({ order: v }))),
        labelled('Overlap (%)', field('tr-move-overlap', m.overlap, (v) => set({ overlap: v })))],
      dip: () => labelled('Closed by (%)', field('tr-move-split', m.split, (v) => set({ split: v }))),
      reset: () => null
    };
    /* The move and its options as they are when the button is pressed. */
    const run = () => {
      const now = view.move;
      const move = MOVES.find((x) => x.id === now.id) || MOVES[0];
      const opts = { way: now.way, order: now.order, overlap: percent(now.overlap, 0, 90) ?? 0, split: percent(now.split, 10, 90) ?? 0.5 };
      const plan = planMove(store(), id, move.id, opts);
      if (plan.refused) { say('warn', plan.refused); return; }
      const keep = new Set(ticked(id));
      const looks = plan.looks.filter((l) => keep.has(l.layer));
      if (!looks.length) { say('warn', `${move.label}: none of the ticked layers shows anything to move.`); return; }
      apply(id, move.label, () => looks);
    };
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Across the screen' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
        labelled('Move', select('tr-move', MOVES.map((x) => ({ id: x.id, label: x.label })), chosen.id, (v) => set({ id: v }))),
        options[chosen.id]()),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: chosen.what }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        button('Apply to the ticked layers', { disabled: !ticked(id).length, onClick: run })));
  }

  /* ---------------------------------------------------------- styles */

  function stylesCard(id) {
    const doc = styles();
    const keys = fittedLayers(store(), id).map((l) => l.key);
    const fromNow = () => (keys.includes(view.style.from) ? view.style.from : (ticked(id)[0] || keys[0]));
    const from = fromNow();
    const save = () => {
      const name = view.style.name.trim().slice(0, MAX_STYLE_NAME);
      if (!name) { say('warn', 'Give the style a name first.'); return; }
      const at = letterFor(id);
      if (at.refused) { say('warn', at.refused); return; }
      const from = fromNow();
      const current = styles();
      const look = styleOf(readLook(store(), id, at.letter, from));
      if (!look) { say('warn', `${layerLabel(names(), id, from)} has no transition to keep.`); return; }
      const others = current.styles.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
      setStyles({ ...current, styles: [...others, { name, look }] });
      view.style = { ...view.style, name: '' };
      say('ok', `Saved “${name}” from ${layerLabel(names(), id, from)}.`);
    };
    return h('div', { class: 'wru-groups-card aw-padding-medium aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Styles' }),
      doc.styles.length
        ? doc.styles.map((s) => h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
          h('div', { class: 'aw-flex-col', style: { flex: '1 1 8rem', minWidth: '0' } },
            h('div', { class: 'aw-font-body-1-bold', text: s.name }),
            h('div', { class: 'aw-font-caption aw-text-tertiary', text: describe(s.look) })),
          button('Apply', {
            disabled: !ticked(id).length,
            title: 'Write this style to every ticked layer',
            onClick: () => apply(id, `“${s.name}”`, () => ticked(id).map((layer) => ({ layer, look: s.look })))
          }),
          button('×', {
            variant: 'ghost', title: `Delete “${s.name}”`,
            onClick: () => { const now = styles(); setStyles({ ...now, styles: now.styles.filter((x) => x.name !== s.name) }); }
          })))
        : h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'None yet. Set a layer up the way you want it and keep it as a style.' }),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        labelled('Keep', select('tr-style-from', keys.map((k) => ({ id: k, label: layerLabel(names(), id, k) })), from,
          (v) => { view.style = { ...view.style, from: v }; onRefresh(); })),
        labelled('as', h('input', {
          class: 'wru-input', value: view.style.name, maxlength: String(MAX_STYLE_NAME), placeholder: 'Style name',
          'data-lpp-key': 'tr-style-name', 'aria-label': 'Style name',
          onKeyDown: (ev) => { if (isEnter(ev)) { ev.preventDefault(); view.style = { ...view.style, name: ev.target.value }; save(); } },
          onChange: (ev) => { view.style = { ...view.style, name: ev.target.value }; }
        })),
        button('Save', { onClick: save })));
  }

  return {
    render,
    busy: () => false
  };
}

/**
 * A choice list that always holds the value the field has, even one not on
 * offer — and a blank when the mirror has none, rather than showing the first
 * choice as if the layer held it.
 */
function withCurrent(choices, current, pretty) {
  if (!current) return [{ id: '', label: '—' }, ...choices];
  if (choices.some((c) => c.id === current)) return choices;
  return [...choices, { id: current, label: `${pretty(current)} (not offered)` }];
}

/** A style in a line: "In: wipe left to right · Out: fade · opens 0–50% · linear". */
export function describe(look) {
  if (!look) return '';
  const side = (s) => (s ? `${prettyEffect(s.type).toLowerCase()}${s.way && takesWay(s.type) ? ' ' + prettyWay(s.way).toLowerCase() : ''}` : null);
  const pct = (w) => `${Math.round((w.start / FULL) * 100)}–${Math.round((w.end / FULL) * 100)}%`;
  return [
    look.opening ? `In: ${side(look.opening)}` : null,
    look.closing ? `Out: ${side(look.closing)}` : null,
    look.window && look.window.opening ? `opens ${pct(look.window.opening)}` : null,
    look.window && look.window.closing ? `closes ${pct(look.window.closing)}` : null,
    look.speed ? look.speed.toLowerCase() : null
  ].filter(Boolean).join(' · ');
}
