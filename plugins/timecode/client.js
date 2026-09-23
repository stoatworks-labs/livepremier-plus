/*
 * Timecode — the plugin's page half: a clock, and the chase that fires cues
 * off it.
 *
 * Three ways in, one clock out: MTC over Web MIDI, LTC off an audio input, or
 * a timecode pushed to this app (`source.js`, and the server half). The chase
 * (`src/core/chase.js`) fires the cues that carry a timecode when the clock
 * crosses them, through the Timeline's `stack` service — which is why the
 * manifest requires the Timeline.
 *
 * Both exist from the moment the plugin starts, with no source chosen: the
 * chase costs a timer that returns at once while nothing is armed, and living
 * here rather than inside a panel means the clock keeps running when the
 * operator navigates away from the Timeline tab — which, mid-show, they will.
 *
 * Offered to the page as the **`timecode` service**, `{ source, chase }`: the
 * Timeline draws the clock and its Chase button from it, and has neither when
 * this plugin is off.
 */

import { createTimecodeSource, SOURCE_KINDS } from './source.js';
import { TimecodeChase } from '../../src/core/chase.js';
import { formatTimecode } from '../../src/core/timecode.js';

export default function activate(ctx) {
  const source = createTimecodeSource({ streamUrl: ctx.url('/stream') });

  /* The chase reads the cues and fires them by id, through the Timeline. */
  const stack = () => ctx.use('stack');
  const chase = new TimecodeChase({
    stack: {
      get cues() { const s = stack(); return s ? s.cues() : []; },
      fire(cue) { const s = stack(); if (s) s.fire(cue.id); }
    },
    clock: source.clock,
    rate: 25
  });
  /*
   * The chase fires on each reading, not on a timer — see `core/chase.js`. All
   * that is left here is noticing that the feed has *gone*, which no reading
   * will ever announce, and being late to that costs nothing.
   */
  setInterval(() => source.clock.poll(), 250);
  chase.addEventListener('fired', (ev) => {
    ctx.log.info('timecode fired cue', ev.detail.cue.number || ev.detail.cue.id);
    ctx.refresh();
  });

  ctx.provide('timecode', Object.freeze({ source, chase }));
  ctx.ui.settingsSection({ id: 'timecode', order: 20, render: () => card(ctx, source) });
}

/** Which source, which input on it, and what it is reading now. */
function card(ctx, timecode) {
  const { h, card: frame, note, readout } = ctx.kit;
  const { clock, state } = timecode;

  const choose = async (kind, deviceId = '') => {
    try { await timecode.use(kind, deviceId); } catch { /* the error is on `state`; the next render shows it */ }
    ctx.refresh();
  };

  const pick = h('select', {
    class: 'wru-input', style: { maxWidth: '18rem' },
    onChange: (ev) => choose(ev.target.value)
  }, SOURCE_KINDS.map((k) => h('option', {
    value: k.id, selected: state.kind === k.id ? 'selected' : null, text: k.label
  })));

  const devices = h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' });
  void paintDevices(ctx, timecode, devices, choose);

  const reading = clock.reading;
  const rows = h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
    readout('Reading', formatTimecode(reading)),
    readout('State', clock.running ? 'running' : (reading ? 'stopped' : 'nothing yet'),
      { tone: clock.running ? null : 'tertiary' }),
    readout('Rate', reading && reading.rate ? reading.rate + (reading.dropFrame ? ' DF' : '') : '—'));

  const notes = [];
  if (state.error) notes.push(note('warn', state.error));
  /*
   * The one that is not guessable. LTC does not transmit its frame rate —
   * only the drop-frame flag — so the reader has to be told, and a reader
   * told 25 while the tape runs at 30 puts every cue in the wrong place.
   */
  if (state.kind === 'audio') {
    notes.push(note('info', 'LTC does not carry its frame rate, so the rate above is the one this '
      + 'app assumes. Cue timecodes are read at that rate too, so the two agree.'));
  }
  if (state.kind === 'backend') {
    notes.push(note('info', `POST a timecode to ${ctx.url('/')} — either "01:02:03:04" or `
      + '{hours,minutes,seconds,frames} — and every open page hears it.'));
  }

  return frame('Timecode',
    h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-flex-wrap' }, pick, devices),
    rows, ...notes);
}

async function paintDevices(ctx, timecode, host, choose) {
  const { h } = ctx.kit;
  host.textContent = '';
  const kind = timecode.state.kind;
  if (kind !== 'midi' && kind !== 'audio') return;
  let list = [];
  try { list = kind === 'midi' ? await timecode.midiInputs() : await timecode.audioInputs(); } catch (err) {
    host.append(h('span', { class: 'wru-tag wru-warn', text: err.message }));
    return;
  }
  if (!list.length) {
    host.append(h('span', { class: 'wru-tag', text: 'no inputs found' }));
    return;
  }
  host.append(h('select', {
    class: 'wru-input', style: { maxWidth: '18rem' },
    onChange: (ev) => choose(kind, ev.target.value)
  }, list.map((d) => h('option', {
    value: d.id, selected: timecode.state.deviceId === d.id ? 'selected' : null, text: d.label
  }))));
}
