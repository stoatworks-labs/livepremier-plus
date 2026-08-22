/*
 * Console — Mynah's command line, inside Web RCS.
 *
 * A lighting-desk command line for a video switcher: verb first, keyword
 * abbreviation, `Thru`/`+`/`-` ranges, Enter to execute.
 *
 *   Recall Screen 1 Memory 5
 *   R Sc 1 Th 4 Me 5 Pre
 *   Store Master 12
 *   Take Screen 1
 *
 * ## This panel owns no grammar
 *
 * Every token, rule and device path comes from `../vendor/mynah-lang.mjs`,
 * which is mynah's own build output. This file is a front-end: it collects
 * keystrokes, shows what the parser thinks, and hands compiled ops to the
 * session. If a command means the wrong thing, the fix is in mynah.
 *
 * That matters more than it sounds. Mynah's compiler and this repo's `CMD`
 * builder were derived independently, and they emit **byte-identical** store
 * paths for the commands both know — `Take Screen 1` and
 * `Recall Screen 1 Memory 5` agree segment for segment. Two independent
 * derivations agreeing is the strongest evidence either is right, and it is
 * only true while nobody re-types the grammar here.
 *
 * ## Nothing is sent until Enter
 *
 * The line parses as you type, purely for feedback. Compilation and sending
 * happen on Enter and nowhere else, because a half-typed `Take Screen 1` is a
 * prefix of a command that puts something on air.
 */

import { h, button, icon, isEnter } from './dom.js';
import { panel } from './shell.js';
import {
  parse, compile, completions, shortestForm, KEYWORDS
} from '../vendor/mynah-lang.mjs';

const HISTORY_MAX = 100;
const LOG_MAX = 200;

/**
 * @param {object} opts
 * @param {boolean} [opts.popoutEnabled] show the Pop out button. False inside
 *   the popout itself, which has nowhere further to go.
 */
export function createConsolePanel({ session, onRefresh = () => {}, popoutEnabled = true } = {}) {
  /* Kept outside render() so a repaint driven by device traffic does not wipe
     what the operator is halfway through typing. */
  const state = {
    line: '',
    caret: 0,
    history: [],
    historyAt: -1,
    log: [],
    error: null,
    hint: null
  };

  function note(kind, text, detail) {
    state.log.unshift({ at: Date.now(), kind, text, detail });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
  }

  /**
   * Parse for feedback only.
   *
   * A failure while typing is completely normal — every command is a sequence
   * of invalid prefixes until its last word — so this never shows an error for
   * an incomplete line, only for one the parser can say something useful about.
   */
  function preview(text) {
    state.error = null;
    state.hint = null;
    if (!text.trim()) return;
    let result;
    try { result = parse(text); } catch { return; }
    if (result && result.ok === false) {
      const first = (result.errors || [])[0];
      /* "Unknown keyword" on the final, still-being-typed word is noise. */
      const atEnd = first && first.end >= text.trimEnd().length;
      if (first && !atEnd) state.error = first.message;
      return;
    }
    try {
      const compiled = compile(result.command ?? result);
      if (compiled && compiled.ok && compiled.summary) state.hint = compiled.summary;
      else if (compiled && compiled.ok === false) state.error = compiled.error || 'cannot compile';
    } catch { /* incomplete is not an error */ }
  }

  /** Execute the line. This is the only path that writes to the device. */
  function run() {
    const text = state.line.trim();
    if (!text) return;

    state.history.unshift(text);
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    state.historyAt = -1;

    let parsed;
    try { parsed = parse(text); } catch (err) {
      note('error', text, err.message);
      return finish();
    }
    if (parsed && parsed.ok === false) {
      const first = (parsed.errors || [])[0];
      note('error', text, first ? first.message : 'could not parse');
      return finish();
    }

    let compiled;
    try { compiled = compile(parsed.command ?? parsed); } catch (err) {
      note('error', text, err.message);
      return finish();
    }
    if (!compiled || compiled.ok === false) {
      note('error', text, (compiled && compiled.error) || 'could not compile');
      return finish();
    }

    const ops = compiled.ops || [];
    if (!ops.length) {
      note('warn', text, 'nothing to send');
      return finish();
    }

    /* `toWs()` is mynah's own store-path form, and it is the same shape
       core/paths.js builds. Sent through the session so these writes ride the
       vendor's socket like every other one — no second connection. */
    let sent = 0;
    for (const op of ops) {
      try {
        if (session.send({ path: op.path.toWs(), value: op.value })) sent++;
      } catch (err) {
        note('error', text, 'send failed: ' + err.message);
        return finish();
      }
    }

    /* Reported as sent, never as confirmed: this protocol answers nothing, and
       a tick on a command that changed nothing is worse than no feedback. */
    note(sent === ops.length ? 'ok' : 'warn', text,
      `${compiled.summary || 'sent'} — ${sent}/${ops.length} write${ops.length === 1 ? '' : 's'} sent`);
    finish();
  }

  function finish() {
    state.line = '';
    state.error = null;
    state.hint = null;
    onRefresh();
  }

  function recallHistory(delta) {
    if (!state.history.length) return;
    const next = state.historyAt + delta;
    if (next < 0) { state.historyAt = -1; state.line = ''; }
    else {
      state.historyAt = Math.min(next, state.history.length - 1);
      state.line = state.history[state.historyAt];
    }
    preview(state.line);
    onRefresh();
  }

  /** Complete the word under the caret, when exactly one keyword matches. */
  function complete() {
    const words = state.line.split(/\s+/);
    const last = words[words.length - 1];
    if (!last) return;
    let options = [];
    try { options = completions(last) || []; } catch { return; }
    if (options.length === 1) {
      words[words.length - 1] = options[0].keyword ?? options[0];
      state.line = words.join(' ') + ' ';
      preview(state.line);
    } else if (options.length > 1) {
      state.hint = options.slice(0, 8).map((o) => o.keyword ?? o).join('  ');
    }
    onRefresh();
  }

  function onKeyDown(ev) {
    if (isEnter(ev)) { ev.preventDefault(); run(); return; }
    if (ev.key === 'Tab') { ev.preventDefault(); complete(); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); recallHistory(+1); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); recallHistory(-1); return; }
    if (ev.key === 'Escape') { ev.preventDefault(); state.line = ''; state.error = null; state.hint = null; onRefresh(); }
    /* Everything else is ordinary typing. Crucially, the keystroke must not
       reach the vendor's own shortcut handling from inside our field. */
    ev.stopPropagation();
  }

  function render() {
    const input = h('input', {
      class: 'wru-input wru-console-input',
      type: 'text',
      value: state.line,
      placeholder: 'Recall Screen 1 Memory 5',
      spellcheck: 'false',
      autocomplete: 'off',
      onInput: (ev) => { state.line = ev.target.value; preview(state.line); paintFeedback(); },
      onKeyDown
    });

    const feedback = h('div', { class: 'wru-console-feedback' });
    function paintFeedback() {
      feedback.textContent = '';
      if (state.error) {
        feedback.append(h('span', { class: 'wru-tag wru-warn', text: state.error }));
      } else if (state.hint) {
        feedback.append(h('span', { class: 'wru-tag', text: state.hint }));
      }
    }
    paintFeedback();

    const body = h('div', { class: 'aw-flex-col aw-gap-row-medium' },
      h('div', { class: 'wru-console-line aw-flex-row-center-v aw-gap-col-small' },
        h('span', { class: 'wru-console-caret aw-text-tertiary', text: '>' }),
        input),
      feedback,
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'History' }),
      state.log.length
        ? h('div', { class: 'wru-console-log aw-flex-col' }, state.log.map(logRow))
        : h('div', { class: 'wru-empty', text: 'Nothing run yet. Enter executes; Tab completes; ↑ recalls.' }));

    /* Focus after the panel is in the document, or the caret goes nowhere. */
    queueMicrotask(() => { try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch {} });

    return panel({ toolbar: toolbar(), body });
  }

  function logRow(entry) {
    const tone = entry.kind === 'ok' ? 'wru-console-ok'
      : entry.kind === 'warn' ? 'wru-console-warn' : 'wru-console-err';
    return h('div', { class: ['wru-console-row', tone] },
      h('code', { class: 'wru-console-cmd', text: entry.text }),
      h('span', { class: 'wru-console-detail aw-text-secondary', text: entry.detail || '' }));
  }

  /**
   * Open the big console in a window of its own.
   *
   * Reused rather than re-opened: a second click focuses the window that is
   * already up. Two of these would each hold a reference to this session and
   * each run their own snapshot clock, which is twice the traffic to the
   * switcher for one operator.
   *
   * The popout is not offered inside the popout — `popout` is only defined
   * where there is somewhere to pop out *from*.
   */
  let child = null;
  function popOut() {
    if (child && !child.closed) { child.focus(); return; }
    child = window.open('/__lpp/console', 'lpp-console',
      'width=1400,height=900,menubar=no,toolbar=no,location=no');
    if (!child) {
      note('warn', 'pop out', 'the browser blocked the window — allow pop-ups for this address');
      onRefresh();
    }
  }

  function toolbar() {
    const live = session.state === 'live';
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Console' }),
      h('span', {
        class: ['wru-tag', live ? '' : 'wru-warn'],
        text: live ? 'connected' : session.state
      }),
      h('div', { style: { flex: '1' } }),
      popoutEnabled
        ? button('Pop out', {
          iconId: 'set-layer-to-fullscreen-18',
          title: 'Open the console in its own window, with screen previews and the command dictionary',
          onClick: popOut
        })
        : null,
      button('Clear', { onClick: () => { state.log = []; onRefresh(); }, variant: 'ghost' }));
  }

  return { render, state, popOut };
}

/** The keyword table, for a help view. Exposed so tests can assert on it. */
export const keywordCount = () => (Array.isArray(KEYWORDS) ? KEYWORDS.length : Object.keys(KEYWORDS).length);
export { shortestForm, icon };
