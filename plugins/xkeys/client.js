/*
 * X-keys — the plugin's page half.  ** PREVIEW **
 *
 * One card on this app's settings page: the switch, what the panel is doing,
 * and its keys, laid out as they sit on the panel, each with its job. Pick a
 * key — on the card, or by pressing it on the panel while it is driven — and
 * give it a job; the layout is saved per model as it changes. It follows the
 * server over `/__lpp/xkeys/stream`. Nothing here drives the panel: the
 * server does, with or without this page open.
 */

import { MODELS, productOf, keysOf, lampsOf } from '../../src/core/xkeys.js';
import {
  JOBS, jobOf, legendOf, normaliseXkeys, normaliseBinding, layoutFor, suggestedLayout,
} from './core.js';

/* While driven or not, the panel's state is fetched this often when no stream brings it. */
const POLL_MS = 3000;

const LIGHTS = Object.freeze({
  rgb: 'any colour',
  two: 'blue and red',
  blue: 'blue only',
  none: 'no backlights',
});

export default function activate(ctx) {
  const { h, readout, card, note, picker, button } = ctx.kit;

  let settings = normaliseXkeys(ctx.settings.get());
  let live = null;
  let saving = false;
  let error = null;
  let stream = null;
  let poll = null;
  let asked = false;
  /* The model on the card — the operator's pick, else the one plugged in —
     and the key being edited on it. */
  let chosen = null;
  let model = null;
  let picked = null;
  let lastHeld = new Set();
  /* The poll runs only while the card has been drawn lately: the settings page is open. */
  let drawnAt = 0;

  async function load() {
    try {
      const res = await fetch(ctx.url('/state'), { cache: 'no-store' });
      if (res.ok) take(await res.json());
    } catch { /* the card draws from the settings alone */ }
    ctx.refresh();
  }

  /** A new snapshot: a key newly held on the panel is the one picked. */
  function take(next) {
    live = next;
    const held = new Set((next && next.held) || []);
    if (next && next.model && next.model === model) {
      for (const k of held) if (!lastHeld.has(k)) picked = k;
    }
    lastHeld = held;
  }

  /* An input being typed into is not redrawn under the cursor. */
  const editing = () => !!(globalThis.document && document.activeElement && document.activeElement.dataset
    && document.activeElement.dataset.xkeysEdit);

  function listen() {
    if (stream || typeof EventSource === 'undefined') return;
    try {
      stream = new EventSource(ctx.url('/stream'));
      stream.addEventListener('panel', (ev) => {
        try { take(JSON.parse(ev.data)); if (!editing()) ctx.refresh(); } catch { /* one bad frame is not worth the card */ }
      });
    } catch { /* no EventSource: the poll still brings it */ }
    /* The stream speaks while the panel is driven; the poll finds a panel plugged in while it is not. */
    poll = setInterval(() => {
      if (!settings.xkeysEnabled && !editing() && Date.now() - drawnAt < 3 * POLL_MS) void load();
    }, POLL_MS);
  }

  async function put(patch) {
    saving = true;
    error = null;
    ctx.refresh();
    try {
      settings = normaliseXkeys(await ctx.settings.set(patch));
    } catch (err) {
      error = err.message;
    }
    saving = false;
    await load();
  }

  /** Save this model's whole layout. */
  function saveLayout(keys) {
    return put({ xkeysLayouts: { ...settings.xkeysLayouts, [model]: keys } });
  }

  function setKey(index, binding) {
    const product = productOf(model);
    const { keys } = layoutFor(settings, product);
    const next = { ...keys };
    const b = normaliseBinding(binding);
    if (b) next[index] = b; else delete next[index];
    return saveLayout(next);
  }

  function panelLine(p) {
    if (!p) return { text: 'no device host', tone: 'tertiary' };
    const name = p.product || 'X-keys';
    if (p.connected && p.ready) return { text: `${name} connected${p.unitId ? `, unit ${p.unitId}` : ''}`, tone: null };
    if (p.connected) return { text: `${name} found, not answered yet`, tone: 'warn' };
    if (p.present) return { text: `${name} found, not held`, tone: 'tertiary' };
    if (!p.available) return { text: 'not available', tone: 'tertiary' };
    return { text: 'not found', tone: 'tertiary' };
  }

  function tallyLine(t) {
    if (!t) return '—';
    const word = (s) => (s ? `${{ LIVE: 'IN', STILL: 'STILL', SCREEN: 'S' }[s.kind]} ${s.number}` : 'nothing');
    return `layer ${t.layer}: ${word(t.program)} on air, ${word(t.preview)} in preview`;
  }

  /* ------------------------------------------------------------ the keys */

  function grid(product, keys) {
    const all = keysOf(product);
    const ps = all.find((k) => k.index === 0);
    const placed = all.filter((k) => k.index !== 0);
    const minRow = Math.min(...placed.map((k) => k.row));
    const minCol = Math.min(...placed.map((k) => k.col));
    const cols = Math.max(...placed.map((k) => k.col)) - minCol + 1;
    const held = new Set(live && live.model === product.model ? live.held || [] : []);
    const cell = (k) => {
      const b = keys[k.index];
      const legend = legendOf(b);
      const on = picked === k.index;
      return h('button', {
        type: 'button',
        title: `${k.index === 0 ? 'Program switch' : `Key ${k.index}`}${b ? ` — ${jobOf(b.do).label}` : ''}`,
        class: ['wru-button', 'aw-border-radius', 'aw-font-caption', on ? 'wru-button--active' : 'wru-button--default'],
        style: {
          gridRow: k.index === 0 ? null : String(k.row - minRow + 1),
          gridColumn: k.index === 0 ? null : String(k.col - minCol + 1),
          minWidth: '3.25rem', height: '2.75rem', padding: '0 0.25rem', overflow: 'hidden',
          outline: held.has(k.index) ? '2px solid var(--aw-color-primary, #2f80ed)' : null,
          opacity: b ? null : '0.55',
        },
        onClick: () => { picked = on ? null : k.index; ctx.refresh(); },
      }, h('span', { text: legend || (k.index === 0 ? 'PS' : String(k.index)) }));
    };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      ps ? h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        cell(ps), h('span', { class: 'aw-font-caption aw-text-tertiary', text: 'the program switch' })) : null,
      h('div', {
        style: { display: 'grid', gridTemplateColumns: `repeat(${cols}, minmax(3.25rem, max-content))`, gap: '0.25rem', overflowX: 'auto' },
      }, placed.map(cell)));
  }

  function editor(product, keys) {
    if (picked === null || !keysOf(product).some((k) => k.index === picked)) {
      return note('info', 'Pick a key to give it a job — click it here, or press it on the panel while it is driven.');
    }
    const index = picked;
    const b = keys[index] || { do: 'none' };
    const job = jobOf(b.do) || jobOf('none');
    const choices = JOBS.map((j) => ({ id: j.id, label: j.label, what: j.what }));
    const extra = () => {
      if (job.needs === 'number') {
        return h('label', { class: 'aw-flex-col aw-gap-row-mini' },
          h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Number' }),
          h('input', {
            type: 'number', min: '1', max: '999', step: '1', class: 'wru-input', style: { width: '6rem' },
            value: String(b.n || 1), dataset: { xkeysEdit: '1' },
            disabled: saving ? 'disabled' : null,
            onChange: (ev) => setKey(index, { do: job.id, n: Number(ev.target.value) }),
          }));
      }
      if (job.needs === 'destination') {
        const screens = (live && live.switcher && live.switcher.screens) || [];
        const ids = screens.length ? screens.map((s) => s.id) : Array.from({ length: 8 }, (_, i) => `S${i + 1}`);
        if (b.id && !ids.includes(b.id)) ids.unshift(b.id);
        return h('label', { class: 'aw-flex-col aw-gap-row-mini' },
          h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Screen' }),
          h('select', {
            class: 'wru-input', style: { width: '10rem' }, disabled: saving ? 'disabled' : null,
            onChange: (ev) => setKey(index, { do: job.id, id: ev.target.value }),
          }, ids.map((id) => {
            const s = screens.find((x) => x.id === id);
            return h('option', { value: id, selected: id === (b.id || ids[0]) ? 'selected' : null, text: s && s.label ? `${id} — ${s.label}` : id });
          })));
      }
      return null;
    };
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-body-1-bold', text: index === 0 ? 'The program switch' : `Key ${index}` }),
      h('div', { class: 'aw-flex-row aw-gap-col-medium aw-flex-wrap', style: { alignItems: 'flex-start' } },
        picker('Job', choices, job.id, (id) => {
          const next = jobOf(id);
          if (!next || next.id === 'none') return setKey(index, null);
          if (next.needs === 'number') return setKey(index, { do: id, n: b.n || 1 });
          if (next.needs === 'destination') {
            const first = (live && live.switcher && live.switcher.screens && live.switcher.screens[0]) || { id: 'S1' };
            return setKey(index, { do: id, id: b.id || first.id });
          }
          return setKey(index, { do: id });
        }, { disabled: saving }),
        extra()));
  }

  /* --------------------------------------------------------------- render */

  function render() {
    if (!asked) { asked = true; void load(); }
    drawnAt = Date.now();
    listen();
    const on = settings.xkeysEnabled;
    const p = live && live.panel;
    const line = panelLine(p);
    model = chosen || (p && p.model) || Object.keys(settings.xkeysLayouts)[0] || 'XK24';
    const product = productOf(model) || productOf('XK24');
    const { keys, suggested } = layoutFor(settings, product);

    const toggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox',
        checked: on ? 'checked' : null,
        disabled: saving ? 'disabled' : null,
        onChange: (ev) => put({ xkeysEnabled: ev.target.checked }),
      }),
      h('span', { class: 'aw-font-body-1', text: 'Drive an X-keys' }));

    const readouts = live
      ? h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        readout('Panel', line.text, { tone: line.tone }),
        on ? readout('Driving', (live.selection && live.selection.destinations.join(' ')) || 'nothing',
          { tone: live.selection && live.selection.destinations.length ? null : 'tertiary' }) : null,
        on ? readout('Layer', live.selection ? String(live.selection.layer) : '—') : null,
        on ? readout('Tally', tallyLine(live.tally), { tone: live.tally ? null : 'tertiary' }) : null)
      : null;

    const models = MODELS.map((m) => ({
      id: m.model,
      label: `${m.name}${p && p.model === m.model ? ' — plugged in' : ''}`,
      what: `${keysOf(m).length} keys, ${LIGHTS[lampsOf(m)]}${m.hasTbar ? ', a T-bar' : ''}${m.hasJog ? ', jog and shuttle (no job yet)' : ''}.`,
    }));
    const layoutTools = h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
      suggested ? button('Keep this layout', { onClick: () => saveLayout(keys), disabled: saving }) : null,
      button('Start from the suggestion', { onClick: () => saveLayout(suggestedLayout(product)), disabled: saving || suggested }),
      button('Clear every key', { onClick: () => saveLayout({}), disabled: saving || (!suggested && !Object.keys(keys).length) }));

    const notes = [];
    if (error) notes.push(note('warn', error));
    notes.push(note('warn',
      'Preview. This has never been run against a panel. It reads and lights X-keys the way Bitfocus Companion does '
      + '(SuperFly.tv\'s xkeys library, checked against that library\'s recordings of real panels), and has only been '
      + 'tested against a pretend panel and, on Linux, a virtual one. Treat the first show with one as a rehearsal.'));
    if (on && p && !p.available && p.reason) notes.push(note('warn', p.reason));
    if (on && live && live.host && !live.host.running) {
      notes.push(note('warn', live.host.reason || 'The device host is not running, so nothing here can hold a USB panel.'));
    }
    if (on && p && p.error && !(p.connected && p.ready)) notes.push(note('warn', p.error));
    if (p && p.others) notes.push(note('warn', `${p.others} more X-keys found: only the first one is driven.`));
    if (suggested) {
      notes.push(note('info', `A suggested layout for the ${product.name}: nothing is saved yet, and the panel runs this until it is. `
        + 'Change any key, or Keep this layout, to save it.'));
    }
    if (on) {
      notes.push(note('info',
        'Turn the panel off in Bitfocus Companion (or MacroWorks) on this machine while this is on: they hear the same '
        + 'keys, so every press would act there as well. Source keys show red while on air and blue (green on an RGB '
        + 'panel) while in preview, on the selected layer of the screen driven; a blue-only panel shows on air steady '
        + 'and preview flashing. The green lamp is steady while the '
        + 'switcher answers; the red one flashes when a press was refused — the history below says why.'));
    }
    const history = live && live.history && live.history.length
      ? h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        live.history.slice(0, 5).map((e) => h('div', {
          class: ['aw-font-caption', e.error ? 'wru-warn' : 'aw-text-tertiary'],
          text: [e.key, e.note || e.error || e.kind].filter(Boolean).join(' — '),
        })))
      : null;

    /* In a row, as every card's pickers are: in the card's column, the picker's flex basis would be its height. */
    return card('X-keys',
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        toggle,
        picker('Lay out', models, product.model, (id) => { chosen = id; model = id; picked = null; ctx.refresh(); })),
      readouts,
      grid(product, keys),
      editor(product, keys),
      layoutTools,
      history, ...notes);
  }

  ctx.ui.settingsSection({ id: 'xkeys', order: 13, render });
}
