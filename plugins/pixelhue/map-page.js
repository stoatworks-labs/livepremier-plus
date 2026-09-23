/*
 * Pixelhue Mapping — the console drawn as the vendor draws its own RC400T,
 * with what every control does here written on it.  ** PREVIEW **
 *
 * Lives under Virtual RC400T, beside MIDI Mapping, for the reason MIDI
 * Mapping does: that is where an operator goes to think about control
 * surfaces. And it borrows that page's look on purpose — the chassis, the
 * key caps, the lit-key gradients and the section headings are the Virtual
 * RC400T's own, read off its stylesheet — so a U5 on this page reads as
 * another of the switcher's panels rather than as somebody else's app.
 *
 * What it shows:
 *
 *  - **the buses** as the console itself shows them: each key's text and lamp
 *    come from the key states the console pushes (the supervisor mirrors
 *    them), so a label here is what is on the panel, not what this app thinks
 *    it published;
 *  - **every mapped control** with its action as the key's legend, a dot
 *    where it differs from the default, and an inspector that changes it;
 *  - **a press on the console** lights the key here and opens it in the
 *    inspector, which is the quickest way to find out which key is which.
 *
 * The table itself is `mapping.js`; the drawing is `layout.js`. This file
 * owns neither.
 */

import { U5, BUS_WHAT } from './layout.js';
import {
  KEY_ACTIONS, PARAM_ACTIONS, controlById, actionsFor, actionOf, legendOf, describeAction, normaliseMap,
} from './mapping.js';
import { COMMAND } from './core.js';

const STYLE_ID = 'lpp-pixelhue-map-styles';
/* How long a press on the console stays lit here. */
const PRESS_FLASH_MS = 700;

const COMMAND_NAME = Object.fromEntries(Object.entries(COMMAND).map(([k, v]) => [v, k]));

/**
 * @param {object} o
 * @param {object} o.ctx           the plugin's page context
 * @param {() => object} o.settings the plugin's settings now
 * @param {() => object|null} o.live the console link as `/state` last said
 * @param {(patch: object) => Promise<void>} o.put save settings
 */
export function createMapPage({ ctx, settings, live, put }) {
  const { h, panel, note } = ctx.kit;
  const layout = U5;
  const state = {
    selected: null,           // { key } | { control } | { motion } | { tbar: true }
    clusterPage: 0,
    seenPress: 0,
    draft: null,              // an unsaved parameter, e.g. { control, prefix, value }
    saving: false,
    error: null,
  };

  function styles() {
    if (document.getElementById(STYLE_ID)) return;
    const el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    document.head.append(el);
  }

  /* ------------------------------------------------------------ saving */

  async function assign(controlId, action) {
    const map = { ...(settings().pixelhueMap || {}) };
    map[controlId] = action;
    await save(normaliseMap(map));
  }

  async function save(map) {
    state.saving = true;
    state.error = null;
    ctx.refresh();
    try {
      await put({ pixelhueMap: map });
    } catch (err) {
      state.error = err.message;
    }
    state.saving = false;
    state.draft = null;
    ctx.refresh();
  }

  /* ------------------------------------------------------------ helpers */

  const pct = (v, of) => `${(v / of) * 100}%`;
  const box = (x, y, w, hh) => ({
    left: pct(x, layout.width), top: pct(y, layout.height), width: pct(w, layout.width), height: pct(hh, layout.height),
  });

  function controlOfKey(k) {
    if (k.kind === 'control') return controlById(k.control);
    if (k.kind === 'cluster') {
      const id = layout.clusterPages[state.clusterPage].slots[k.slot];
      return id ? controlById(id) : null;
    }
    return null;
  }

  function isSelected(sel) {
    const s = state.selected;
    if (!s || !sel) return false;
    return Object.keys(sel).every((k) => s[k] === sel[k]);
  }

  /** The lamp a bus key shows, from the console's own state code. */
  function busLamp(bus, code) {
    if (bus === 'screen') return code === 204 ? 'yellow' : code === 202 ? 'yellow-low' : null;
    if (bus === 'layer') return code === 302 ? 'green' : null;
    return null;
  }

  /* ------------------------------------------------------------ drawing */

  function keyCap({ lamp, legend, sub, dim, changed, pressed, selected, tall, onClick, title }) {
    return h('button', {
      type: 'button',
      class: [
        'lpp-ph-key',
        lamp ? `lpp-ph-key--${lamp}` : 'lpp-ph-key--off',
        dim ? 'lpp-ph-key--dim' : null,
        pressed ? 'lpp-ph-key--pressed' : null,
        selected ? 'lpp-ph-key--selected' : null,
        tall ? 'lpp-ph-key--tall' : null,
      ],
      title: title || null,
      onClick,
    },
    h('span', { class: 'lpp-ph-key__rect' }),
    h('span', { class: 'lpp-ph-key__overlay' }),
    h('span', { class: 'lpp-ph-key__ellipse' }),
    h('span', { class: 'lpp-ph-key__legend', text: legend || '' }),
    sub ? h('span', { class: 'lpp-ph-key__sub', text: sub }) : null,
    changed ? h('span', { class: 'lpp-ph-key__changed', title: 'Changed from the default' }) : null);
  }

  function drawKey(k, now) {
    const info = live();
    const shown = info && info.keys ? info.keys[k.key] : null;
    const press = info && info.lastPress;
    const pressed = press && press.key === k.key && now - press.at < PRESS_FLASH_MS;
    const map = settings().pixelhueMap || {};
    const style = box(k.x, k.y, k.w, k.h);
    let cap;

    if (k.kind === 'bus') {
      const text = shown && shown.text ? shown.text : '';
      cap = keyCap({
        lamp: busLamp(k.bus, shown && shown.state),
        legend: text || String(k.position),
        dim: !text,
        pressed,
        selected: isSelected({ key: k.key }),
        title: `${k.bus} bus, position ${k.position}`,
        onClick: () => select({ key: k.key }),
      });
    } else if (k.kind === 'control' || k.kind === 'cluster') {
      const c = controlOfKey(k);
      if (!c) {
        cap = keyCap({ legend: '', dim: true, pressed, selected: isSelected({ key: k.key }), onClick: () => select({ key: k.key }) });
      } else {
        const action = actionOf(map, c);
        cap = keyCap({
          lamp: k.lamp ? `${k.lamp}-low` : null,
          legend: legendOf(action),
          dim: action === 'none',
          changed: action !== c.default || (k.also && actionOf(map, k.also) !== controlById(k.also).default),
          pressed,
          selected: isSelected({ control: c.id }),
          title: `${c.label} — ${describeAction(action)}`,
          onClick: () => select({ control: c.id, key: k.key }),
        });
      }
    } else if (k.kind === 'clusterPage') {
      const page = layout.clusterPages[state.clusterPage];
      cap = keyCap({
        legend: `PAGE ${state.clusterPage + 1}`,
        sub: page.label,
        tall: true,
        pressed,
        title: 'Pages the cluster on the left. Click to see what its keys do on each page.',
        onClick: () => { state.clusterPage = (state.clusterPage + 1) % layout.clusterPages.length; ctx.refresh(); },
      });
    } else {
      cap = keyCap({
        legend: k.label, dim: !k.label, pressed,
        selected: isSelected({ key: k.key }),
        onClick: () => select({ key: k.key }),
      });
    }

    const silk = silkFor(k);
    const same = silk && cap.textContent.replace(/\W/g, '') === silk.replace(/\W/g, '');
    return h('div', { class: 'lpp-ph-slot', style }, cap, silk && !same ? h('span', { class: 'lpp-ph-silk', text: silk }) : null);
  }

  /** The legend printed on the chassis under a key: the key's own name. */
  function silkFor(k) {
    if (k.kind === 'control') return controlById(k.control).label.replace(/ \(long press\)$/, '');
    if (k.kind === 'cluster') {
      const id = layout.clusterPages[state.clusterPage].slots[k.slot];
      return id ? controlById(id).label : '';
    }
    return '';
  }

  function drawBar(b) {
    const half = b.w / 2;
    return [
      h('div', { class: 'lpp-ph-bar', style: box(b.x, b.y, half - 4, 30) }, h('span', { text: b.left })),
      h('div', { class: 'lpp-ph-bar', style: box(b.x + half + 4, b.y, half - 4, 30) }, h('span', { text: b.right })),
    ];
  }

  function drawEncoder(e) {
    const map = settings().pixelhueMap || {};
    const c = controlById(e.id);
    const action = actionOf(map, c);
    return h('div', {
      class: ['lpp-ph-encoder', isSelected({ motion: e.id }) ? 'lpp-ph-encoder--selected' : null],
      style: box(e.x, e.y, e.w, e.h),
      title: `${c.label} — ${describeAction(action)}`,
      onClick: () => select({ motion: e.id }),
    },
    h('div', { class: 'lpp-ph-encoder__knob' }, h('div', { class: 'lpp-ph-encoder__cap' })),
    h('div', { class: ['lpp-ph-oled', action === 'none' ? 'lpp-ph-oled--dim' : null] },
      h('span', { text: legendOf(action) }),
      action !== c.default ? h('i', { class: 'lpp-ph-oled__changed' }) : null));
  }

  function drawFader(f, i) {
    const map = settings().pixelhueMap || {};
    const c = controlById(f.id);
    const action = actionOf(map, c);
    const legend = action === 'layerOpacity' ? `L${i + 1} OPAC` : legendOf(action);
    return h('div', {
      class: ['lpp-ph-fader', isSelected({ motion: f.id }) ? 'lpp-ph-fader--selected' : null],
      style: box(f.x - 20, f.y, f.w + 40, f.h + 58),
      title: `${c.label} — ${describeAction(action)}`,
      onClick: () => select({ motion: f.id }),
    },
    h('div', { class: 'lpp-ph-fader__track' }, h('div', { class: 'lpp-ph-fader__cap' })),
    h('div', { class: ['lpp-ph-oled', action === 'none' ? 'lpp-ph-oled--dim' : null] },
      h('span', { text: legend }),
      action !== c.default ? h('i', { class: 'lpp-ph-oled__changed' }) : null));
  }

  function drawTbar(t) {
    return h('div', {
      class: ['lpp-ph-tbar', isSelected({ tbar: true }) ? 'lpp-ph-tbar--selected' : null],
      style: box(t.x, t.y, t.w, t.h),
      onClick: () => select({ tbar: true }),
    },
    h('div', { class: 'lpp-ph-tbar__scale' },
      Array.from({ length: 12 }, () => h('i'))),
    h('div', { class: 'lpp-ph-tbar__track' }, h('div', { class: 'lpp-ph-tbar__handle' })),
    h('div', { class: 'lpp-ph-oled lpp-ph-tbar__label' }, h('span', { text: 'T-BAR' })));
  }

  function select(sel) {
    state.selected = sel;
    state.draft = null;
    ctx.refresh();
  }

  /* ------------------------------------------------------------ the inspector */

  function inspector() {
    const s = state.selected;
    if (!s) {
      return h('div', { class: 'lpp-ph-inspector' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Pick a control' }),
        h('div', { class: 'aw-font-caption aw-text-secondary', text:
          'Click a key, fader or encoder to see what it does here, and change it. '
          + 'Or press it on the console: it lights here and opens.' }));
    }
    if (s.control) return controlInspector(controlById(s.control), s.key);
    if (s.motion) return controlInspector(controlById(s.motion));
    if (s.tbar) {
      return h('div', { class: 'lpp-ph-inspector' },
        title('T-BAR', 'Fixed'),
        para('Drives the take on every selected screen: each stroke reads where each screen rests '
          + '(0 or 65535) and maps the lever’s travel from there, so a take from the TAKE key is still finished '
          + 'by the next throw, either way.'),
        para('LOCK T-BAR is the console’s own and silences it.'));
    }
    const k = layout.keys.find((x) => x.key === s.key);
    if (!k) return h('div', { class: 'lpp-ph-inspector' });
    if (k.kind === 'bus') {
      const info = live();
      const shown = info && info.keys ? info.keys[k.key] : null;
      return h('div', { class: 'lpp-ph-inspector' },
        title(`${cap(k.bus)} ${k.position}`, 'Bus key — from the model'),
        kv('Shows', shown && shown.text ? shown.text : 'nothing on this page'),
        kv('Key', String(k.key)),
        para(BUS_WHAT[k.bus]),
        para('A bus key is not mapped: the console is handed this switcher’s screens, layers, inputs '
          + 'and memories and labels its own keys from them, so what this key does is whatever sits at '
          + 'this position. Change the switcher and the panel follows.'));
    }
    if (k.kind === 'cluster') {
      return h('div', { class: 'lpp-ph-inspector' },
        title('—', `Cluster page ${state.clusterPage + 1}`),
        para('Nothing on this page of the cluster reports anything on a U5’s default layout, so there is nothing to map. '
          + 'Page with the tall PAGE key.'));
    }
    return h('div', { class: 'lpp-ph-inspector' },
      title(k.label || 'Unbound key', 'Fixed'),
      kv('Key', String(k.key)),
      para(k.what || ''));
  }

  function controlInspector(c, key) {
    const k = key != null ? layout.keys.find((x) => x.key === key) : null;
    const sections = [controlEditor(c)];
    if (k && k.also) sections.push(controlEditor(controlById(k.also)));
    return h('div', { class: 'lpp-ph-inspector' },
      title(c.label.replace(/ \(long press\)$/, ''), c.kind ? cap(c.kind) : 'Function key'),
      key != null ? kv('Key', String(key)) : null,
      ...sections);
  }

  function controlEditor(c) {
    const map = settings().pixelhueMap || {};
    const action = actionOf(map, c);
    const draft = state.draft && state.draft.control === c.id ? state.draft : null;
    const param = draft ? draft.prefix : (/^(recall|companion):/.exec(action) || [])[1] || null;
    const selectValue = param ? `${param}:` : action;

    const options = [];
    if (c.kind) {
      for (const a of actionsFor(c)) options.push(h('option', { value: a.id, text: a.label, selected: a.id === selectValue ? 'selected' : null }));
    } else {
      const groups = new Map();
      for (const a of KEY_ACTIONS) {
        if (!groups.has(a.group)) groups.set(a.group, []);
        groups.get(a.group).push(h('option', { value: a.id, text: a.label, selected: a.id === selectValue ? 'selected' : null }));
      }
      for (const p of PARAM_ACTIONS) {
        groups.set(p.group, [h('option', { value: `${p.prefix}:`, text: `${p.label}…`, selected: selectValue === `${p.prefix}:` ? 'selected' : null })]);
      }
      for (const [label, list] of groups) options.push(h('optgroup', { label }, list));
    }

    const picker = h('select', {
      class: 'wru-input',
      disabled: state.saving ? 'disabled' : null,
      onChange: (ev) => {
        const v = ev.target.value;
        if (v.endsWith(':')) {
          state.draft = { control: c.id, prefix: v.slice(0, -1) };
          ctx.refresh();
        } else {
          void assign(c.id, v);
        }
      },
    }, options);

    const codes = [...(c.codes || []), ...(c.repeat || [])];
    const reports = c.kind
      ? `${c.kind === 'fader' ? 'its position, in percent' : '±1 per detent'}, once bound (lpp.${c.id})`
      : codes.length
        ? codes.map((n) => `${n} ${COMMAND_NAME[n] || ''}`.trim()).join(', ')
        : `no command — read from its raw press (keyMode ${c.keyMode})`;

    return h('div', { class: 'lpp-ph-editor' },
      c.id === 'ctrlTime' ? h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'With CTRL held' }) : null,
      kv('Reports', reports),
      h('label', { class: 'aw-flex-col aw-gap-row-mini' },
        h('span', { class: 'aw-font-overline aw-text-tertiary', text: 'Does' }),
        picker),
      param ? paramFields(c, param, action) : null,
      h('div', { class: 'aw-font-caption aw-text-secondary', text: describeAction(action) }),
      c.repeat && c.repeat.length ? h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        'Held, this key repeats about eight times a second. Only a take-time action repeats; anything else fires once per press.' }) : null,
      action !== c.default
        ? h('button', {
          type: 'button', class: 'wru-button', disabled: state.saving ? 'disabled' : null,
          text: `Back to the default — ${describeAction(c.default)}`,
          onClick: () => { void assign(c.id, c.default); },
        })
        : h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'This is the default.' }));
  }

  function paramFields(c, prefix, action) {
    const current = String(action);
    const numbers = (current.startsWith(`${prefix}:`) ? current.slice(prefix.length + 1) : '').split('/').map(Number);
    const field = (label, value, min, max, id) => h('label', { class: 'aw-flex-col aw-gap-row-mini' },
      h('span', { class: 'aw-font-overline aw-text-tertiary', text: label }),
      h('input', {
        class: 'wru-input', type: 'number', min: String(min), max: String(max),
        value: Number.isFinite(value) && value >= min ? String(value) : '', 'data-field': id, style: { width: '4.5rem' },
      }));
    const row = prefix === 'recall'
      ? [field('Memory', numbers[0], 1, 1000, 'a')]
      : [field('Page', numbers[0], 1, 99, 'a'), field('Row', numbers[1], 0, 99, 'b'), field('Column', numbers[2], 0, 99, 'c')];
    const wrap = h('div', { class: 'aw-flex-row aw-gap-col-medium', style: { alignItems: 'flex-end' } }, row,
      h('button', {
        type: 'button', class: 'wru-button wru-button--active', text: 'Set',
        onClick: () => {
          const get = (f) => wrap.querySelector(`[data-field="${f}"]`).value;
          const value = prefix === 'recall' ? `recall:${get('a')}` : `companion:${get('a')}/${get('b')}/${get('c')}`;
          const next = normaliseMap({ [c.id]: value });
          if (!next[c.id] && value !== c.default) { state.error = `${value} is not something this key can do`; ctx.refresh(); return; }
          void assign(c.id, value);
        },
      }));
    return wrap;
  }

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const title = (text, kind) => h('div', { class: 'aw-flex-col aw-gap-row-mini' },
    h('div', { class: 'aw-font-overline aw-text-tertiary', text: kind }),
    h('div', { class: 'aw-font-subtitle-1', text }));
  const kv = (k, v) => h('div', { class: 'aw-flex-row aw-gap-col-medium' },
    h('span', { class: 'aw-font-caption aw-text-tertiary', style: { minWidth: '4.5rem' }, text: k }),
    h('span', { class: 'aw-font-caption', text: v }));
  const para = (text) => h('div', { class: 'aw-font-caption aw-text-secondary', text });

  /* ------------------------------------------------------------ the page */

  function elsewhere() {
    const map = settings().pixelhueMap || {};
    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Not on a U5’s default layout — for a U5 Pro or a custom layout' }),
      h('div', { class: 'aw-flex-row aw-gap-col-small aw-flex-wrap' },
        layout.elsewhere.map((id) => {
          const c = controlById(id);
          const action = actionOf(map, c);
          return h('button', {
            type: 'button',
            class: ['lpp-ph-chip', isSelected({ control: id }) ? 'lpp-ph-chip--selected' : null],
            onClick: () => select({ control: id }),
          }, `${c.label} → ${legendOf(action)}${action !== c.default ? ' •' : ''}`);
        })));
  }

  function followPress() {
    const info = live();
    const press = info && info.lastPress;
    if (!press || press.at <= state.seenPress) return;
    state.seenPress = press.at;
    const k = layout.keys.find((x) => x.key === press.key);
    if (!k || k.kind === 'clusterPage') return;
    const c = controlOfKey(k);
    state.selected = c ? { control: c.id, key: k.key } : { key: k.key };
    state.draft = null;
    /* Repaint again once the flash is over, so the key goes dark. */
    setTimeout(() => ctx.refresh(), PRESS_FLASH_MS + 50);
  }

  function render() {
    styles();
    followPress();
    const now = Date.now();
    const info = live();
    const s = settings();
    const link = info && info.link;
    const changed = Object.keys(s.pixelhueMap || {}).length;

    const board = h('div', { class: 'lpp-ph-chassis' },
      h('div', { class: 'lpp-ph-board', style: { aspectRatio: `${layout.width} / ${layout.height}` } },
        layout.bars.flatMap(drawBar),
        layout.encoders.map(drawEncoder),
        layout.faders.map(drawFader),
        drawTbar(layout.tbar),
        layout.keys.map((k) => drawKey(k, now))));

    const toolbar = h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium', style: { width: '100%' } },
      h('div', { class: 'aw-font-subtitle-1', text: 'Pixelhue Mapping' }),
      h('span', { class: ['wru-tag', link && link.connected ? null : 'wru-warn'], text:
        !s.pixelhueEnabled ? 'panel off' : link && link.connected ? `U5 at ${link.host}` : 'not connected' }),
      h('span', { class: 'aw-flex-item' }),
      changed
        ? h('button', {
          type: 'button', class: 'wru-button', disabled: state.saving ? 'disabled' : null,
          text: `Reset ${changed} change${changed === 1 ? '' : 's'}`,
          onClick: () => { if (confirm('Put every control back to what it does by default?')) void save({}); },
        })
        : null);

    const notes = [];
    if (state.error) notes.push(note('warn', `Could not save: ${state.error}`));
    if (!s.pixelhueEnabled) {
      notes.push(note('info', 'The console link is off (Preconfig → Settings → Pixelhue panel). The mapping can be '
        + 'edited now and takes effect when it is on; the buses fill in once a console is connected.'));
    }
    if (s.pixelhueModel && s.pixelhueModel !== 'u5') {
      notes.push(note('info', 'Drawn as a U5. The mapping is by function, not by key, so it holds on a U5 Pro and '
        + 'a U5 mini too — their own layouts are not drawn here yet.'));
    }

    const body = h('div', { class: 'aw-flex-col aw-gap-row-large' },
      notes,
      h('div', { class: 'lpp-ph-layout' },
        h('div', { class: 'aw-flex-col aw-gap-row-large', style: { minWidth: 0, flex: '1 1 auto' } }, board, elsewhere()),
        inspector()));

    return panel({ toolbar, body });
  }

  return { render };
}

/*
 * The Virtual RC400T's own look, taken from its stylesheet on a 6.2 Web RCS:
 * the chassis gradient and shadow, a key's 4 px cap with its 30 px ellipse,
 * the lit-key radial gradients and their 0.3 / 0.7 opacities, and the 2 px
 * #2185D0 ring of a selected key. Its class names are hashed per build, so
 * the rules are restated here rather than reused.
 */
const CSS = `
.lpp-ph-layout { display: flex; gap: 1rem; align-items: flex-start; }
@media (max-width: 1100px) { .lpp-ph-layout { flex-direction: column; } }
.lpp-ph-chassis {
  background: radial-gradient(rgb(34, 38, 49), rgb(16, 22, 30));
  box-shadow: rgba(0, 0, 0, 0.23) 0 6px 12px, rgba(0, 0, 0, 0.19) 0 10px 40px;
  padding: 1rem; border-radius: 6px;
}
.lpp-ph-board { position: relative; width: 100%; container-type: inline-size; }
.lpp-ph-slot { position: absolute; }
.lpp-ph-slot > .lpp-ph-key { width: 100%; height: 100%; }
.lpp-ph-silk {
  position: absolute; left: -12%; right: -12%; top: 100%; margin-top: 0.15cqw;
  font-size: 0.74cqw; line-height: 1.1; text-align: center; letter-spacing: 0.04em;
  color: rgba(255, 255, 255, 0.5); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  pointer-events: none;
}
.lpp-ph-key {
  position: relative; display: block; padding: 0; border: none; border-radius: 4px; cursor: pointer; overflow: hidden;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: rgba(0, 0, 0, 0.24) 0 2px 4px, rgba(0, 0, 0, 0.12) 0 2px 6px;
  font-family: OpenSans, "Helvetica Neue", Arial, Helvetica, sans-serif;
}
.lpp-ph-key:hover { background: rgba(255, 255, 255, 0.08); box-shadow: rgba(0, 0, 0, 0.23) 0 3px 12px, rgba(0, 0, 0, 0.16) 0 3px 12px; }
.lpp-ph-key:active { background: rgba(0, 0, 0, 0.3); }
.lpp-ph-key:focus-visible { outline: 1px solid #fff; }
.lpp-ph-key__rect, .lpp-ph-key__overlay { position: absolute; inset: 0; }
.lpp-ph-key__overlay { inset: 6%; border-radius: 8px; }
.lpp-ph-key__ellipse { position: absolute; inset: 2px; border-radius: 30px; background: rgba(255, 255, 255, 0.04); }
.lpp-ph-key:hover .lpp-ph-key__ellipse { background: rgba(255, 255, 255, 0.08); }
.lpp-ph-key__legend {
  position: relative; display: flex; align-items: center; justify-content: center; height: 100%; padding: 0 6%;
  font-size: 0.9cqw; font-weight: 600; line-height: 1.1; text-align: center; overflow-wrap: anywhere;
  color: rgba(255, 255, 255, 0.7);
}
.lpp-ph-key--tall .lpp-ph-key__legend { height: auto; padding-top: 30%; }
.lpp-ph-key__sub {
  position: relative; display: block; text-align: center; font-size: 0.7cqw; color: rgba(255, 255, 255, 0.45); margin-top: 0.3cqw;
}
.lpp-ph-key--off .lpp-ph-key__rect, .lpp-ph-key--off .lpp-ph-key__overlay { background: rgba(255, 255, 255, 0.04); opacity: 0.5; }
.lpp-ph-key--dim .lpp-ph-key__legend { color: rgba(255, 255, 255, 0.3); }
.lpp-ph-key:not(.lpp-ph-key--off) .lpp-ph-key__rect { opacity: 0.3; }
.lpp-ph-key:not(.lpp-ph-key--off) .lpp-ph-key__overlay { opacity: 0.7; }
.lpp-ph-key:not(.lpp-ph-key--off) .lpp-ph-key__legend { color: rgba(0, 0, 0, 0.75); }
.lpp-ph-key--green :is(.lpp-ph-key__rect, .lpp-ph-key__overlay) { background: radial-gradient(70.71% 70.71%, rgb(206, 255, 228) 0, rgb(174, 255, 212) 11.5%, rgb(101, 255, 173) 24%, rgb(33, 239, 115) 36.5%, rgb(50, 142, 69) 87.5%, rgb(73, 139, 91) 100%); }
.lpp-ph-key--green-low :is(.lpp-ph-key__rect, .lpp-ph-key__overlay) { background: radial-gradient(70.71% 70.71%, rgb(145, 255, 190) 0, rgb(47, 219, 99) 100%); }
.lpp-ph-key--yellow :is(.lpp-ph-key__rect, .lpp-ph-key__overlay) { background: radial-gradient(70.71% 70.71%, rgb(255, 252, 164) 0, rgb(255, 237, 135) 10.5%, rgb(255, 206, 114) 21%, rgb(255, 188, 75) 33.5%, rgb(255, 164, 64) 46%, rgb(228, 143, 60) 66%, rgb(172, 104, 59) 100%); }
.lpp-ph-key--yellow-low :is(.lpp-ph-key__rect, .lpp-ph-key__overlay) { background: radial-gradient(70.71% 70.71%, rgb(251, 255, 213) 0, rgb(255, 255, 194) 11.5%, rgb(255, 253, 146) 24%, rgb(249, 239, 128) 38%, rgb(220, 209, 91) 55%, rgb(145, 125, 72) 100%); }
.lpp-ph-key--red-low :is(.lpp-ph-key__rect, .lpp-ph-key__overlay) { background: radial-gradient(70.71% 70.71%, rgb(255, 129, 132) 0, rgb(255, 61, 60) 100%); }
.lpp-ph-key--selected, .lpp-ph-encoder--selected .lpp-ph-oled, .lpp-ph-fader--selected .lpp-ph-oled, .lpp-ph-tbar--selected .lpp-ph-tbar__track {
  outline: 2px solid rgb(33, 133, 208); outline-offset: 2px;
  box-shadow: rgba(0, 0, 0, 0.23) 0 3px 12px, rgba(0, 0, 0, 0.16) 0 3px 12px;
}
.lpp-ph-key--pressed { animation: lpp-ph-press ${PRESS_FLASH_MS}ms ease-out; }
@keyframes lpp-ph-press { from { box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.9), 0 0 18px rgba(255, 255, 255, 0.6); } to { box-shadow: none; } }
.lpp-ph-key__changed {
  position: absolute; top: 5px; right: 5px; width: 7px; height: 7px; border-radius: 50%; background: rgb(33, 133, 208);
}
.lpp-ph-bar {
  position: absolute; display: flex; align-items: center; justify-content: center;
  border-top: 1px solid rgba(255, 255, 255, 0.16); border-bottom: 1px solid rgba(255, 255, 255, 0.16);
}
.lpp-ph-bar span {
  font-size: 1.05cqw; font-weight: 700; letter-spacing: 0.18em; color: rgba(255, 255, 255, 0.32);
  font-family: OpenSans, "Helvetica Neue", Arial, Helvetica, sans-serif;
}
.lpp-ph-oled {
  display: flex; align-items: center; justify-content: center; gap: 0.3cqw; position: relative;
  background: rgb(10, 12, 16); border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 3px;
  color: rgb(120, 230, 160); font-size: 0.72cqw; font-weight: 600; letter-spacing: 0.03em; white-space: nowrap;
  padding: 0.25cqw 0.3cqw;
}
.lpp-ph-oled--dim { color: rgba(255, 255, 255, 0.3); }
.lpp-ph-oled__changed { width: 0.45cqw; height: 0.45cqw; border-radius: 50%; background: rgb(33, 133, 208); }
.lpp-ph-encoder { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 0.5cqw; cursor: pointer; }
.lpp-ph-encoder__knob {
  width: 64%; aspect-ratio: 1; border-radius: 50%;
  background: repeating-conic-gradient(rgb(58, 64, 78) 0 4deg, rgb(36, 40, 50) 4deg 8deg);
  box-shadow: rgba(0, 0, 0, 0.5) 0 4px 10px, inset 0 0 0 2px rgba(255, 255, 255, 0.06);
  display: flex; align-items: center; justify-content: center;
}
.lpp-ph-encoder__cap { width: 62%; aspect-ratio: 1; border-radius: 50%; background: radial-gradient(circle at 40% 35%, rgb(92, 100, 118), rgb(40, 45, 56)); }
.lpp-ph-encoder:hover .lpp-ph-encoder__knob { box-shadow: rgba(0, 0, 0, 0.5) 0 4px 10px, inset 0 0 0 2px rgba(255, 255, 255, 0.16); }
.lpp-ph-fader { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 0.6cqw; cursor: pointer; }
.lpp-ph-fader__track {
  position: relative; width: 30%; flex: 1 1 auto; border-radius: 3px;
  background: linear-gradient(90deg, rgb(12, 14, 18), rgb(30, 34, 42) 50%, rgb(12, 14, 18));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.lpp-ph-fader__cap {
  position: absolute; left: -65%; right: -65%; bottom: 8%; height: 12%; border-radius: 3px;
  background: linear-gradient(180deg, rgb(110, 118, 134), rgb(56, 62, 76) 45%, rgb(170, 176, 190) 50%, rgb(56, 62, 76) 55%, rgb(40, 45, 56));
  box-shadow: rgba(0, 0, 0, 0.5) 0 3px 6px;
}
.lpp-ph-fader:hover .lpp-ph-fader__track { box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.2); }
.lpp-ph-tbar { position: absolute; display: flex; gap: 6%; justify-content: center; cursor: pointer; }
.lpp-ph-tbar__scale { display: flex; flex-direction: column; justify-content: space-between; padding: 18% 0 22%; }
.lpp-ph-tbar__scale i { display: block; width: 1.1cqw; height: 0.35cqw; background: rgba(255, 255, 255, 0.12); }
.lpp-ph-tbar__track {
  position: relative; width: 45%; border-radius: 8px;
  background: linear-gradient(90deg, rgb(20, 23, 29), rgb(40, 45, 56) 50%, rgb(20, 23, 29));
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06), rgba(0, 0, 0, 0.4) 0 6px 16px;
}
.lpp-ph-tbar__handle {
  position: absolute; left: 22%; right: 22%; top: 12%; bottom: 10%; border-radius: 6px;
  background: linear-gradient(90deg, rgb(70, 76, 90), rgb(140, 148, 164) 50%, rgb(70, 76, 90));
  box-shadow: rgba(0, 0, 0, 0.5) 0 4px 12px;
}
.lpp-ph-tbar__label { position: absolute; bottom: -2%; left: 50%; translate: -50% 100%; }
.lpp-ph-inspector {
  flex: 0 0 300px; display: flex; flex-direction: column; gap: 0.75rem; padding: 1rem;
  background: rgba(255, 255, 255, 0.04); border-radius: 6px;
  box-shadow: rgba(0, 0, 0, 0.24) 0 2px 4px, rgba(0, 0, 0, 0.12) 0 2px 6px;
}
.lpp-ph-editor { display: flex; flex-direction: column; gap: 0.6rem; padding-top: 0.75rem; border-top: 1px solid rgba(255, 255, 255, 0.08); }
.lpp-ph-chip {
  cursor: pointer; border: none; border-radius: 4px; padding: 0.35rem 0.6rem; color: rgba(255, 255, 255, 0.8);
  background: rgba(255, 255, 255, 0.06); font: inherit; font-size: 0.85rem;
  box-shadow: rgba(0, 0, 0, 0.24) 0 2px 4px, rgba(0, 0, 0, 0.12) 0 2px 6px;
}
.lpp-ph-chip:hover { background: rgba(255, 255, 255, 0.1); }
.lpp-ph-chip--selected { outline: 2px solid rgb(33, 133, 208); }
.lpp-ph-key__number { color: rgba(255, 255, 255, 0.22); font-weight: 400; }
`;
