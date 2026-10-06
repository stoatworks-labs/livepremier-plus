/*
 * Variables — the panel: the operator's own `@` variables, edited in place,
 * over the switcher's `$` ones, read live.
 *
 * ## Two tables, because they are two different things
 *
 * **Yours** are definitions — `@gap = 40`, `@half = $S1.width / 2` — and the
 * table is an editor: a name, a definition, and what it comes to right now.
 * A definition is kept whatever it says, as a spreadsheet cell is, and one
 * that does not evaluate says why in its result column; a cycle is spelled
 * out above the table and on every member. A rename carries every `@old` in
 * the other definitions with it (`service.js`), so renaming never breaks what
 * was built on the name.
 *
 * **The switcher's** are readings, generated from what the store has
 * (`core.js`), so the table is a search over a catalogue that grows with the
 * rig: an Aquilon with twenty screens lists hundreds. It shows the first few
 * hundred matches and says how many more there are, rather than drawing a
 * table nobody can read once a second. Clicking a name copies it, sigil and
 * all, ready to paste into a field or the Console.
 *
 * ## Repaints
 *
 * Immediate-mode, like every panel here: the app repaints on each frame the
 * switcher sends, and `ui/keep-focus.js` carries a field's caret and its
 * uncommitted text across, keyed by `data-lpp-key` because rows can move.
 * A definition commits on Enter or on leaving the field; until then its
 * result is worked out as it is typed and written into its own cell in
 * place, without asking for a repaint.
 */

import { h, button, isEnter } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';

const STYLE_ID = 'lpp-variables-style';
/** How many system variables are drawn before the panel asks for a narrower search. */
const SHOWN_MAX = 300;
/** How long a Delete stays armed before it goes back to safe. */
const ARM_MS = 4000;

const CSS = `
.lpp-var-table td { vertical-align: middle; }
.lpp-var-name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.lpp-var-copy { appearance: none; border: 0; background: none; padding: 0; color: inherit; font: inherit; cursor: copy; text-align: left; }
.lpp-var-copy:hover { color: #fff; text-decoration: underline dotted; }
.lpp-var-value { font-variant-numeric: tabular-nums; white-space: nowrap; color: rgba(255,255,255,0.9); }
.lpp-var-text { color: #A6D7FF; }
.lpp-var-err { color: #F39910; white-space: normal; }
.lpp-var-desc { color: #838B91; }
.lpp-var-group td { padding-top: 0.75rem !important; color: #838B91; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
.lpp-var-sigil { color: #838B91; margin-right: 0.125rem; }
.lpp-var-field { display: flex; align-items: center; gap: 0.25rem; }
.lpp-var-field .wru-input { width: 100%; min-width: 6rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lpp-var-hint { color: #F39910; font-size: 0.75rem; margin-top: 0.125rem; }
.lpp-var-section { margin-bottom: 1.5rem; }
`;

/**
 * @param {object} o
 * @param {ReturnType<import('./service.js').createVariables>} o.variables
 * @param {object} o.session
 * @param {Function} [o.onRefresh]
 * @param {Document} [o.doc]
 */
export function createVariablesPanel({ variables, session, onRefresh = () => {}, doc = document } = {}) {
  const view = {
    filter: '',
    note: null,             // { tone, text }
    drafts: new Map(),      // id → { name?, value?, error? } — an edit that was refused
    armed: null,            // { id, until }
    focus: null             // a data-lpp-key to focus after the next render
  };

  function styles() {
    try {
      if (!doc.head || (doc.getElementById && doc.getElementById(STYLE_ID))) return;
      const el = doc.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      doc.head.append(el);
    } catch { /* unstyled rather than absent */ }
  }

  const setNote = (tone, text) => { view.note = { tone, text }; onRefresh(); };

  /* ------------------------------------------------------------- values */

  /** A value, or the reason there is none, as a table cell's contents. */
  function shown(answer, unit) {
    if (!answer) return h('span', { class: 'lpp-var-err', text: 'unknown' });
    if (!answer.ok) return h('span', { class: 'lpp-var-err', text: answer.error });
    if (typeof answer.value === 'string') {
      return h('span', { class: 'lpp-var-value lpp-var-text', text: answer.value === '' ? '""' : `"${answer.value}"` });
    }
    const n = Number.isInteger(answer.value) ? String(answer.value) : String(Number(answer.value.toFixed(4)));
    return h('span', { class: 'lpp-var-value', text: unit ? `${n} ${unit}` : n });
  }

  /** A name that copies itself — the quickest way into a field or the Console. */
  function copyable(name) {
    return h('button', {
      class: 'lpp-var-copy lpp-var-name', type: 'button', title: `Copy ${name}`,
      onClick: () => {
        try {
          const clip = (doc.defaultView || globalThis).navigator && (doc.defaultView || globalThis).navigator.clipboard;
          if (!clip) throw new Error('no clipboard here');
          clip.writeText(name).then(() => setNote('ok', `copied ${name}`), () => setNote('warn', `could not copy ${name} — select it instead`));
        } catch {
          setNote('warn', `could not copy ${name} — select it instead`);
        }
      }
    }, name);
  }

  /* ---------------------------------------------------------- user rows */

  function addRow() {
    const r = variables.add();
    if (r.error) return setNote('warn', r.error);
    view.focus = `var-name-${r.row.id}`;
    onRefresh();
  }

  function commit(id, field, text) {
    const draft = view.drafts.get(id) || {};
    const error = variables.update(id, { [field]: text });
    if (error) {
      view.drafts.set(id, { ...draft, [field]: text, error });
    } else {
      const rest = { ...draft };
      delete rest[field];
      delete rest.error;
      if (Object.keys(rest).length) view.drafts.set(id, rest); else view.drafts.delete(id);
    }
    onRefresh();
  }

  function discard(id) {
    view.drafts.delete(id);
    onRefresh();
  }

  function remove(id) {
    const live = view.armed && view.armed.id === id && view.armed.until > Date.now();
    if (!live) { view.armed = { id, until: Date.now() + ARM_MS }; onRefresh(); return; }
    view.armed = null;
    view.drafts.delete(id);
    variables.remove(id);
    onRefresh();
  }

  function userRow(v) {
    const draft = view.drafts.get(v.id) || {};
    const result = h('td', {}, shown(v.answer));

    const name = h('input', {
      class: 'wru-input', type: 'text', value: draft.name ?? v.bare,
      'data-lpp-key': `var-name-${v.id}`, spellcheck: 'false', autocomplete: 'off',
      title: 'The name, without the @ — letters, digits and _, dots between parts',
      onChange: (ev) => commit(v.id, 'name', ev.target.value),
      onKeyDown: (ev) => {
        if (isEnter(ev)) { ev.preventDefault(); ev.target.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.target.value = v.bare; discard(v.id); }
        ev.stopPropagation();
      }
    });

    const value = h('input', {
      class: 'wru-input', type: 'text', value: draft.value ?? v.definition,
      'data-lpp-key': `var-value-${v.id}`, spellcheck: 'false', autocomplete: 'off',
      placeholder: '40, or $S1.width / 2',
      title: 'A number, or a sum over numbers and $ / @ variables',
      /* Worked out as it is typed, into its own cell — no repaint, so the
         caret is never in question. */
      onInput: (ev) => {
        result.textContent = '';
        result.append(shown(variables.preview(v.id, ev.target.value)));
      },
      onChange: (ev) => commit(v.id, 'value', ev.target.value),
      onKeyDown: (ev) => {
        if (isEnter(ev)) { ev.preventDefault(); ev.target.blur(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.target.value = v.definition; discard(v.id); }
        ev.stopPropagation();
      }
    });

    const armed = view.armed && view.armed.id === v.id && view.armed.until > Date.now();
    return h('tr', {},
      h('td', {},
        h('div', { class: 'lpp-var-field' }, h('span', { class: 'lpp-var-sigil', text: '@' }), name),
        draft.error ? h('div', { class: 'lpp-var-hint', text: draft.error }) : null),
      h('td', {}, h('div', { class: 'lpp-var-field' }, value)),
      result,
      h('td', { class: 'wru-cue-actions' },
        button(armed ? 'Delete?' : 'Delete', {
          variant: armed ? 'go' : 'ghost',
          title: armed ? 'Press again to delete it — anything typed with it stops resolving' : `Delete @${v.bare}`,
          onClick: () => remove(v.id)
        })));
  }

  function userSection(users, needle) {
    const state = variables.state();
    const rows = needle
      ? users.filter((v) => v.name.toLowerCase().includes(needle) || v.definition.toLowerCase().includes(needle))
      : users;
    const cycles = [...new Set(users.map((v) => v.cycle).filter(Boolean))];
    return h('div', { class: 'lpp-var-section' },
      h('div', { class: 'aw-flex-row-center-v-space-between aw-margin-bottom-small' },
        h('div', { class: 'aw-flex-col' },
          h('div', { class: 'aw-font-subtitle-1', text: 'Yours' }),
          h('div', {
            class: 'aw-font-caption aw-text-tertiary',
            text: '@name — a number, or a sum over numbers and other variables. Kept for this switcher, and in the setup file.'
          })),
        button('Add', { iconId: 'add-18', onClick: addRow, disabled: !state.loaded, title: 'Add a variable of your own' })),
      state.error ? h('div', { class: 'wru-console-row wru-console-err aw-margin-bottom-small', text: state.error }) : null,
      state.saving ? h('div', { class: 'wru-console-row wru-console-warn aw-margin-bottom-small', text: state.saving }) : null,
      ...cycles.map((c) => h('div', {
        class: 'wru-console-row wru-console-warn aw-margin-bottom-small',
        text: `Cycle: ${c} — none of these has a value until one of them stops naming the next.`
      })),
      !state.loaded
        ? h('div', { class: 'wru-empty', text: 'Loading…' })
        : rows.length
          ? h('table', { class: 'wru-table lpp-var-table' },
            h('thead', {}, h('tr', {},
              h('th', { text: 'Name', style: { width: '22%' } }),
              h('th', { text: 'Definition', style: { width: '38%' } }),
              h('th', { text: 'Value' }),
              h('th', { text: '' }))),
            h('tbody', {}, ...rows.map(userRow)))
          : h('div', { class: 'wru-empty' },
            h('div', {
              class: 'wru-empty-copy',
              text: needle
                ? 'None of yours matches that.'
                : 'None yet. Add one — @gap = 40, say — and type @gap*3 into a position field, or use it in the Console.'
            })));
  }

  /* -------------------------------------------------------- system rows */

  function systemSection(system, needle) {
    if (!session.store || !session.store.ready) {
      return h('div', { class: 'lpp-var-section' },
        h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-small', text: 'The switcher’s' }),
        h('div', { class: 'wru-empty', text: 'Waiting for the device store…' }));
    }
    const rows = needle
      ? system.filter((v) => v.name.toLowerCase().includes(needle) ||
        v.description.toLowerCase().includes(needle) || v.group.toLowerCase().includes(needle))
      : system;
    const drawn = rows.slice(0, SHOWN_MAX);
    const body = [];
    let group = null;
    for (const v of drawn) {
      if (v.group !== group) {
        group = v.group;
        body.push(h('tr', { class: 'lpp-var-group' }, h('td', { colspan: '3', text: group })));
      }
      body.push(h('tr', {},
        h('td', {}, copyable(v.name)),
        h('td', {}, shown(v.answer, v.unit)),
        h('td', { class: 'lpp-var-desc', text: v.description })));
    }
    return h('div', { class: 'lpp-var-section' },
      h('div', { class: 'aw-flex-col aw-margin-bottom-small' },
        h('div', { class: 'aw-font-subtitle-1', text: 'The switcher’s' }),
        h('div', {
          class: 'aw-font-caption aw-text-tertiary',
          text: '$name — read live from what the switcher reports, and read-only. Generated from the screens, layers, inputs and outputs it has, so it grows with the rig. Click a name to copy it.'
        })),
      h('div', {
        class: 'aw-font-overline aw-text-tertiary aw-margin-bottom-small',
        text: rows.length > drawn.length
          ? `${drawn.length} shown of ${rows.length} — narrow the search to see the rest`
          : `${rows.length} of ${system.length}`
      }),
      rows.length
        ? h('table', { class: 'wru-table lpp-var-table' },
          h('thead', {}, h('tr', {},
            h('th', { text: 'Name', style: { width: '26%' } }),
            h('th', { text: 'Value', style: { width: '24%' } }),
            h('th', { text: 'What it is' }))),
          h('tbody', {}, ...body))
        : h('div', { class: 'wru-empty', text: 'Nothing the switcher reports matches that.' }));
  }

  /* ------------------------------------------------------------- frame */

  function toolbar() {
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-large aw-flex-wrap' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Variables' }),
      h('input', {
        class: 'wru-input', type: 'search', placeholder: 'Find a variable — S1.PGM, IN3, @gap',
        value: view.filter, style: { flex: '0 1 18rem' }, 'data-lpp-key': 'var-filter',
        onInput: (ev) => { view.filter = ev.target.value; onRefresh(); }
      }));
  }

  function noteLine() {
    if (!view.note) return null;
    const cls = { ok: 'wru-console-ok', warn: 'wru-console-warn', err: 'wru-console-err' };
    return h('div', { class: ['wru-console-row', cls[view.note.tone] || '', 'aw-margin-bottom-medium'], text: view.note.text });
  }

  function render() {
    styles();
    const needle = view.filter.trim().toLowerCase().replace(/^[$@]/, '');
    const root = panel({
      toolbar: toolbar(),
      body: h('div', {},
        h('div', {
          class: 'aw-font-body-2 aw-text-tertiary aw-margin-bottom-medium',
          text: 'Use them wherever a number goes — in the Console, Set Screen 1 Layer 2 Size ($S1.width / 2) $S1.height; in a numeric field, $S1.width/2 or @gap*3. Over OSC, only @ variables that do not depend on a $ one.'
        }),
        noteLine(),
        userSection(variables.userList(), needle),
        systemSection(variables.systemList(), needle))
    });
    if (view.focus) {
      const key = view.focus;
      view.focus = null;
      const win = doc.defaultView || globalThis;
      if (win && typeof win.requestAnimationFrame === 'function') {
        win.requestAnimationFrame(() => {
          const field = root.querySelector && root.querySelector(`[data-lpp-key="${key}"]`);
          if (field && field.focus) { field.focus(); if (field.select) field.select(); }
        });
      }
    }
    return root;
  }

  return { render, view };
}
