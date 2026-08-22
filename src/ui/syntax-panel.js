/*
 * The command dictionary, and the macro shelf that is not built yet.
 *
 * Both live in the popout's right-hand tab strip. Neither talks to the device.
 *
 * ## The dictionary is generated, not written
 *
 * Every word, every abbreviation and every category comes from
 * `../vendor/mynah-lang.mjs` — mynah's own build output, the same file the
 * console parses with. A hand-written help page would be a second statement of
 * the grammar, and the two would disagree the first time mynah gained a verb.
 * `keywordTable()` already pairs each keyword with its shortest unambiguous
 * form, which is the one thing an operator actually wants from a reference at
 * a desk: how few letters can I get away with.
 *
 * Search filters on both the full word and the short form, because someone
 * looking up `Me` is as likely to type the abbreviation as the word.
 */

import { h } from './dom.js';
import { keywordTable, CATEGORIES, SLOTS, VERIFIED_FIRMWARE } from '../vendor/mynah-lang.mjs';

/*
 * How the parser's own `kind` values read to a person, and the order they are
 * worth meeting in: what you are doing, what you are doing it to, how it is
 * qualified, and the punctuation that joins them.
 */
const KINDS = [
  ['function', 'Verbs', 'What to do. Every command starts with one.'],
  ['object', 'Objects', 'What to do it to.'],
  ['mode', 'Modes', 'Which copy — program, preview, the stored one.'],
  ['attribute', 'Attributes', 'The property being set.'],
  ['category', 'Categories', 'Groups of attributes, for Select and Clear.'],
  ['clause', 'Clauses', 'Joins one part of a command to the next.'],
  ['operator', 'Operators', 'Ranges and arithmetic over numbers.']
];

/* Worked examples. Written by hand deliberately — these are the commands
   worth knowing on a show day, and no generator knows which those are. Each
   one is parsed by the console unchanged. */
const EXAMPLES = [
  ['Take Screen 1', 'Transition screen 1.'],
  ['Recall Screen 1 Memory 5', 'Load memory 5 into screen 1’s preview.'],
  ['R Sc 1 Th 4 Me 5 Pre', 'The same, over screens 1 to 4, in short form.'],
  ['Store Master 12', 'Save the current state as master memory 12.'],
  ['Select Screen 2 Layer 1 Thru 4', 'Put four layers under the next command.'],
  ['Clear Screen 1', 'Empty the preview.']
];

export function createSyntaxPanel() {
  const state = { query: '' };

  function table() {
    let rows;
    try { rows = keywordTable() || []; } catch { rows = []; }
    const q = state.query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const word = String(r.keyword && r.keyword.word || '').toLowerCase();
      return word.includes(q) || String(r.short || '').toLowerCase().includes(q);
    });
  }

  function render() {
    const rows = table();
    const byKind = new Map();
    for (const r of rows) {
      const kind = (r.keyword && r.keyword.kind) || 'other';
      if (!byKind.has(kind)) byKind.set(kind, []);
      byKind.get(kind).push(r);
    }

    const search = h('input', {
      class: 'wru-input',
      type: 'search',
      placeholder: 'Filter words…',
      value: state.query,
      spellcheck: 'false',
      onInput: (ev) => { state.query = ev.target.value; repaint(); }
    });

    const list = h('div', { class: 'aw-flex-col aw-gap-row-large' });
    const body = h('div', { class: 'lpp-side-body aw-flex-col aw-gap-row-medium' }, search, list);

    function repaint() {
      const filtered = table();
      const groups = new Map();
      for (const r of filtered) {
        const kind = (r.keyword && r.keyword.kind) || 'other';
        if (!groups.has(kind)) groups.set(kind, []);
        groups.get(kind).push(r);
      }
      list.textContent = '';
      if (!filtered.length) {
        list.append(h('div', { class: 'wru-empty', text: 'No word matches that.' }));
      } else {
        for (const [kind, title, blurb] of KINDS) {
          const group = groups.get(kind);
          if (!group || !group.length) continue;
          list.append(section(title, blurb, group));
          groups.delete(kind);
        }
        /* Anything mynah gains a kind for that this file has not met yet is
           still shown, under its own raw name, rather than silently dropped. */
        for (const [kind, group] of groups) list.append(section(kind, '', group));
      }
      /* The reference matter goes at the end, and only when nothing is being
         searched for — it is orientation, not a result. */
      if (!state.query.trim()) list.append(examples(), limits());
    }

    repaint();
    return body;
  }

  function section(title, blurb, rows) {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: title }),
      blurb ? h('div', { class: 'aw-font-caption aw-text-secondary', text: blurb }) : null,
      h('div', { class: 'lpp-words' }, rows.map(word)));
  }

  /* The short form is the point of the row, so it is rendered as the primary
     thing with the full word behind it, not as an afterthought in brackets. */
  function word(row) {
    const full = String(row.keyword && row.keyword.word || '');
    const short = String(row.short || full);
    const rest = full.slice(short.length);
    return h('div', { class: 'lpp-word', title: full },
      h('b', { text: short }),
      rest ? h('span', { class: 'aw-text-tertiary', text: rest }) : null);
  }

  function examples() {
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Worth knowing' }),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        EXAMPLES.map(([cmd, what]) => h('div', { class: 'lpp-example' },
          h('code', { class: 'wru-console-cmd', text: cmd }),
          h('div', { class: 'aw-font-caption aw-text-secondary', text: what })))));
  }

  function limits() {
    const rows = Object.entries(SLOTS || {}).map(([name, range]) =>
      h('div', { class: 'lpp-word' },
        h('b', { text: name }), h('span', { class: 'aw-text-tertiary', text: ` ${range.min}–${range.max}` })));
    return h('div', { class: 'aw-flex-col aw-gap-row-mini' },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Ranges' }),
      h('div', { class: 'lpp-words' }, rows),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text:
        `${(CATEGORIES || []).length} attribute categories · grammar verified against firmware ${VERIFIED_FIRMWARE}` }));
  }

  return { render };
}

/*
 * Macros — a placeholder, and honest about it.
 *
 * The shelf is here now because the popout's right-hand strip is a two-tab
 * strip by design and a strip with one tab in it is not a strip. What goes in
 * it is a real question that has not been answered yet, so the panel says what
 * it is waiting on rather than showing an empty list with a disabled New
 * button, which would read as a feature that is broken.
 */
export function createMacroPanel() {
  const OPEN_QUESTIONS = [
    'Is a macro a list of console lines, or a recorded sequence of device writes?',
    'Does it live with the cue stack, per device, or in a library of its own?',
    'What fires one — a button here, a MIDI note, a cue action, all three?',
    'Can a cue call a macro, and can a macro fire a cue?'
  ];

  function render() {
    return h('div', { class: 'lpp-side-body aw-flex-col aw-gap-row-large' },
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-subtitle-1', text: 'Macros' }),
        h('div', { class: 'aw-font-body-1 aw-text-secondary', text:
          'Not built yet. This is where saved sequences will live, next to the command line that will record them.' })),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Open questions' }),
        OPEN_QUESTIONS.map((q) => h('div', { class: 'lpp-example aw-font-caption aw-text-secondary', text: q }))));
  }

  return { render };
}
