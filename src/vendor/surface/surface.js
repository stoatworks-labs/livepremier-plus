/*
 * MIDI <-> the engine's normalised control events.
 *
 * This is the only place that knows a fader might be 7-bit on one surface and
 * 14-bit on another, that an encoder's ticks are sign-magnitude, or that a
 * scribble strip exists. The engine above it sees positions, deltas and
 * presses; the ports below it see bytes.
 *
 * Two feedback protocols are supported, declared per profile:
 *
 *   generic  a control is lit by sending its own message back. This is how
 *            almost every class-compliant surface works, the APC40 included:
 *            note-on to a button's own note sets its LED, and a CC back to a
 *            knob's own controller sets its ring.
 *   mcu      Mackie Control. Faders are pitch bend (which moves the motor),
 *            V-Pot rings live on a different CC from the V-Pot, and text goes
 *            out as SysEx. Nothing shares an address with its control.
 */

import { decode, encode, controlId, parseControlId } from './midi/message.js';
import { decodeRelative, Accelerator } from './midi/encoders.js';
import * as mcu from './midi/mcu.js';
import { controlIndex } from './profile.js';

export class MidiSurface {
  /**
   * @param profile the controller profile
   * @param send    fn(Uint8Array) -> void, a MIDI output port
   */
  constructor(profile, send = () => {}) {
    this.profile = profile;
    this.send = send;
    this.controls = controlIndex(profile);
    this.protocol = profile.feedback?.protocol ?? 'generic';
    this.deviceId = profile.feedback?.deviceId ?? mcu.MCU_DEVICE_ID;
    this.accel = new Map();
    this.lastText = new Map();
  }

  setProfile(profile) {
    this.profile = profile;
    this.controls = controlIndex(profile);
    this.protocol = profile.feedback?.protocol ?? 'generic';
    this.lastText.clear();
  }

  /* ---------------------------------------------------------------- input */

  /**
   * Decode incoming MIDI into a control event, or null if it maps to nothing.
   *
   * Unmapped messages come back tagged rather than dropped, because that is
   * exactly what MIDI-learn needs to see. Everything a surface says while
   * idling - MCU's fader-touch and meter traffic, an APC40's mode handshake -
   * costs one map lookup.
   */
  handle(bytes) {
    const msg = decode(bytes);
    if (!msg) return null;
    const id = controlId(msg);
    if (!id) return null;
    const control = this.controls.get(id);
    if (!control) return { control: id, kind: 'unmapped', msg };

    switch (control.kind) {
      case 'touch':
        return { control: id, kind: 'touch', down: msg.type === 'noteOn' };
      case 'button':
        return { control: id, kind: 'button', down: msg.type === 'noteOn' };
      case 'fader14':
        return { control: id, kind: 'absolute', value: mcu.faderValue(msg) };
      case 'fader':
      case 'knob':
        return { control: id, kind: 'absolute', value: (msg.value ?? 0) / 127 };
      case 'encoder': {
        /*
         * Two encodings, and they are not variants of each other.
         *
         * A CC encoder puts a signed tick count in the value byte. Both Elation
         * MIDIcons instead send a NOTE per click, one note number for clockwise
         * and another for anticlockwise, so a single physical rotary is two
         * controls in the profile and each declares its own `tick`. There is no
         * value byte to read, and a note-off is the click ending, not a second
         * click, so it must not move anything.
         */
        let delta;
        if (msg.type === 'noteOn' || msg.type === 'noteOff') {
          if (msg.type === 'noteOff') return null;
          delta = control.tick ?? 1;
        } else {
          delta = decodeRelative(msg.value ?? 0, control.relative ?? 'signed');
        }
        if (delta === 0) return null;
        if (control.accelerate !== false) {
          let a = this.accel.get(id);
          if (!a) this.accel.set(id, (a = new Accelerator()));
          delta = a.apply(delta);
        }
        return { control: id, kind: 'relative', delta };
      }
      default:
        return null;
    }
  }

  /* ------------------------------------------------------------- feedback */

  /** Render one engine feedback event to the surface. */
  render(fb) {
    const control = fb.controlDef ?? this.controls.get(fb.control);
    if (!control || control.feedback === false) return;
    const msgs = this.protocol === 'mcu'
      ? this.renderMcu(fb, control)
      : this.renderGeneric(fb, control);
    for (const m of msgs) this.send(encode(m));
  }

  renderGeneric(fb, control) {
    const addr = parseControlId(control.id);
    if (!addr) return [];
    if (control.kind === 'button') {
      if (fb.lamp === null || fb.lamp === undefined) return [];
      const velocity = fb.lamp ? (control.on ?? 127) : (control.off ?? 0);
      return [{ type: 'noteOn', channel: addr.channel, note: addr.note, velocity }];
    }
    if (fb.position === null || fb.position === undefined) return [];
    /*
     * A plain fader has no motor, so echoing a position to it is pointless at
     * best. Knobs with LED rings do take it, which is the whole reason the
     * generic path renders positions at all.
     */
    if (control.kind === 'fader' && !control.motorised) return [];
    if (addr.kind === 'cc') {
      return [{
        type: 'cc',
        channel: addr.channel,
        controller: control.ring ?? addr.controller,
        value: Math.round(fb.position * 127)
      }];
    }
    if (addr.kind === 'pb') return [mcu.faderMessage(addr.channel, fb.position)];
    return [];
  }

  renderMcu(fb, control) {
    const out = [];
    const strip = control.strip;
    if (control.kind === 'fader14' && fb.position !== null && fb.position !== undefined) {
      out.push(mcu.faderMessage(strip ?? 0, fb.position));
    }
    if (control.kind === 'encoder' && strip !== undefined) {
      out.push(mcu.ringMessage(strip, fb.position ?? null, control.ringMode ?? mcu.RING_MODE.WRAP));
    }
    if (control.kind === 'button' && fb.lamp !== null && fb.lamp !== undefined) {
      const addr = parseControlId(control.id);
      if (addr?.kind === 'note') out.push(mcu.lampMessage(addr.note, !!fb.lamp, addr.channel));
    }
    /*
     * Scribble strips are shared by every control on a strip, so a fader and
     * its V-Pot would fight over the text. Only the control the profile marks
     * as owning the display writes it, and only when the text has changed -
     * rewriting on every fader tick makes the LCDs visibly flicker.
     */
    if (control.scribble && strip !== undefined && (fb.top !== undefined || fb.bottom !== undefined)) {
      const text = `${fb.top ?? ''} ${fb.bottom ?? ''}`;
      if (this.lastText.get(strip) !== text) {
        this.lastText.set(strip, text);
        out.push(...mcu.scribbleMessage(strip, fb.top ?? '', fb.bottom ?? '', this.deviceId));
      }
    }
    return out;
  }

  /**
   * Put the surface into a known state.
   *
   * Without this a surface keeps whatever its last host left on it - lit
   * buttons for bindings that no longer exist, faders parked at another
   * application's levels, stale names on the LCDs.
   */
  reset() {
    for (const control of this.controls.values()) {
      const addr = parseControlId(control.id);
      if (!addr) continue;
      if (control.kind === 'button' && addr.kind === 'note') {
        this.send(encode({ type: 'noteOn', channel: addr.channel, note: addr.note, velocity: control.off ?? 0 }));
      }
      if (control.kind === 'fader14' && control.strip !== undefined) {
        this.send(encode(mcu.faderMessage(control.strip, 0)));
      }
      if (this.protocol === 'mcu' && control.kind === 'encoder' && control.strip !== undefined) {
        this.send(encode(mcu.ringMessage(control.strip, null)));
      }
    }
    if (this.protocol === 'mcu') {
      this.lastText.clear();
      for (let s = 0; s < mcu.STRIPS; s++) {
        for (const m of mcu.scribbleMessage(s, '', '', this.deviceId)) this.send(encode(m));
      }
    }
  }
}
