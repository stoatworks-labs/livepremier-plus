/*
 * Speed Editor HID reports <-> the engine's normalised control events.
 *
 * The counterpart of `../surface.js` for a panel that is not MIDI. Its
 * contract with a host is the same but for one detail: `handle` returns an
 * ARRAY of events, because one key report can carry several changes at once
 * (it lists every held key, never the one that moved).
 *
 * Control ids are `key:<name>` for the keys (names from KEYS) and
 * `jog:<mode>` for the wheel. The wheel is one knob with three faces: the
 * JOG, SHTL and SCRL keys choose which of `jog:jog`, `jog:shtl` and
 * `jog:scrl` it moves, and light to say so. That choice lives here rather
 * than in the engine because it is how the panel is built, not a show
 * decision — a profile binds the three faces to whatever it likes. Those
 * three keys are consumed by it and never reach the engine.
 *
 * Authentication and the transport are the host's; see speed-editor.js.
 */

import {
  KEYS, KEY_BY_CODE, KEY_BY_NAME, JOG_MODE,
  decodeReport, ledReport, jogLedReport, jogModeReport
} from './speed-editor.js';
import { controlIndex } from '../profile.js';

export const JOG_FACES = ['jog', 'shtl', 'scrl'];

/*
 * Wheel units per engine tick, which the bindings' `step`s are sized for
 * (roughly a MIDI encoder detent). bmd.py puts half a turn at about 8192
 * units in absolute mode; relative mode is assumed to count the same way
 * until a panel says otherwise. A control can override it with `units`.
 */
const DEFAULT_UNITS = 512;

export class SpeedEditorSurface {
  /**
   * @param profile the controller profile
   * @param send    fn(Uint8Array) -> void, an HID output report, id in byte 0
   */
  constructor(profile, send = () => {}) {
    this.send = send;
    this.held = new Set();
    this.face = 'jog';
    this.residue = 0;
    this.leds = 0;
    this.battery = null;
    this.setProfile(profile);
  }

  setProfile(profile) {
    this.profile = profile;
    this.controls = controlIndex(profile);
    this.residue = 0;
  }

  /* ---------------------------------------------------------------- input */

  /** Decode one input report into zero or more control events. */
  handle(bytes) {
    const report = decodeReport(bytes);
    if (!report) return [];
    if (report.type === 'keys') return this.keys(report.codes);
    if (report.type === 'jog') return this.jog(report.value);
    if (report.type === 'battery') this.battery = { charging: report.charging, level: report.level };
    return [];
  }

  keys(codes) {
    const now = new Set(codes.map((c) => KEY_BY_CODE.get(c)?.name ?? `0x${c.toString(16)}`));
    const out = [];
    for (const name of this.held) {
      if (!now.has(name)) out.push(this.key(name, false));
    }
    for (const name of now) {
      if (!this.held.has(name)) out.push(this.key(name, true));
    }
    this.held = now;
    return out.filter(Boolean);
  }

  key(name, down) {
    if (JOG_FACES.includes(name)) {
      if (down && this.face !== name) {
        this.face = name;
        this.residue = 0;
        this.send(jogLedReport(this.jogLeds()));
      }
      return null;
    }
    const id = `key:${name}`;
    if (!this.controls.has(id)) return down ? { control: id, kind: 'unmapped', down } : null;
    return { control: id, kind: 'button', down };
  }

  jog(value) {
    const id = `jog:${this.face}`;
    const control = this.controls.get(id);
    if (!control) return value ? [{ control: id, kind: 'unmapped', value }] : [];
    /* Keep the part of a tick that has not been reached yet, or a slow turn
       would round to nothing on every report and never move anything. */
    const units = control.units ?? DEFAULT_UNITS;
    this.residue += value;
    const delta = Math.trunc(this.residue / units);
    if (!delta) return [];
    this.residue -= delta * units;
    return [{ control: id, kind: 'relative', delta }];
  }

  /* ------------------------------------------------------------- feedback */

  /** Render one engine feedback event: the keys with lamps light. */
  render(fb) {
    const control = fb.controlDef ?? this.controls.get(fb.control);
    if (!control || control.kind !== 'button' || control.feedback === false) return;
    if (fb.lamp === null || fb.lamp === undefined) return;
    const bit = KEY_BY_NAME.get(control.id.replace(/^key:/, ''))?.led;
    if (bit === undefined) return;
    const next = fb.lamp ? (this.leds | (1 << bit)) >>> 0 : (this.leds & ~(1 << bit)) >>> 0;
    if (next === this.leds) return;
    this.leds = next;
    this.send(ledReport(this.leds));
  }

  jogLeds() {
    return 1 << KEY_BY_NAME.get(this.face).jogLed;
  }

  /**
   * Put the panel into a known state: every lamp out, the wheel reporting
   * movement, and the current face lit. Run it after each authentication
   * too — a panel that has been unplugged has forgotten all of it.
   */
  reset() {
    this.leds = 0;
    this.residue = 0;
    this.send(ledReport(0));
    this.send(jogModeReport(JOG_MODE.RELATIVE));
    this.send(jogLedReport(this.jogLeds()));
  }
}

/** Every key the panel has, as profile controls. Lamps only where it has them. */
export function speedEditorControls() {
  const controls = KEYS
    .filter((k) => !JOG_FACES.includes(k.name))
    .map((k) => ({
      id: `key:${k.name}`,
      kind: 'button',
      label: k.label,
      ...(k.led === undefined ? { feedback: false } : {})
    }));
  for (const face of JOG_FACES) {
    controls.push({ id: `jog:${face}`, kind: 'encoder', label: `Wheel (${face.toUpperCase()})` });
  }
  return controls;
}
