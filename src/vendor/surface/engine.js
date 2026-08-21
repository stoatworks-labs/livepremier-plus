/*
 * The mapping engine.
 *
 * Controls in, device writes out; device changes in, control feedback out. It
 * knows nothing about MIDI, OSC, WebSockets or sockets — a host adapts its
 * transport to the normalised control event, and the same engine then runs
 * inside a browser extension or a local server without change.
 *
 * Three things here are not obvious and are the reason this is not a lookup
 * table:
 *
 *   1. A layer path contains a preset LETTER, and which letter means "preview"
 *      changes on every take. Bindings therefore address PREVIEW or PROGRAM and
 *      are resolved per event against live device state.
 *   2. Every write comes back as a device change. Feeding that straight back to
 *      the control that caused it fights the operator's hand, so writes are
 *      attributed and echoes to the originating control are dropped.
 *   3. A motorised fader must never be driven while it is being touched.
 */

import { ROOT, layerParam, screenGroupParam, key } from './paths.js';
import { letterFor } from './preset.js';
import { specFor, shortLabel } from './catalogue.js';
import { ABSOLUTE_KINDS, controlIndex, bindingIndex } from './profile.js';
import {
  fromAbsolute, fromRelative, fromButton, toAbsolute, toLamp, Pickup
} from './value.js';

const SELECTED = '@selected';
const STRIP = '@strip';

/** How long after a write an echo on that path is treated as our own. */
const ECHO_MS = 350;

export class Engine extends EventTarget {
  /**
   * @param store    something with get(path) -> value, mirroring the device
   * @param profile  a validated controller profile
   * @param options  {selection, coalesceMs}
   */
  constructor(store, profile, options = {}) {
    super();
    this.store = store;
    this.selection = {
      screen: 'S1',
      preset: 'PREVIEW',
      layer: 1,
      bank: 0,
      shift: false,
      ...options.selection
    };
    this.coalesceMs = options.coalesceMs ?? 20;
    this.pickups = new Map();      // control id -> Pickup
    this.touched = new Set();      // strip indices currently held
    this.origins = new Map();      // path key -> {control, until}
    this.pending = new Map();      // path key -> {path, value}
    this.timer = null;
    this.problems = [];
    this.setProfile(profile);
  }

  setProfile(profile) {
    this.profile = profile;
    this.controls = controlIndex(profile);
    this.bindings = bindingIndex(profile);
    /*
     * One control can carry several bindings — a shifted and an unshifted use
     * of the same V-Pot, or a button that both selects and lights. The control
     * id alone therefore does not identify a binding, and anything keyed on it
     * (a UI row, a value readout) shows one binding's value against another's
     * name. Each binding gets a stable id of its own.
     */
    this.bindingIds = new Map();
    (profile.bindings ?? []).forEach((b, i) => {
      this.bindingIds.set(b, b.id ?? `${b.control}#${i}`);
    });
    this.pickups.clear();
    this.emit('profile', { profile });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ------------------------------------------------------------ resolving */

  /** The screenAuxGroup object for a screen, used to resolve preset letters. */
  group(screen) {
    return this.store.get([ROOT, 'screenAuxGroupList', 'items', screen]);
  }

  /**
   * Turn a binding's target into a concrete store path.
   *
   * Returns null when it cannot be resolved yet — typically because the preset
   * letters have not been read from the device. Writing to a guessed letter
   * could put a change on air, so not writing at all is the only safe answer.
   */
  resolve(target, control) {
    if (!target || target.kind === 'action') return null;
    const screen = this.pick(target.screen, this.selection.screen);
    if (target.kind === 'screenGroup') {
      const spec = specFor(target);
      return spec ? screenGroupParam(screen, spec.path) : null;
    }
    const letter = letterFor(
      this.pick(target.preset, this.selection.preset),
      this.group(screen)
    );
    if (!letter) return null;
    const layer = this.layerOf(target, control);
    if (layer === null) return null;
    const spec = specFor(target);
    return spec ? layerParam(screen, letter, layer, spec.path) : null;
  }

  pick(selector, fallback) {
    return selector === undefined || selector === SELECTED ? fallback : selector;
  }

  /**
   * Which layer a binding addresses.
   *
   * `@strip` is what makes a bank of eight faders useful: each control declares
   * its strip index once, in the hardware half of the profile, and the same
   * binding then applies to all eight. The bank offset shifts the whole set,
   * so eight faders reach 128 layers.
   */
  layerOf(target, control) {
    const sel = target.layer;
    if (sel === undefined || sel === SELECTED) return this.selection.layer;
    if (sel === STRIP) {
      if (!control || control.strip === undefined) return null;
      return this.selection.bank * (this.profile.stripCount ?? 8) + control.strip + 1;
    }
    return sel;
  }

  /* ---------------------------------------------------------------- input */

  /**
   * Handle one normalised control event.
   *
   *   {control, kind:'absolute', value: 0..1}
   *   {control, kind:'relative', delta: ticks}
   *   {control, kind:'button',   down: bool}
   *   {control, kind:'touch',    down: bool}
   */
  input(event) {
    const control = this.controls.get(event.control);
    if (!control) return;

    if (control.kind === 'touch' || event.kind === 'touch') {
      const strip = control.strip;
      if (strip !== undefined) {
        if (event.down) this.touched.add(strip);
        else this.touched.delete(strip);
      }
      return;
    }

    for (const binding of this.bindings.get(event.control) ?? []) {
      if (!this.armed(binding)) continue;
      if (binding.target.kind === 'action') {
        if (event.kind !== 'button' || event.down || binding.target.action === 'shift') {
          this.action(binding, event, control);
        }
        continue;
      }
      this.parameter(binding, event, control);
    }
  }

  /**
   * Is this binding live given the current modifier state?
   *
   * A profile can put two bindings on one button, one `shift: true` and one
   * `shift: false`, which is how a surface with 8 buttons addresses 16 things.
   * A binding that says nothing about shift is always armed.
   */
  armed(binding) {
    return binding.shift === undefined || !!binding.shift === !!this.selection.shift;
  }

  /** Apply a binding whose target is a device parameter. */
  parameter(binding, event, control) {
    const path = this.resolve(binding.target, control);
    const spec = specFor(binding.target);
    if (!path || !spec) {
      this.emit('unresolved', { binding, reason: path ? 'unknown parameter' : 'preset not read yet' });
      return;
    }
    if (spec.readOnly) return;

    const current = this.store.get(path);
    const opts = binding.options ?? {};
    let value;

    if (event.kind === 'absolute') {
      const pickup = this.pickupFor(event.control, opts, control);
      const at = toAbsolute(spec, current, opts);
      if (!pickup.allows(event.value, at)) {
        this.emit('holdoff', { control: event.control, at, want: event.value });
        return;
      }
      value = fromAbsolute(spec, event.value, opts);
    } else if (event.kind === 'relative') {
      value = fromRelative(spec, event.delta, current, opts);
    } else if (event.kind === 'button') {
      value = fromButton(spec, event.down, current, opts);
    }

    if (value === undefined || value === current) return;
    this.write(path, value, event.control);
  }

  pickupFor(controlId, opts, control) {
    let p = this.pickups.get(controlId);
    if (!p) {
      /* Motorised faders are always in agreement with the parameter, because
         the parameter drives them. Pickup on one would only add a dead zone. */
      const motorised = control.kind === 'fader14' || control.motorised;
      p = new Pickup(opts.takeover ?? (motorised ? 'jump' : 'pickup'));
      this.pickups.set(controlId, p);
    }
    return p;
  }

  /** Apply a binding whose target is surface state rather than the device. */
  action(binding, event, control) {
    const t = binding.target;
    const before = { ...this.selection };
    const stripCount = this.profile.stripCount ?? 8;
    switch (t.action) {
      case 'selectLayer':
        this.selection.layer = t.value === STRIP
          ? this.selection.bank * stripCount + (control.strip ?? 0) + 1
          : t.value ?? this.selection.layer;
        break;
      case 'selectScreen':
        this.selection.screen = t.value ?? this.selection.screen;
        break;
      case 'selectPreset':
        this.selection.preset = t.value === 'toggle'
          ? (this.selection.preset === 'PREVIEW' ? 'PROGRAM' : 'PREVIEW')
          : t.value ?? this.selection.preset;
        break;
      case 'bank':
        this.selection.bank = Math.max(0, this.selection.bank + (t.delta ?? 0));
        if (t.value !== undefined) this.selection.bank = Math.max(0, t.value);
        break;
      case 'shift':
        this.selection.shift = event.kind === 'button' ? !!event.down : !this.selection.shift;
        break;
      default:
        this.emit('unresolved', { binding, reason: `unknown action ${t.action}` });
        return;
    }
    /* Re-pointing a control at a different layer invalidates every pickup
       latch: the fader is now nowhere near the value it is about to steer. */
    if (this.selection.layer !== before.layer ||
        this.selection.screen !== before.screen ||
        this.selection.preset !== before.preset ||
        this.selection.bank !== before.bank) {
      for (const p of this.pickups.values()) p.reset();
      this.emit('selection', { selection: { ...this.selection }, before });
      this.refresh();
    } else if (this.selection.shift !== before.shift) {
      this.emit('selection', { selection: { ...this.selection }, before });
      this.refresh();
    }
  }

  /* --------------------------------------------------------------- output */

  /**
   * Queue a write.
   *
   * A fader sweep is hundreds of events a second and the device does not need
   * them all; only the newest value per path survives the coalescing window.
   * Buttons still feel instant because the window is short, and a value that
   * stops changing always gets its final write.
   */
  write(path, value, fromControl) {
    const k = key(path);
    this.origins.set(k, { control: fromControl, until: Date.now() + ECHO_MS });
    this.pending.set(k, { path, value });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const batch = [...this.pending.values()];
      this.pending.clear();
      if (batch.length) this.emit('write', { writes: batch });
    }, this.coalesceMs);
  }

  /* ------------------------------------------------------------- feedback */

  /**
   * A value changed on the device. Update any control that displays it.
   *
   * The echo test is by path AND control: a second surface moving the same
   * parameter should still move our fader, and only the control that made the
   * change is held off.
   */
  deviceChanged(path) {
    const k = key(path);
    const origin = this.origins.get(k);
    if (origin && origin.until < Date.now()) this.origins.delete(k);

    for (const [controlId, list] of this.bindings) {
      const control = this.controls.get(controlId);
      if (!control) continue;
      for (const binding of list) {
        if (binding.target.kind === 'action') continue;
        const resolved = this.resolve(binding.target, control);
        if (!resolved || key(resolved) !== k) continue;
        if (origin && origin.control === controlId && origin.until >= Date.now()) continue;
        this.display(controlId, control, binding);
      }
    }
  }

  /**
   * Every device path this profile currently touches.
   *
   * Two uses, and both matter on real hardware. A host subscribes to these
   * rather than to everything, and a host seeds its mirror by reading these
   * rather than pulling the whole store — which on a large frame is well over
   * 100 MB and takes the vendor's own client two minutes.
   *
   * The screen group is always included even when nothing is bound to it. It
   * carries the preset letters and the transition state, so without it a take
   * would go unnoticed and every PREVIEW binding would silently keep writing
   * to whichever preset is now on air.
   */
  watchedPaths() {
    const paths = new Map();
    const add = (p) => { if (p) paths.set(key(p), p); };

    const screens = new Set([this.selection.screen]);
    for (const [controlId, list] of this.bindings) {
      const control = this.controls.get(controlId);
      for (const binding of list) {
        if (binding.target.kind === 'action') {
          if (binding.target.action === 'selectScreen' && binding.target.value) {
            screens.add(binding.target.value);
          }
          continue;
        }
        if (binding.target.screen && binding.target.screen !== SELECTED) {
          screens.add(binding.target.screen);
        }
        add(this.resolve(binding.target, control));
      }
    }
    for (const screen of screens) {
      add(screenGroupParam(screen, ['control', 'pp']));
      add(screenGroupParam(screen, ['status', 'pp']));
    }
    return [...paths.values()];
  }

  /** Recompute and emit feedback for every control. */
  refresh() {
    for (const [controlId, list] of this.bindings) {
      const control = this.controls.get(controlId);
      if (!control) continue;
      for (const binding of list) this.display(controlId, control, binding);
    }
    this.emit('refreshed', { selection: { ...this.selection } });
  }

  /**
   * Emit what one control should be showing.
   *
   * Absolute controls get a position, buttons get a lamp, and anything with a
   * display gets two lines of text. A null position means "no value" and is
   * distinct from zero — a host should blank an LED ring rather than drive it
   * to the bottom, so that an unassigned control looks unassigned.
   */
  display(controlId, control, binding) {
    const t = binding.target;
    const id = this.bindingIds.get(binding);
    if (t.kind === 'action') {
      const lit = this.actionLit(t, control);
      if (lit !== null) {
        this.emit('feedback', {
          control: controlId, binding: id, controlDef: control, lamp: lit,
          ...this.labels(binding, control)
        });
      }
      return;
    }
    const spec = specFor(t);
    const path = this.resolve(t, control);
    const value = path ? this.store.get(path) : undefined;
    const opts = binding.options ?? {};
    const out = {
      control: controlId, binding: id, controlDef: control, path, value,
      ...this.labels(binding, control)
    };

    if (spec && (ABSOLUTE_KINDS.has(control.kind) || control.kind === 'encoder')) {
      out.position = spec ? toAbsolute(spec, value, opts) : null;
      /* Never drive a motor into a hand that is holding it. */
      if (control.strip !== undefined && this.touched.has(control.strip)) out.position = null;
    }
    if (spec && control.kind === 'button') out.lamp = toLamp(spec, value, opts);
    this.emit('feedback', out);
  }

  /** Whether an action button should be lit — i.e. is it the current choice? */
  actionLit(target, control) {
    const stripCount = this.profile.stripCount ?? 8;
    switch (target.action) {
      case 'selectLayer':
        return this.selection.layer === (target.value === STRIP
          ? this.selection.bank * stripCount + (control.strip ?? 0) + 1
          : target.value);
      case 'selectScreen':
        return this.selection.screen === target.value;
      case 'selectPreset':
        return target.value === 'toggle'
          ? this.selection.preset === 'PROGRAM'
          : this.selection.preset === target.value;
      case 'shift':
        return this.selection.shift;
      default:
        return null;
    }
  }

  /**
   * The two lines a scribble strip shows for a control.
   *
   * Top line names the target, bottom names what it is addressing, because on
   * a surface where one fader can be pointed at any of 128 layers the second
   * line is the one that stops mistakes.
   */
  labels(binding, control) {
    const t = binding.target;
    if (t.kind === 'action') return { top: binding.label ?? t.action, bottom: '' };
    const layer = this.layerOf(t, control);
    const scope = t.kind === 'screenGroup'
      ? this.pick(t.screen, this.selection.screen)
      : `L${layer ?? '-'}`;
    return { top: binding.label ?? shortLabel(t.param), bottom: scope };
  }
}
