/*
 * Where timecode comes from.
 *
 * Three ways in, one `TimecodeClock` out. The decoding is all in
 * `core/timecode.js`; this file only opens ports and pumps bytes at it.
 *
 * ## MIDI, in the page
 *
 * MTC over Web MIDI, which this app already proved it can do: serving the
 * vendor UI from loopback makes the page a secure context, so
 * `requestMIDIAccess` is simply available. No offscreen document, no service
 * worker — see `ui/midi-panel.js` for the history.
 *
 * ## Audio, in the page
 *
 * LTC off an input device via `getUserMedia`, which loopback also permits.
 * A worklet taps the samples and the decoder runs on the main thread — see
 * `ltc-worklet.js` for why the decoding is not in the worklet.
 *
 * ⚠️ **The browser will resample.** `getUserMedia` hands over whatever the
 * AudioContext is running at, not what the interface is clocked at, and the
 * decoder is told the context's rate for that reason. It only uses the rate as
 * a starting guess anyway — the interval reference is a running average — so a
 * resampled feed decodes regardless.
 *
 * ## The backend, for everything else
 *
 * A generator on another machine, a lighting desk, a script: anything can POST
 * a timecode to the proxy and the page picks it up over an event stream. That
 * is the path for LTC on hardware the browser cannot see, and it is the one
 * that does not need this tab to have a microphone permission.
 */

import { MtcReader, LtcReader, TimecodeClock } from '../core/timecode.js';

export const SOURCE_KINDS = [
  { id: 'none', label: 'None' },
  { id: 'midi', label: 'MIDI Time Code' },
  { id: 'audio', label: 'Audio (LTC)' },
  { id: 'backend', label: 'Pushed to LivePremier Plus' }
];

/**
 * @param {{rate?: number, staleAfterMs?: number}} opts
 */
export function createTimecodeSource({ rate = 25, staleAfterMs = 250 } = {}) {
  const clock = new TimecodeClock({ rate, staleAfterMs });
  const state = { kind: 'none', deviceId: '', error: null, running: false };

  let stopCurrent = null;
  /* The clock cannot notice a feed stopping on its own — nothing arrives to
     tell it. Poll while a source is open, and not otherwise. */
  let poll = null;

  async function use(kind, deviceId = '') {
    stop();
    state.kind = kind;
    state.deviceId = deviceId;
    state.error = null;
    try {
      if (kind === 'midi') stopCurrent = await useMidi(deviceId);
      else if (kind === 'audio') stopCurrent = await useAudio(deviceId);
      else if (kind === 'backend') stopCurrent = useBackend();
      else { state.kind = 'none'; return; }
      poll = setInterval(() => clock.poll(), 100);
    } catch (err) {
      state.error = err.message;
      state.kind = 'none';
      throw err;
    }
  }

  function stop() {
    if (stopCurrent) { try { stopCurrent(); } catch { /* closing is best effort */ } stopCurrent = null; }
    if (poll) { clearInterval(poll); poll = null; }
    clock.stop();
    state.kind = 'none';
  }

  /* ----------------------------------------------------------------- midi */

  async function useMidi(deviceId) {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) {
      throw new Error('This browser has no Web MIDI. Open Web RCS through LivePremier Plus, not the switcher’s own address.');
    }
    /* No SysEx here even though full-frame MTC is a SysEx message: asking for
       it prompts, and quarter-frames are what a running generator sends. A
       locate will simply be missed rather than the whole source refusing. */
    const access = await navigator.requestMIDIAccess({ sysex: false });
    const inputs = [...access.inputs.values()];
    const port = deviceId ? inputs.find((p) => p.id === deviceId) : inputs[0];
    if (!port) throw new Error(inputs.length ? 'That MIDI input is not there any more' : 'No MIDI inputs found');

    const reader = new MtcReader();
    const onMessage = (ev) => {
      const got = reader.push(ev.data);
      if (got) clock.update(got.timecode, 'midi');
    };
    port.addEventListener('midimessage', onMessage);
    port.open?.();
    return () => { port.removeEventListener('midimessage', onMessage); };
  }

  /** Every MIDI input this browser can see, for a picker. */
  async function midiInputs() {
    if (typeof navigator === 'undefined' || !navigator.requestMIDIAccess) return [];
    const access = await navigator.requestMIDIAccess({ sysex: false });
    return [...access.inputs.values()].map((p) => ({ id: p.id, label: p.name || p.id }));
  }

  /* ---------------------------------------------------------------- audio */

  async function useAudio(deviceId) {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      throw new Error('This browser will not open an audio input here');
    }
    /*
     * Every bit of processing off. Echo cancellation and noise suppression are
     * built to remove exactly the kind of steady square-ish tone LTC is, and
     * automatic gain would be chasing a signal whose level carries no meaning.
     */
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.audioWorklet.addModule('/__lpp/src/ui/ltc-worklet.js');
    const reader = new LtcReader({ sampleRate: ctx.sampleRate });
    const node = new AudioWorkletNode(ctx, 'lpp-ltc-tap');
    node.port.onmessage = (ev) => {
      for (const tc of reader.push(ev.data)) clock.update(tc, 'audio');
    };
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);
    /*
     * The worklet is not connected to the destination — nothing is played
     * back. A node with no output still runs, and routing LTC to the speakers
     * of a show laptop is exactly the sort of thing that only gets noticed
     * once.
     */
    return () => {
      node.port.onmessage = null;
      try { src.disconnect(); node.disconnect(); } catch { /* already gone */ }
      for (const track of stream.getTracks()) track.stop();
      ctx.close();
    };
  }

  /** Audio inputs, once permission has been granted at least once. */
  async function audioInputs() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all
      .filter((d) => d.kind === 'audioinput')
      /* Labels are empty until permission is granted — say so rather than
         showing a list of blank rows. */
      .map((d, i) => ({ id: d.deviceId, label: d.label || `Input ${i + 1} (allow the microphone to see its name)` }));
  }

  /* -------------------------------------------------------------- backend */

  function useBackend() {
    const stream = new EventSource('/__lpp/timecode/stream');
    stream.addEventListener('timecode', (ev) => {
      try { clock.update(JSON.parse(ev.data), 'backend'); }
      catch { /* a malformed push is not worth tearing the source down for */ }
    });
    stream.addEventListener('error', () => { state.error = 'The timecode stream dropped'; });
    return () => stream.close();
  }

  return { clock, state, use, stop, midiInputs, audioInputs };
}
