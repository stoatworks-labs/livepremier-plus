/*
 * Timer Image — the page, under PLUS.
 *
 * Top to bottom in the order the work is done: where the picture goes, where
 * the time comes from, how it looks (with a preview drawn by the same code
 * that draws the PNG), how it goes on air, and what the last pushes did —
 * the upload-to-picture time is the number hardware day is for.
 *
 * Immediate-mode like every panel here: rebuilt when what it shows changes
 * (about once a second while a clock runs), left alone while the pointer is
 * down in it. `ui/keep-focus.js` keeps a field's typing across a rebuild.
 */

import { h, note, button } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { SOURCES, PRECISIONS, PLACES, TYPE_WORDS, SIZE_LIMITS, formatDuration } from './core.js';
import { drawPreview } from './render.js';

const STATE_WORDS = {
  off: 'off', connecting: 'connecting…', live: 'live', polling: 'reading every 5 s (the live feed is down)',
  error: 'trying again', refused: 'refused'
};

export function createTimerPanel({ ready, doc, change, screens, frames, timers, plan, reading, spec, status, stagetimer, actions }) {
  let root = null;
  let shown = null;
  let pressed = false;
  let keyDraft = '';
  let roomDraft = null;

  const select = (choices, current, onPick, attrs = {}) =>
    h('select', { class: 'wru-input', onChange: (ev) => onPick(ev.target.value), ...attrs },
      choices.map((c) => h('option', { value: c.id, selected: c.id === current ? 'selected' : null, text: c.label })));

  const labelled = (label, control, flex = '1 1 6rem') =>
    h('label', { class: 'aw-flex-col aw-gap-row-mini', style: { flex, minWidth: '0' } },
      h('div', { class: 'aw-font-overline aw-text-tertiary', text: label }), control);

  const heading = (text) => h('div', { class: 'aw-font-subtitle-2', text });
  const row = (...kids) => h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' }, ...kids);
  const section = (...kids) => h('div', { class: 'aw-flex-col aw-gap-row-small' }, ...kids);
  const set = (patch) => change({ ...doc(), ...patch });
  const setStyle = (patch) => change({ ...doc(), style: { ...doc().style, ...patch } });

  const number = (value, onSet, attrs) => h('input', {
    type: 'number', class: 'wru-input', value: String(value), style: { width: '5.5rem' },
    onChange: (ev) => onSet(Number(ev.target.value)), ...attrs
  });

  /* ---------------------------------------------------------------- where */

  function frameWords(f) {
    if (f.librarySlot === 'NONE') return 'empty';
    return `slot ${f.librarySlot}${f.valid ? ` · ${f.width}×${f.height}` : ' (empty slot)'}`;
  }

  function whereSection(d, st) {
    const list = screens();
    const fs = frames(d.screen);
    const p = plan();
    const locked = st.running;
    const screenSel = select(list.map((s) => ({ id: s.id, label: `${s.id}${s.label ? ` ${s.label}` : ''} · ${s.width}×${s.height}` })), d.screen,
      (v) => set({ screen: v }), { 'aria-label': 'Screen', disabled: locked ? 'disabled' : null });
    const frameSel = select(fs.map((f) => ({ id: String(f.index), label: `FRG${f.index}${f.label ? ` ${f.label}` : ''} · ${frameWords(f)}` })), String(d.frame),
      (v) => set({ frame: Number(v) }), { 'aria-label': 'Foreground Image', disabled: locked ? 'disabled' : null });
    let say = null;
    if (p && !p.ok) say = note('warn', p.problems.join(' '));
    else if (p && p.current) say = note('', `FRG${d.frame} shows this app's picture in library slot ${p.current}. The next one goes into slot ${p.predicted}, then slot ${p.current} is emptied.`);
    else if (p) say = note('', `The first picture goes into empty library slot ${p.predicted}, and FRG${d.frame} is pointed at it, 1:1. Each later one takes the next empty slot and the one before is emptied — two slots at most.`);
    return section(
      heading('Where'),
      row(labelled('Screen', screenSel, '1 1 9rem'), labelled('Foreground Image', frameSel, '1 1 12rem')),
      say,
      locked ? note('', 'Stop the timer to move it to another screen or Foreground Image.') : null);
  }

  /* --------------------------------------------------------------- source */

  function switcherSource(d) {
    const list = timers();
    const t = list.find((x) => x.key === d.timer);
    const words = (x) => {
      const type = TYPE_WORDS[x.type] || x.type.toLowerCase();
      const extra = x.type === 'COUNTDOWN' ? ` ${formatDuration(x.countdownDuration, x.unitMode)}` : '';
      return `Timer ${x.n}${x.label ? ` ${x.label}` : ''} · ${type}${extra}`;
    };
    const r = reading();
    const controls = t && t.type !== 'CURRENT_TIME'
      ? row(
        button('Start', { onClick: () => actions.timer('xStart'), title: `Start Timer ${t.n} on the switcher (or resume it)` }),
        button('Pause', { onClick: () => actions.timer('xPause'), title: `Pause Timer ${t.n} on the switcher` }),
        button('Stop', { onClick: () => actions.timer('xStop'), title: `Stop and reset Timer ${t.n} on the switcher` }))
      : null;
    return [
      row(labelled('Timer', select(list.map((x) => ({ id: x.key, label: words(x) })), d.timer, (v) => set({ timer: v }), { 'aria-label': 'Switcher timer' }), '1 1 12rem')),
      controls,
      t && t.type === 'CURRENT_TIME'
        ? note('', `A time of day: this computer's clock${t.timeOffset ? ` ${t.timeOffset > 0 ? '+' : '−'} ${formatDuration(Math.abs(t.timeOffset), 'IN_HOURS')}` : ''}, not the switcher's own, which it does not publish. Set the timer's type, format and offset on the switcher's Multiviewer page.`)
        : note('', 'The switcher publishes a timer’s state, not its time, so it is timed here from the Start, Pause and Stop it is seen to get — from these buttons, the switcher’s own page or its front panel. Type, duration and format are set on the switcher’s Multiviewer page.'),
      r.known ? null : note('warn', r.why || 'Not known yet.')
    ];
  }

  function stagetimerSource() {
    const s = stagetimer() || {};
    if (roomDraft === null) roomDraft = s.roomId || '';
    const room = h('input', {
      type: 'text', class: 'wru-input', value: roomDraft, placeholder: 'Room ID', autocomplete: 'off', spellcheck: 'false',
      dataset: { lppKey: 'timer-image-room' }, onInput: (ev) => { roomDraft = ev.target.value; }
    });
    const key = h('input', {
      type: 'password', class: 'wru-input', value: keyDraft, autocomplete: 'off',
      placeholder: s.keySet ? 'A key is set — type to replace it' : 'API key (Stagetimer ▸ Room ▸ API)',
      dataset: { lppKey: 'timer-image-key' }, onInput: (ev) => { keyDraft = ev.target.value; }
    });
    const saveCreds = () => { const patch = { roomId: roomDraft }; if (keyDraft) patch.apiKey = keyDraft; keyDraft = ''; void actions.saveStagetimer(patch); };
    const state = s.enabled ? (STATE_WORDS[s.state] || s.state || 'off') : 'off';
    const r = reading();
    return [
      row(labelled('Room ID', room, '1 1 10rem'), labelled('API key', key, '1 1 12rem')),
      row(
        button('Save', { onClick: saveCreds, title: 'Keep this room and key on this computer. The key is never sent back to a page.' }),
        button(s.enabled ? 'Disconnect' : 'Connect', { onClick: () => void actions.saveStagetimer({ enabled: !s.enabled }), active: Boolean(s.enabled) }),
        button('Test', { onClick: () => void actions.testStagetimer(), title: 'Check the room ID and key with Stagetimer' }),
        s.keySet ? button('Forget key', { onClick: () => void actions.saveStagetimer({ clearKey: true, enabled: false }) }) : null),
      note(s.state === 'refused' || s.state === 'error' ? 'warn' : '',
        `Stagetimer: ${state}${s.roomName ? ` · ${s.roomName}` : ''}${s.timerName ? ` · current timer “${s.timerName}”` : ''}${s.error ? ` — ${s.error}` : ''}`),
      s.test ? note(/good/.test(s.test) ? '' : 'warn', s.test) : null,
      s.enabled && !r.known ? note('warn', r.why || 'Not known yet.') : null,
      note('', 'The room’s current timer, as Stagetimer shows it: countdown, count-up or time of day, with its wrap-up colours. Its feed carries the start and finish times, so the countdown is right whenever this app joined.')
    ];
  }

  function sourceSection(d) {
    return section(
      heading('Time from'),
      row(labelled('Source', select(SOURCES, d.source, (v) => set({ source: v }), { 'aria-label': 'Source', title: SOURCES.find((x) => x.id === d.source).what }), '1 1 10rem'),
        labelled('Precision', select(PRECISIONS, d.precision, (v) => set({ precision: v }), { 'aria-label': 'Precision', title: PRECISIONS.find((x) => x.id === d.precision).what }), '0 0 7rem')),
      ...(d.source === 'stagetimer' ? stagetimerSource() : switcherSource(d)));
  }

  /* ----------------------------------------------------------------- look */

  function lookSection(d) {
    const s = d.style;
    const colour = (value, onSet, label) => h('input', { type: 'color', value, 'aria-label': label, style: { width: '2.5rem', height: '1.8rem' }, onInput: (ev) => onSet(ev.target.value) });
    const canvas = h('canvas', {
      class: 'lpp-timer-preview', width: String(s.width), height: String(s.height),
      style: { width: '100%', maxWidth: `${Math.min(s.width, 480)}px`, height: 'auto', background: 'repeating-conic-gradient(#3a4048 0% 25%, #2a2f36 0% 50%) 50% / 16px 16px', borderRadius: '0.15rem' }
    });
    try { drawPreview(canvas, spec()); } catch { /* no canvas here (tests) */ }
    const check = (on, onSet, text, title) => h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', title },
      h('input', { type: 'checkbox', checked: on ? 'checked' : null, onChange: (ev) => onSet(ev.target.checked) }), h('span', { class: 'aw-font-body-2', text }));
    return section(
      heading('Look'),
      row(
        labelled('Width', number(s.width, (v) => setStyle({ width: v }), { min: String(SIZE_LIMITS.minWidth), max: String(SIZE_LIMITS.maxWidth), 'aria-label': 'Width, pixels', dataset: { lppKey: 'timer-image-w' } }), '0 0 auto'),
        labelled('Height', number(s.height, (v) => setStyle({ height: v }), { min: String(SIZE_LIMITS.minHeight), max: String(SIZE_LIMITS.maxHeight), 'aria-label': 'Height, pixels', dataset: { lppKey: 'timer-image-h' } }), '0 0 auto'),
        labelled('Text', colour(s.colour, (v) => setStyle({ colour: v }), 'Text colour'), '0 0 auto'),
        labelled('Box', colour(s.background, (v) => setStyle({ background: v }), 'Box colour'), '0 0 auto'),
        labelled('Label', h('input', { type: 'text', class: 'wru-input', value: s.label, maxlength: '40', placeholder: 'none', dataset: { lppKey: 'timer-image-label' }, onChange: (ev) => setStyle({ label: ev.target.value }) }), '1 1 7rem')),
      row(
        check(s.transparent, (v) => setStyle({ transparent: v }), 'Transparent box', 'No box behind the text. Whether a Pulse keys out a PNG’s transparency on a Foreground Image has not been seen; on the simulator nothing can show it.'),
        check(s.phaseColours, (v) => setStyle({ phaseColours: v }), 'Warning colours', 'Yellow and red as Stagetimer’s wrap-up times say, red once a countdown is over, grey while the time is unknown.')),
      canvas,
      s.transparent ? note('warn', 'Unproven: a Pulse may draw the transparent parts black. Check on a monitor before it goes on air.') : null);
  }

  /* --------------------------------------------------------------- on air */

  function airSection(d) {
    return section(
      heading('On air'),
      note('', `The picture is FRG${d.frame} of ${d.screen}: it shows wherever a preset’s top layer selects FRG${d.frame}. Put it on the preview’s top layer here, check it, and take — the same as a logo.`),
      row(
        labelled('Place', select(PLACES, d.place, (v) => set({ place: v }), { 'aria-label': 'Place on the screen' }), '1 1 8rem'),
        labelled('Margin', number(d.margin, (v) => set({ margin: v }), { min: '0', max: '500', 'aria-label': 'Margin from the edges, pixels', dataset: { lppKey: 'timer-image-margin' } }), '0 0 auto'),
        button('Show on preview', { onClick: () => void actions.showOnPreview(), title: `Set ${d.screen}'s preview top layer to FRG${d.frame} at this place. Never program.` })));
  }

  /* --------------------------------------------------------------- status */

  function timingWords(t) {
    if (!t || !t.count) return null;
    const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v} ms`);
    return `Last ${t.count} push${t.count === 1 ? '' : 'es'}: median ${ms(t.median)}, 90% within ${ms(t.p90)} (upload ${ms(t.upload)}, point ${ms(t.point)}, empty old slot ${ms(t.remove)})${t.failed ? `, ${t.failed} failed` : ''}.`;
  }

  function statusSection(d, st) {
    const mine = st.runner ? st.local : (st.report || {});
    const t = st.runner ? st.local.timings : (st.report && st.report.timings);
    const lines = [];
    if (!st.connected) lines.push(note('warn', 'No tick from this app’s server yet.'));
    else if (st.running && !st.runner) lines.push(note('', 'Another open page is running the timer; this one is watching.'));
    /* Only while the switcher still has the frame on that slot: after a
       Remove, or a change in the vendor's page, the last push is history. */
    const onFrame = frames(d.screen).find((f) => f.index === d.frame);
    const still = mine && mine.text && mine.slot && onFrame && onFrame.librarySlot === String(mine.slot)
      && (mine.screen == null || (mine.screen === d.screen && mine.frame === d.frame));
    if (still) lines.push(note('', `On ${d.screen} FRG${d.frame}: “${mine.text}” from library slot ${mine.slot}.`));
    if (st.busy && st.busyText) lines.push(note('', `Pushing “${st.busyText}”…`));
    const tw = timingWords(t);
    if (tw) lines.push(note('', tw));
    if (mine && mine.skipped) lines.push(note('', `${mine.skipped} tick${mine.skipped === 1 ? '' : 's'} came while a push was still going; each was drawn as soon as that push finished.`));
    if (mine && mine.message) lines.push(note('', mine.message));
    if (mine && mine.error) lines.push(note('warn', mine.error));
    return section(
      heading('Pushes'),
      ...lines,
      st.running ? null : row(button('Remove picture', {
        onClick: () => void actions.remove(), disabled: st.busy,
        title: `Point ${d.screen} FRG${d.frame} at nothing and empty this app's library slots for it. A preset showing FRG${d.frame} then shows nothing there.`
      })));
  }

  /* -------------------------------------------------------------- toolbar */

  function toolbar(d, st) {
    const p = plan();
    const r = reading();
    return h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' },
      h('div', { class: 'aw-font-subtitle-1', text: 'Timer Image' }),
      h('div', { class: ['aw-font-body-1-bold', st.running ? 'aw-text-success' : 'aw-text-tertiary'], text: st.running ? `Running · ${r.text}` : 'Stopped' }),
      st.running
        ? button('Stop', { onClick: () => void actions.stop(), title: 'Stop updating. The last picture stays on the Foreground Image.' })
        : button('Start', { onClick: () => void actions.start(), disabled: !p || !p.ok, title: p && !p.ok ? p.problems[0] : `Keep ${d.screen} FRG${d.frame} showing the time` }));
  }

  return {
    busy: () => pressed,
    render() {
      if (!ready()) return panel({ toolbar: h('div', { class: 'aw-font-subtitle-1', text: 'Timer Image' }), body: note('', 'Waiting for the switcher…') });
      const d = doc();
      const st = status();
      const sig = JSON.stringify([d, st, reading(), stagetimer(), plan(), screens(), frames(d.screen), timers(), keyDraft.length]);
      if (root && sig === shown) return root;
      shown = sig;
      root = panel({
        toolbar: toolbar(d, st),
        body: h('div', {
          class: 'aw-flex-col aw-gap-row-large aw-padding-medium', style: { maxWidth: '44rem' },
          onPointerdown: () => { pressed = true; }, onPointerup: () => { pressed = false; }, onPointerleave: () => { pressed = false; }
        },
        note('warn', 'Preview: this page has run on the Midra 4K simulator only. On a real Pulse 4K the same upload-repoint-delete took about 140 ms a push, from a test script, never on air. The timings below are this switcher’s own.'),
        whereSection(d, st),
        sourceSection(d),
        lookSection(d),
        airSection(d),
        statusSection(d, st))
      });
      return root;
    }
  };
}

