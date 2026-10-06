/*
 * The variables shelf — a tab beside Syntax in the popped-out Console.
 *
 * What the Variables plugin offers, with what each reads right now, and a
 * click that puts the name into the command line. Read-only: definitions are
 * edited in the Variables panel, where a cycle or a bad name is explained,
 * and this shelf is for reaching a name without leaving the keyboard's line.
 *
 * Asks for the `variables` service on every draw, through the opener's
 * plugins — the popout holds nothing of its own (`ui/popout.js`) — so a
 * plugin switched off says so here rather than leaving a stale list.
 */

import { h } from '../../src/ui/dom.js';

/** Enough to scan; past it, the search is the way in. */
const SHOWN_MAX = 200;

/**
 * @param {{variables: () => object|null, onPick: (name: string) => void, onRefresh?: () => void}} o
 *        `onRefresh` redraws the shelf where it is mounted — after a search keystroke
 */
export function createVariablesShelf({ variables, onPick, onRefresh = () => {} }) {
  const state = { query: '' };

  const value = (answer) => {
    if (!answer || !answer.ok) return h('span', { class: 'wru-warn', text: answer ? answer.error : 'unknown' });
    if (typeof answer.value === 'string') return h('span', { class: 'aw-text-secondary', text: `"${answer.value}"` });
    return h('span', { text: String(Number.isInteger(answer.value) ? answer.value : Number(answer.value.toFixed(4))) });
  };

  function render() {
    let service = null;
    try { service = variables(); } catch { service = null; }
    if (!service) {
      return h('div', { class: 'lpp-side-body aw-flex-col aw-gap-row-medium' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Variables' }),
        h('div', { class: 'aw-font-body-1 aw-text-secondary', text:
          'The Variables plugin is switched off — Preconfig ▸ LivePremier Plus → Plugins. With it on, $S1.width and your own @names stand wherever a number goes.' }));
    }

    let all = [];
    try { all = service.list(); } catch { all = []; }
    const q = state.query.trim().toLowerCase().replace(/^[$@]/, '');
    const rows = q
      ? all.filter((v) => v.name.toLowerCase().includes(q) || String(v.description || '').toLowerCase().includes(q))
      : all;
    const drawn = rows.slice(0, SHOWN_MAX);

    return h('div', { class: 'lpp-side-body aw-flex-col aw-gap-row-medium' },
      h('input', {
        class: 'wru-input', type: 'search', placeholder: 'Find a variable…', value: state.query,
        spellcheck: 'false', 'data-lpp-key': 'console-var-filter',
        onInput: (ev) => { state.query = ev.target.value; onRefresh(); }
      }),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        'Click a name to put it on the line. $ names are read off the switcher; @ names are yours, set in the Variables panel. Arithmetic goes in brackets: Size ($S1.width / 2) $S1.height.' }),
      rows.length > drawn.length
        ? h('div', { class: 'aw-font-overline aw-text-tertiary', text: `${drawn.length} shown of ${rows.length}` })
        : null,
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        drawn.length
          ? drawn.map((v) => h('div', { class: 'lpp-example aw-flex-row-center-v-space-between aw-gap-col-small', title: v.description || v.definition || '' },
            h('button', {
              class: 'lpp-tab', type: 'button', title: `Put ${v.name} on the line`,
              onClick: () => onPick(v.name)
            }, h('code', { text: v.name })),
            value(v.answer)))
          : h('div', { class: 'wru-empty', text: 'No variable matches that.' })));
  }

  return { render, state };
}
