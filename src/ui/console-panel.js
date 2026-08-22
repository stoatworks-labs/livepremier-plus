/*
 * Console — the command line, inside Web RCS.
 *
 * Four languages on one line, and which one a line is written in is settled
 * before anything is sent. The default is to work it out from the line's own
 * shape; Settings can pin it to one, and any line may declare its own with a
 * leading word.
 *
 *   Recall Screen 1 Memory 5                                        Mynah
 *   R Sc 1 Th 4 Me 5 Pre
 *   AWJ DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake = true
 *   {"path":["device","screenAuxGroupList",…],"value":true}         JSON
 *   /lp/screen/1/take                                               OSC
 *
 * Mynah is the language for driving a show. The other three are for the times
 * a show is not going well — a path out of a packet capture, a frame out of a
 * browser's network panel, an address a lighting desk is already sending —
 * each of which an operator already has in front of them, and translating one
 * by hand costs a typo on a live frame.
 *
 * ## This panel owns no grammar
 *
 * Every token, rule and device path comes from `../vendor/mynah-lang.mjs`,
 * which is mynah's own build output — all four languages, not just the first.
 * This file is a front-end: it collects keystrokes, shows what the parser
 * thinks, and hands compiled ops to the session. If a command means the wrong
 * thing, the fix is in mynah.
 *
 * That matters more than it sounds. Mynah's compiler and this repo's `CMD`
 * builder were derived independently, and they emit **byte-identical** store
 * paths for the commands both know — `Take Screen 1` and
 * `Recall Screen 1 Memory 5` agree segment for segment. Two independent
 * derivations agreeing is the strongest evidence either is right, and it is
 * only true while nobody re-types the grammar here.
 *
 * ## Where a compiled line goes
 *
 * Nearly always the same place: `session.send()`, riding the vendor's own
 * socket, whichever language it was typed in. `Path` holds both spellings of
 * one address, so an AWJ message converts to a store write and lands at the
 * identical node.
 *
 * Two cases leave that way instead through `POST /__lpp/awj`, a real TCP
 * 10606 socket opened by the server process:
 *
 *  - the operator chose that transport for AWJ in Settings, because they want
 *    the message on the wire in the form they typed it;
 *  - the line contains a `{"op":"get",…}`, which nothing else can answer. The
 *    Web RCS socket is a stream of changes, not a request and its answer.
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
  run, declared, sniff, completions, shortestForm, KEYWORDS, LANGUAGE_LABELS
} from '../vendor/mynah-lang.mjs';
import { PARAMS } from '../core/osc-dictionary.js';
import { presetBanks } from '../core/screens.js';
import { DEFAULT_SETTINGS } from '../core/settings.js';

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
    hint: null,
    /* Held here rather than fetched per keystroke. Refreshed when the panel
       mounts and whenever the settings page says it changed, so the tab and
       the popped-out window cannot drift apart on which language is chosen. */
    settings: { ...DEFAULT_SETTINGS },
    /* What the line currently being typed is being read as. Shown live,
       because a line read as the wrong language produces an error about a
       character rather than about a command, and that reads like the
       operator's own typo. */
    language: null
  };

  /** Pull the settings from the process that owns them. */
  async function loadSettings() {
    try {
      const res = await fetch('/__lpp/settings', { headers: { 'Cache-Control': 'no-cache' } });
      if (!res.ok) return;
      const body = await res.json();
      if (body && body.settings) { state.settings = body.settings; onRefresh(); }
    } catch {
      /* The defaults are usable. A console that refused to open because a
         settings fetch failed would be the worse outcome by a distance. */
    }
  }
  void loadSettings();

  /**
   * Which preset buffer a typed `preview` or `program` names, right now.
   *
   * The one device fact the languages need and cannot work out alone: those
   * two words name whichever buffer is pending or live, and a take swaps
   * them. Answered from the store mirror when the device has said, and
   * `undefined` when it has not — at which point the command is refused with
   * that reason rather than landing a layer move in the wrong buffer.
   */
  function bufferForMode(target, mode) {
    const id = target.kind === 'screen' ? `S${target.n}` : `A${target.n}`;
    const banks = presetBanks(session.store, id);
    if (!banks.reported) return undefined;
    return mode === 'PROGRAM' ? banks.program : banks.preview;
  }

  const runContext = () => ({
    language: state.settings.consoleLanguage,
    osc: { params: PARAMS, buffer: bufferForMode }
  });

  /**
   * What the compiler actually said.
   *
   * A failed run is `{ok:false, errors:[{message}]}` — there is no `.error`,
   * and reading for one meant every refusal in the language showed as the bare
   * words "cannot compile" for as long as this panel has existed. The
   * compiler's messages are the useful part: they name which end of a patch is
   * the wrong way round, or how far past the end of a destination a run would
   * have gone.
   */
  function compileError(result) {
    const first = result && result.errors && result.errors[0];
    return (first && first.message) || 'cannot compile';
  }

  function note(kind, text, detail, label) {
    state.log.unshift({ at: Date.now(), kind, text, detail, label });
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
  }

  /**
   * Parse for feedback only.
   *
   * A failure while typing is completely normal — every command is a sequence
   * of invalid prefixes until its last word — so this never shows an error for
   * an incomplete line, only for one the parser can say something useful about.
   *
   * The detected language is settled here too. It is only shown when the
   * operator has left the choice on `All`; with a language pinned there is
   * nothing being decided and a label saying so would be noise.
   */
  function preview(text) {
    state.error = null;
    state.hint = null;
    state.language = null;
    if (!text.trim()) return;

    if (state.settings.consoleLanguage === 'all') {
      const head = declared(text);
      const id = head.language || sniff(head.body);
      state.language = head.language
        ? `${LANGUAGE_LABELS[id]} (declared)`
        : LANGUAGE_LABELS[id];
    }

    let result;
    try { result = run(text, runContext()); } catch { return; }
    if (!result) return;

    if (result.ok === false) {
      const first = (result.errors || [])[0];
      /* "Unknown keyword" on the final, still-being-typed word is noise —
         every Mynah command is a sequence of invalid prefixes until it is
         finished. The raw languages carry no spans, so their errors have no
         end to compare and are shown as soon as they are known, which is
         right: half a JSON object is not a prefix of anything useful. */
      const atEnd = first && first.end !== undefined && first.end >= text.trimEnd().length;
      if (first && !atEnd) state.error = first.message;
      return;
    }

    if (result.summary) state.hint = result.summary;

    /* Said before Enter, because the alternative is a command that appears to
       run and then reports nothing back. */
    if (result.reads.length > 0 && result.ops.length === 0) {
      state.hint = `${result.summary} — answered over a real AWJ socket`;
    }
  }

  /** Execute the line. This is the only path that writes to the device. */
  function execute() {
    const text = state.line.trim();
    if (!text) return;

    state.history.unshift(text);
    if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
    state.historyAt = -1;

    let result;
    try { result = run(text, runContext()); } catch (err) {
      note('error', text, err.message);
      return finish();
    }
    if (!result || result.ok === false) {
      note('error', text, compileError(result));
      return finish();
    }

    const label = LANGUAGE_LABELS[result.language] || result.language;
    const ops = result.ops || [];
    const reads = result.reads || [];

    if (!ops.length && !reads.length) {
      /* An OSC button release compiles to nothing, and that is correct rather
         than empty. Its own summary says so; anything else genuinely had
         nothing to send. */
      note('warn', text, result.summary || 'nothing to send', label);
      return finish();
    }

    /* A read can only be answered on a real socket, and an AWJ message goes
       out on one when the operator asked for that. Everything else rides the
       vendor's connection — see the note at the top of this file. */
    const wantsSocket =
      reads.length > 0 ||
      (result.language === 'awj' && state.settings.awjTransport === 'socket');

    if (wantsSocket) {
      void viaAwjSocket(text, result, label);
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
        note('error', text, 'send failed: ' + err.message, label);
        return finish();
      }
    }

    /* Reported as sent, never as confirmed: this protocol answers nothing, and
       a tick on a command that changed nothing is worse than no feedback. */
    note(sent === ops.length ? 'ok' : 'warn', text,
      `${result.summary || 'sent'} — ${sent}/${ops.length} write${ops.length === 1 ? '' : 's'} sent`,
      label);
    finish();
  }

  /**
   * Send a line over a real AWJ socket, through the server process.
   *
   * The reply is the whole reason for the route: a `get` has nowhere to answer
   * from on the vendor's socket, which carries changes rather than answers.
   *
   * The log entry is written first and then amended, because this is the only
   * path in the panel that takes measurable time — a command that vanished for
   * two seconds and then reappeared would read as a dropped keystroke.
   */
  async function viaAwjSocket(text, result, label) {
    const messages = [
      ...result.ops.map((op) => ({ op: 'replace', path: op.path.toAwj(), value: op.value })),
      ...result.reads.map((r) => ({ op: 'get', path: r.path.toAwj() }))
    ];

    const entry = { at: Date.now(), kind: 'warn', text, detail: 'AWJ 10606 — sending…', label };
    state.log.unshift(entry);
    if (state.log.length > LOG_MAX) state.log.length = LOG_MAX;
    onRefresh();

    try {
      const res = await fetch('/__lpp/awj', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages })
      });
      const body = await res.json().catch(() => ({}));

      if (!res.ok) {
        entry.kind = 'error';
        entry.detail = body.error || `AWJ failed — HTTP ${res.status}`;
      } else if (body.replies && body.replies.length) {
        entry.kind = 'ok';
        entry.detail = body.replies
          .map((r) => `${r.path} = ${JSON.stringify(r.value)}`)
          .join('   ');
      } else if (result.reads.length) {
        /* A get that answered nothing. Not a failure of ours — the likeliest
           cause is a path this firmware does not have, and AWJ says so by
           saying nothing at all. */
        entry.kind = 'warn';
        entry.detail = 'no reply — the path may not exist on this firmware';
      } else {
        /* A replace is answered with silence on this protocol too. Saying it
           was sent is the honest reading; whether the device liked it is a
           question only a get can answer. */
        entry.kind = 'ok';
        entry.detail = `${result.summary} — sent on TCP 10606, which does not acknowledge a write`;
      }
    } catch (err) {
      entry.kind = 'error';
      entry.detail = `AWJ failed: ${err.message}`;
    }
    onRefresh();
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
    if (isEnter(ev)) { ev.preventDefault(); execute(); return; }
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

    const feedback = h('div', { class: 'wru-console-feedback aw-flex-row-center-v aw-gap-col-small' });
    function paintFeedback() {
      feedback.textContent = '';
      /* The language first, so the verdict sits to the left of the message it
         produced. An error from a line that was read as the wrong language is
         only diagnosable if the two are side by side. */
      if (state.language) {
        feedback.append(h('span', { class: 'wru-tag wru-console-lang', text: state.language }));
      }
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
      /* Which language this line actually ran as. Kept on the row rather than
         only on the live feedback, because the question "why did that not do
         what I meant" is usually asked about a line several commands back. */
      entry.label
        ? h('span', { class: 'wru-tag wru-console-lang', text: entry.label })
        : null,
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

  /*
   * The settings page broadcasts on this after a save.
   *
   * The console exists in two windows at once — the tab and the popout — and
   * a change made on the settings page has to reach both. A DOM event on
   * `window` is enough for the tab; the popout listens on its opener's window,
   * which is the same object it already drives the session through.
   */
  const onSettings = (ev) => {
    if (ev && ev.detail) { state.settings = ev.detail; onRefresh(); }
    else void loadSettings();
  };
  window.addEventListener('lpp:settings', onSettings);
  try {
    if (window.opener && window.opener !== window) {
      window.opener.addEventListener('lpp:settings', onSettings);
    }
  } catch { /* a cross-origin opener is not ours to listen to */ }

  return { render, state, popOut, reloadSettings: loadSettings };
}

/** The keyword table, for a help view. Exposed so tests can assert on it. */
export const keywordCount = () => (Array.isArray(KEYWORDS) ? KEYWORDS.length : Object.keys(KEYWORDS).length);
export { shortestForm, icon };
