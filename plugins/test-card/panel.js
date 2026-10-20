/*
 * Test Card — the tab's body, in the vendor's own idiom: the Pattern tab's
 * `ui checkbox toggle` for Enable and its `ui inverted selection list` of
 * tiles, the `inline field` rows of every Web RCS form, and `aw-` boxes. The
 * tile art is hashed in the vendor's bundle, so the tiles are drawn with the
 * shared utility classes and a few rules of our own.
 *
 * Pure DOM from a model (`client.js`'s `model()`); every control calls an
 * action. Rebuilt only when what it shows has changed — the client compares
 * a signature — so typing in a field is not interrupted by the switcher's
 * frames, and numbers are committed on `change`, not on every key.
 */

import { h, button } from '../../src/ui/dom.js';
import { getPath } from './core.js';

const STYLE_ID = 'lpp-test-card-css';
const CSS = `
/* The body goes straight into the vendor's panel, whose header and
   scrolling content are flex children: the wrapper must not be a box. */
[data-lpp-testcard] .lpp-tc { display: contents; }
div[data-lpp-testcard] { min-height: 0; overflow: hidden; }
[data-lpp-testcard-inner] { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
[data-lpp-testcard] .lpp-tc > .aw-panel__content--scrollable { min-height: 0; overflow-y: auto; }
[data-lpp-testcard] .ui.form select, [data-lpp-testcard] select { width: auto; background: #1D2328; color: #E6E9EB; border: 1px solid #3A454E; border-radius: 0.25rem; height: 2rem; padding: 0 0.4rem; font-size: 0.916rem; }
[data-lpp-testcard] .ui.form input[type=number], [data-lpp-testcard] .ui.form input[type=text] { background: #1D2328; color: #E6E9EB; border: 1px solid #3A454E; }
[data-lpp-testcard] .lpp-tc-tiles { display: flex; flex-wrap: wrap; gap: 0.75rem; }
[data-lpp-testcard] .lpp-tc-tile { cursor: pointer; width: 8.5rem; border-radius: 0.25rem; background: #2B3339; padding: 0.4rem; box-sizing: border-box; }
[data-lpp-testcard] .lpp-tc-tile:hover { background: #33404A; }
[data-lpp-testcard] .lpp-tc-tile.is-active { outline: 0.15rem solid #2185D0; background: #1F3B52; }
[data-lpp-testcard] .lpp-tc-tile canvas { display: block; width: 100%; height: auto; background: #000; }
[data-lpp-testcard] .lpp-tc-tile .lpp-tc-name { font-size: 0.833rem; margin-bottom: 0.3rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
[data-lpp-testcard] .lpp-tc-tile .lpp-tc-badge { font-size: 0.7rem; color: #A9B1B7; margin-left: 0.3rem; }
[data-lpp-testcard] .lpp-tc-preview canvas { display: block; max-width: 100%; height: auto; background: #000; outline: 1px solid #3A454E; }
[data-lpp-testcard] .lpp-tc-note { font-size: 0.916rem; color: #A9B1B7; margin: 0.25rem 0; white-space: pre-wrap; }
[data-lpp-testcard] .lpp-tc-note.is-warn { color: #F39910; }
[data-lpp-testcard] .lpp-tc-note.is-ok { color: #7FD13B; }
[data-lpp-testcard] .lpp-tc-note.is-bad { color: #E5534B; }
[data-lpp-testcard] .lpp-tc-steps { font-size: 0.833rem; color: #A9B1B7; margin: 0.25rem 0 0; padding-left: 1rem; }
[data-lpp-testcard] .lpp-tc-steps .failed { color: #E5534B; }
[data-lpp-testcard] .lpp-tc-steps .note { color: #F39910; }
[data-lpp-testcard] .lpp-tc-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; margin-top: 0.5rem; }
[data-lpp-testcard] input[type=number] { width: 7rem; }
[data-lpp-testcard] input[type=text] { width: 14rem; }
`;

function styles(doc) {
  try {
    if (!doc.head || doc.getElementById(STYLE_ID)) return;
    doc.head.append(h('style', { id: STYLE_ID, text: CSS }));
  } catch { /* unstyled rather than not drawn */ }
}

const stop = (ev) => ev.stopPropagation();

function field(label, control) {
  return h('div', { class: 'inline field' },
    h('label', { class: 'aw-block-medium' },
      h('div', { class: 'aw-font-body-1 aw-min-width-0 aw-text-ellipsis', text: label })),
    h('div', { class: 'children-wrapper aw-font-body-1' }, control));
}

/** The vendor's on/off switch. */
function toggle(on, onFlip, { disabled = false, title = '' } = {}) {
  return h('div', {
    class: ['ui checkbox toggle medium', on ? 'checked' : '', disabled ? 'disabled' : ''],
    title,
    role: 'switch',
    'aria-checked': on ? 'true' : 'false',
    onClick: (ev) => { ev.preventDefault(); stop(ev); if (!disabled) onFlip(!on); }
  },
  h('input', { class: 'hidden', readonly: '', tabindex: '0', type: 'checkbox', checked: on ? '' : null }),
  h('label'));
}

/** The vendor's textual choice — Grid | Free on the Canvas tab. */
function choices(list, current, onPick) {
  return h('div', { role: 'list', class: 'ui selection list textual' },
    ...list.map((c) => h('div', {
      role: 'listitem',
      class: ['item aw-relative', c.id === current ? 'active' : ''],
      title: c.what || '',
      onClick: (ev) => { stop(ev); if (c.id !== current) onPick(c.id); }
    }, h('div', { class: 'content aw-font-subtitle-1', text: c.label }))));
}

function control(spec, value, onSet) {
  const key = { 'data-lpp-key': `tc:${spec.path}` };
  if (spec.type === 'bool') return toggle(Boolean(value), (on) => onSet(spec.path, on));
  if (spec.type === 'choice') {
    return h('select', { ...key, onChange: (ev) => onSet(spec.path, ev.target.value), onClick: stop },
      ...spec.choices.map((c) => h('option', { value: c.value, selected: c.value === value ? '' : null, text: c.label })));
  }
  if (spec.type === 'text') {
    return h('div', { class: 'ui input aw-input__field' },
      h('input', { ...key, type: 'text', maxlength: String(spec.max), value: value || '', placeholder: 'Show name, date…', onChange: (ev) => onSet(spec.path, ev.target.value) }));
  }
  return h('div', { class: 'ui input aw-input__field' },
    h('input', {
      ...key, type: 'number', value: String(value), min: String(spec.min), max: String(spec.max), step: String(spec.step || 1),
      onChange: (ev) => { const n = Number(ev.target.value); if (Number.isFinite(n)) onSet(spec.path, n); }
    }));
}

function box(title, right, ...body) {
  return h('div', { class: 'aw-panel aw-panel--medium' },
    h('div', { class: 'aw-panel__header' },
      h('div', { class: 'aw-header aw-relative aw-header--medium' },
        h('div', { class: 'aw-header__items' }, h('h4', { text: title })),
        right ? h('div', { class: 'aw-header__items aw-margin-left-auto aw-text-secondary aw-font-body-2' }, right) : null)),
    h('div', { class: 'aw-panel__content' }, ...body));
}

const note = (text, tone = '') => (text ? h('div', { class: ['lpp-tc-note', tone ? `is-${tone}` : ''], text }) : null);

function action(label, onClick, { disabled = false, variant = 'default' } = {}) {
  return button(label, {
    variant,
    disabled,
    onClick: (ev) => { ev.preventDefault(); stop(ev); if (!disabled) onClick(); }
  });
}

/**
 * The body for one page.
 *
 * @param {object} m   the model (`client.js`)
 * @param {object} a   the actions
 */
export function buildPanel(m, a, doc = document) {
  styles(doc);
  const content = h('div', { class: 'aw-panel__content aw-panel__content--scrollable aw-gutter-row-big' });
  const root = h('div', { class: 'lpp-tc', onClick: stop },
    h('div', { class: 'aw-panel__header aw-panel__header--empty' }),
    content);

  if (!m.ready) {
    content.append(box('Test Card', null, note('Waiting for the switcher…')));
    return root;
  }
  if (m.unavailable) {
    content.append(box('Test Card', null, note(m.unavailable, 'warn')));
    return root;
  }

  /* -------------------------------------------------- the switch and the tiles */
  const where = m.where;
  const enable = field('Enable', toggle(m.on, (on) => a.setOn(on), { disabled: m.busy || (!m.on && !!m.blocked), title: m.blocked || '' }));
  const head = [enable];
  if (m.page.kind === 'canvas') head.push(field('Layout', choices(m.layouts, m.layout, (id) => a.setLayout(id))));
  const tiles = h('div', { class: 'lpp-tc-tiles', role: 'list' },
    ...m.kinds.map((k) => h('div', {
      role: 'listitem',
      class: ['lpp-tc-tile', k.active ? 'is-active' : ''],
      title: k.moves ? `${k.label} — moves in Test Card; here it is one still frame` : k.label,
      onClick: (ev) => { stop(ev); if (!k.active) a.pickKind(k.kind); }
    },
    h('div', { class: 'lpp-tc-name' }, k.label, k.moves ? h('span', { class: 'lpp-tc-badge', text: 'still' }) : null),
    k.thumb)));
  const asking = m.confirming
    ? h('div', {},
      note(m.adding ? `${m.destId}’s card is on program: this output’s card joins it on air the moment it lands.` : `Program is on air: the card goes straight to ${m.destId}’s outputs, over every layer.`, 'warn'),
      h('div', { class: 'lpp-tc-row' },
        action('Confirm — on air now', () => a.confirm(), { variant: 'danger', disabled: m.busy }),
        action('Cancel', () => a.cancel())))
    : null;
  content.append(box('Test Card', m.title,
    h('form', { class: 'ui form large-width', onSubmit: (ev) => ev.preventDefault() }, ...head),
    asking,
    note(where.text, where.tone),
    m.elsewhere ? h('div', { class: 'lpp-tc-row' }, action(`Take everything off ${m.destId}`, () => a.allOff(), { disabled: m.busy })) : null,
    m.blocked && !m.on ? note(m.blocked, 'warn') : null,
    tiles));

  /* -------------------------------------------------------------- options */
  const rows = m.options.map((spec) => field(spec.label, control(spec, getPath(m.settings, spec.path), a.setOption)));
  content.append(box(`${m.kindLabel} — options`, null,
    h('form', { class: 'ui form large-width', onSubmit: (ev) => ev.preventDefault() }, ...rows),
    m.scaledNote ? note(m.scaledNote) : null));

  /* -------------------------------------------------------------- preview */
  content.append(box('Preview', m.size,
    m.preview ? h('div', { class: 'lpp-tc-preview' }, m.preview) : note(m.planProblem || 'Nothing to draw', 'warn'),
    ...(m.planNotes || []).map((t) => note(t)),
    h('div', { class: 'lpp-tc-row' },
      action('Download PNG', () => a.download(), { disabled: !m.preview || m.busy }),
      m.slicer ? action('To the Background Slicer…', () => a.offer(), { disabled: !m.preview || m.busy }) : null)));

  /* ------------------------------------------------------------ putting it up */
  const ticks = h('form', { class: 'ui form large-width', onSubmit: (ev) => ev.preventDefault() },
    field('On program', toggle(m.program, (on) => a.setProgram(on), { disabled: m.busy || m.on || m.adding, title: m.on || m.adding ? 'A card already up stays in the buffer it is in' : '' })),
    field('Assigned slots', toggle(m.assigned, (on) => a.setAssigned(on), { disabled: m.busy })));
  const steps = m.steps.length
    ? h('ul', { class: 'lpp-tc-steps' }, ...m.steps.map((s) => h('li', { class: s.state, text: s.text })))
    : null;
  content.append(box('On the switcher', null,
    note((m.on || m.adding) && m.onAir
      ? `The card is on ${m.destId}’s program: every change here goes to air as you make it, and Enable asks first.`
      : m.adding
        ? `${m.destId}’s card is up in ${m.buffer || 'its buffer'}: Enable adds this output to it there.`
        : m.program
        ? `Enable puts the card on ${m.destId}’s program, over every layer, after asking: it goes to air at once. Off for every new page.`
        : `Enable puts the card on ${m.destId}’s preview, over every layer. Take it when you want it on the outputs.`, (m.program && !m.adding) || ((m.on || m.adding) && m.onAir) ? 'warn' : ''),
    note(m.assigned ? 'Assigned slots on: an empty library slot a still points at may be used, and that still shows the card too, maybe on air.' : 'Assigned slots off: an empty library slot a still points at is left alone.'),
    ticks,
    note(m.how),
    m.error ? note(m.error, 'bad') : null,
    steps));

  return root;
}
