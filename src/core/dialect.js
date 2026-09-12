/*
 * The two spellings of the device object model, and the one interface the
 * panels drive through.
 *
 * `core/platform.js` says there are two code families and that the object
 * model does not carry across them. This file is the consequence: every path
 * a panel reads or writes — a take, a fade time, a memory recall, which buffer
 * is on air — is asked of a *dialect*, and the dialect is chosen by which
 * family's tree the store actually contains. Nothing above this file spells a
 * collection name.
 *
 * ## The identifiers do not change; only the paths do
 *
 * A destination is `S<n>` or `A<n>` everywhere above this file, on both
 * families. That is the LivePremier spelling and it is kept on Midra 4K and
 * Alta 4K deliberately: a cue stack stores `targets: ['S1']`, the console
 * types `Screen 1`, and the panels' pickers show `S1`. Only the last step —
 * turning `S1` into a store path — differs, and it differs completely:
 *
 *   nlc   S1 -> screenAuxGroupList/items/S1          (one list for both kinds)
 *   mng   S1 -> transition/screenList/items/1        (two lists, numeric keys)
 *         A1 -> transition/auxiliaryScreenList/items/1
 *
 * So `S1` on a Midra means "screen 1" and never appears on the wire. Screen 1
 * and aux 1 on that platform are both keyed `1` in their own lists, which is
 * exactly why the kind has to live in the identifier and not in the key.
 *
 * ## Everything here was read off a running device, not the protocol guide
 *
 * The `nlc` half is the existing `core/paths.js` and `core/memories.js`,
 * verified on a live Aquilon C (6.2.73). The `mng` half was read off a live
 * Pulse 4K on firmware 3.3.10 (2026-09-12) and off the Midra 4K simulator
 * (3.2.29), whose store has the identical shape for every subtree named here.
 * The vendor's own bundle was read for the one rule that a store dump cannot
 * show — which of `UP`/`DOWN` is program — see `buffers()` below.
 *
 * ## What is the same across the families, and what is not
 *
 * Same: `PROGRAM`/`PREVIEW` as the two recall modes; `xTake`, `xCut`,
 * `xStepBack`, `xTakeAbort`, `xCopyProgramToPreview` as the transition
 * triggers; the six-valued transition status (`AT_UP`, `AT_DOWN`, four
 * in-flight states); `xRequest` as the recall trigger; save being the mirror
 * image of nothing (slot last on save, first on load); `isValid` meaning
 * "something is saved here"; `label` and `xDelete` on the slot.
 *
 * Different, and each one is a path a naive port would send into nowhere:
 *
 * - **Transition times.** nlc has `takeUpTime` and `takeDownTime`; mng has one
 *   `takeTime`. Both in tenths of a second. A fade is therefore *a list of
 *   writes*, and the cue engine asks for the list.
 * - **Preset buffers.** nlc holds three, lettered A/B/C, and which letter is
 *   up is itself device state (`presetUp`/`presetDown`). mng holds two, and
 *   they are literally named `UP` and `DOWN`, so the transition status names
 *   the buffer directly.
 * - **Banks.** nlc: `presetBank` (screens and auxes together, 1000 slots),
 *   `masterPresetBank` (500), `layerBank` (50). mng: `preset/bank` (screens,
 *   200), `preset/auxBank` (auxes, 200), `preset/masterBank` (50), and no
 *   layer bank at all. The slot metadata list is `bankList` on nlc and
 *   `slotList` on mng.
 * - **Which memory a buffer holds.** nlc publishes it in the bank
 *   (`presetBank/status/presetId/...`, keyed by letter); mng publishes it on
 *   the screen (`screenList/items/1/presetList/items/UP/status/pp/memoryId`).
 * - **Which destinations are in service.** nlc says `isUsed` on the group;
 *   mng says it in the *applied* preconfig —
 *   `preconfig/status/stateList/items/CURRENT/screenList/items/<n>/pp/enable`
 *   for screens and `.../auxiliaryScreenList/items/<n>/pp/mode !== 'DISABLE'`
 *   for auxes. Not the `preconfig/control` tree, which is what the operator
 *   has *staged*: a screen enabled there and not yet applied has no outputs.
 * - **Which layers are fitted.** nlc gates on the screen's own
 *   `layerList/items/<k>/status/pp/capability`; mng carries eight slots on
 *   every screen regardless and gates them in the same applied preconfig,
 *   `.../screenList/items/<n>/liveLayerList/items/<k>/pp/mode !== 'DISABLE'`.
 *   Same trap as `core/screens.js` describes: a preset carries geometry for
 *   every slot, fitted or not.
 */

import { ROOT } from './paths.js';
import { resolve as resolveLetters } from '../vendor/surface/preset.js';
import { layerParam, auxLayerParam } from '../vendor/surface/paths.js';
import lpCatalogue from '../vendor/surface/catalogue.json' with { type: 'json' };
import mngCatalogue from '../vendor/surface/catalogue-mng.json' with { type: 'json' };

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};
const num = (v) => (typeof v === 'number' ? v : null);

/** `S1` -> `{kind:'screen', n:'1'}`; `A2` -> `{kind:'aux', n:'2'}`. */
export function parseId(id) {
  const m = /^([SA])(\d+)$/.exec(String(id || ''));
  if (!m) return null;
  return { kind: m[1] === 'A' ? 'aux' : 'screen', n: m[2] };
}

/** The keys of a collection, in the device's order, existing items only. */
function keysOf(list) {
  const items = (list && list.items) || {};
  return Array.isArray(list && list.itemKeys) && list.itemKeys.length
    ? list.itemKeys.filter((k) => items[k])
    : Object.keys(items);
}

/**
 * The six transition states share one rule: the suffix names the end the
 * T-bar is at or came from. `RESTING` is the pair where there is no fade in
 * flight and therefore an honest answer to "which buffer is program".
 */
const RESTING = new Set(['AT_UP', 'AT_DOWN']);
const endsDown = (transition) => String(transition ?? 'AT_DOWN').endsWith('DOWN');

/* ================================================================== nlc */

/**
 * LivePremier. Every path here is byte-identical to what `core/paths.js` and
 * `core/memories.js` have always produced — the tests pin that — so the
 * existing verification on the Aquilon C carries over unchanged.
 */
export const NLC = {
  id: 'nlc',
  name: 'LivePremier',
  /** The buffers a layer path can address, in the device's own spelling. */
  bufferKeys: ['A', 'B', 'C'],

  /** Auxiliaries and screens are one list for takes, two for memories. */
  listNameFor: (id) => (String(id).startsWith('A') ? 'auxiliaryList' : 'screenList'),

  takeControl: (id, prop) => [ROOT, 'screenAuxGroupList', 'items', id, 'control', 'pp', prop],
  takeStatus: (id, prop) => [ROOT, 'screenAuxGroupList', 'items', id, 'status', 'pp', prop],

  /** A fade time is written to both directions. Tenths of a second. */
  fadeCmds: (id, tenths) => [
    { path: NLC.takeControl(id, 'takeUpTime'), value: tenths },
    { path: NLC.takeControl(id, 'takeDownTime'), value: tenths }
  ],

  banks: [
    { kind: 'master', label: 'Master', scope: 'device', targets: 'none', slots: 500, root: ['masterPresetBank'] },
    /* One flat bank for screens AND auxes — `listNameFor` splits them only
       in the recall and save paths. */
    { kind: 'screen', label: 'Screen', scope: 'destination', targets: 'all', slots: 1000, root: ['presetBank'] },
    { kind: 'layer', label: 'Layer', scope: 'layer', targets: 'all', slots: 50, root: ['layerBank'] }
  ],

  /** Where a bank keeps its slot metadata: label, xDelete, isValid. */
  slotList: (bank) => [ROOT, ...bank.root, 'bankList'],

  /** The bank a recall of `kind` addressed at `id` really goes to. */
  bankFor(kind) {
    return this.banks.find((b) => b.kind === kind) || null;
  },

  recall(kind, slot, { mode, id, layer } = {}) {
    const bank = this.bankFor(kind);
    if (!bank || (mode !== 'PROGRAM' && mode !== 'PREVIEW')) return null;
    const base = [ROOT, ...bank.root, 'control', 'load', 'slotList', 'items', String(slot)];
    if (bank.scope === 'device') {
      return { path: [...base, 'presetList', 'items', mode, 'pp', 'xRequest'], value: true };
    }
    if (!id) return null;
    const dest = [...base, this.listNameFor(id), 'items', id, 'presetList', 'items', mode];
    if (bank.scope === 'destination') return { path: [...dest, 'pp', 'xRequest'], value: true };
    if (layer == null || layer === '') return null;
    return { path: [...dest, 'layerList', 'items', String(layer), 'pp', 'xRequest'], value: true };
  },

  save(kind, slot, { mode, id, layer } = {}) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    if (bank.scope === 'device') {
      return {
        path: [ROOT, ...bank.root, 'control', 'save', 'slotList', 'items', String(slot), 'pp', 'xRequest'],
        value: true
      };
    }
    if ((mode !== 'PROGRAM' && mode !== 'PREVIEW') || !id) return null;
    const from = [ROOT, ...bank.root, 'control', 'save', this.listNameFor(id), 'items', id, 'presetList', 'items', mode];
    const tail = ['slotList', 'items', String(slot), 'pp', 'xRequest'];
    if (bank.scope === 'destination') return { path: [...from, ...tail], value: true };
    if (layer == null || layer === '') return null;
    return { path: [...from, 'layerList', 'items', String(layer), ...tail], value: true };
  },

  label(kind, slot, label) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    return { path: [...this.slotList(bank), 'items', String(slot), 'control', 'pp', 'label'], value: String(label ?? '') };
  },

  delete(kind, slot) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    return { path: [...this.slotList(bank), 'items', String(slot), 'control', 'pp', 'xDelete'], value: true };
  },

  /** The save filters as the device has them, read and never written. */
  saveFiltersNode(store, kind, id) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    const base = [ROOT, ...bank.root, 'control', 'save'];
    return bank.scope === 'device'
      ? store.get(base)
      : (id ? store.get([...base, this.listNameFor(id), 'items', id]) : null);
  },

  /** One slot's status, in the shape `listSlots` reports. */
  slotStatus(status) {
    return {
      isValid: !!status.isValid,
      isShadow: !!status.isShadow,
      screens: Array.isArray(status.screenFilter) ? status.screenFilter : null,
      auxes: Array.isArray(status.auxFilter) ? status.auxFilter : null,
      width: status.screenAuxWidth ?? null,
      height: status.screenAuxHeight ?? null
    };
  },

  /**
   * Which letter is program and which is preview on a destination.
   *
   * The rule lives in `vendor/surface/preset.js` and nowhere else; this only
   * shapes its answer. `reported` says whether the device has named the
   * letters at all, and `settled` whether the T-bar is at an end.
   */
  buffers(store, id) {
    const group = store.get([ROOT, 'screenAuxGroupList', 'items', id]) || {};
    const control = pp(group.control);
    const status = pp(group.status);
    const resolved = resolveLetters(group);
    return {
      program: resolved?.program || 'A',
      preview: resolved?.preview || 'B',
      reported: !!(control.presetUp && control.presetDown),
      settled: resolved ? resolved.settled : !status.transition,
      transition: status.transition || null
    };
  },

  /** Which memory each buffer holds, keyed by the buffer's own name. */
  assignments(store, id) {
    const node = store.get([
      ROOT, 'presetBank', 'status', 'presetId', this.listNameFor(id), 'items', id, 'presetList'
    ]);
    const out = {};
    for (const [letter, entry] of Object.entries((node && node.items) || {})) {
      const props = pp(entry);
      out[letter] = {
        slot: Number.isFinite(props.id) ? props.id : null,
        unmodified: props.isNotModified !== false
      };
    }
    return out;
  },

  /**
   * Every screen and auxiliary the device knows about.
   *
   * `isUsed` is the group's word for a destination with outputs; `mode` is
   * DISABLED on an aux that is not set up. Both are honoured before drawing
   * an empty rectangle.
   */
  destinations(store) {
    const out = [];
    for (const [kind, listName] of [['screen', 'screenList'], ['aux', 'auxiliaryList']]) {
      const list = store.get([ROOT, listName]);
      const items = (list && list.items) || {};
      for (const id of keysOf(list)) {
        const node = items[id];
        const status = pp(node && node.status);
        const control = pp(node && node.control);
        const size = pp(node && node.status && node.status.size);
        const group = store.get([ROOT, 'screenAuxGroupList', 'items', id]) || {};
        const gStatus = pp(group.status);
        out.push({
          id, kind, listName,
          label: control.label || '',
          isUsed: gStatus.isUsed === true || (status.mode !== undefined && status.mode !== 'DISABLED'),
          mode: status.mode || null,
          layerCount: num(status.layerCount),
          outputCount: num(status.outputCount),
          canvas: {
            width: num(size.sizeH) > 0 ? size.sizeH : 1920,
            height: num(size.sizeV) > 0 ? size.sizeV : 1080,
            reported: num(size.sizeH) != null && num(size.sizeV) != null
          },
          transition: gStatus.transition || null,
          tbar: num(gStatus.tbarPosition) != null ? gStatus.tbarPosition / 65535 : null,
          /* `status/take` is OFF, TO_UP or TO_DOWN; anything but OFF is a
             fade in progress. Not published by mng at all. */
          isTransitioning: !!gStatus.take && gStatus.take !== 'OFF'
        });
      }
    }
    return out;
  },

  /**
   * The fitted layers of a destination — the slots the screen really has.
   *
   * The preset carries all 128; only the screen's own `layerList` knows which
   * are real, through `status/pp/capability`. NATIVE reads OFF on hardware
   * where it is not allocated and is correctly excluded.
   */
  fittedLayers(store, id) {
    const list = store.get([ROOT, this.listNameFor(id), 'items', id, 'layerList']);
    const items = (list && list.items) || {};
    const out = [];
    for (const key of keysOf(list)) {
      const cap = pp(items[key] && items[key].status).capability;
      if (!cap || cap === 'OFF') continue;
      out.push({ key: String(key), isNative: key === 'NATIVE', capability: cap });
    }
    return out;
  },

  /** Where one buffer's layer geometry lives, and how it is spelled. */
  layerGeometry(store, dest, buffer, key) {
    const node = store.get([ROOT, dest.listName, 'items', dest.id, 'presetList', 'items', buffer, 'layerList', 'items', String(key)]);
    if (!node) return null;
    const position = pp(node.position);
    const source = pp(node.source);
    const opacity = pp(node.opacity);
    return {
      posH: num(position.posH), posV: num(position.posV),
      sizeH: num(position.sizeH), sizeV: num(position.sizeV),
      anchor: position.anchor || 'MIDDLE_CENTER',
      source: source.inputNum || 'NONE',
      opacity: num(opacity.opacity)
    };
  },

  /**
   * One property of one layer, by the store tail the catalogue gives it.
   * Screens and auxiliaries live in different collections, so the id picks
   * the addresser; everything below the layer is identical.
   */
  layerParamPath(id, buffer, layer, tail) {
    const build = String(id).startsWith('A') ? auxLayerParam : layerParam;
    return build(id, buffer, layer, tail);
  },

  /**
   * Pitch compensation: the node under an output's `canvas` that holds the
   * ratios and their commit, and which screen an output belongs to. On
   * LivePremier both are on the output itself.
   */
  pitch: {
    node: 'cmd',
    screenOf: (store, outputKey) =>
      pp(store.get([ROOT, 'outputList', 'items', outputKey, 'canvas', 'status'])).usedInScreenAux || null
  },

  /**
   * The parameter catalogue for this platform's layers — generated by
   * awj-surface's tooling from a device's own bundle and store, vendored
   * whole. 67 parameters in twelve groups on LivePremier 6.2.73.
   */
  catalogue: lpCatalogue,
  /** The id of the property naming a layer's source, and the one reporting it. */
  sourceParam: 'source.inputNum',
  reportedSourceParam: 'source.status.inputNum',

  /** Only live inputs and stills have a picture to fetch. */
  snapshotUrl(source) {
    const m = /^(LIVE|STILL)_(\d+)$/.exec(String(source || ''));
    if (!m) return null;
    return `/api/device/snapshots/${m[1] === 'LIVE' ? 'inputs' : 'images'}/${m[2]}`;
  },

  sourceLabel(source) {
    const s = String(source || 'NONE');
    const m = /^(LIVE|STILL)_(\d+)$/.exec(s);
    if (m) return (m[1] === 'LIVE' ? 'IN' : 'IMG') + m[2];
    return s === 'NONE' ? '' : s.replace(/_/g, ' ');
  }
};

/* ================================================================== mng */

/** The applied preconfig — what the device is running, not what is staged. */
const CURRENT = [ROOT, 'preconfig', 'status', 'stateList', 'items', 'CURRENT'];

/**
 * Midra 4K and Alta 4K.
 *
 * Where a screen and an aux differ in more than the list name, the code says
 * so at the point of difference rather than special-casing up front — the
 * two are the same shape everywhere except the bank they recall from and the
 * word the preconfig uses for "in service".
 */
export const MNG = {
  id: 'mng',
  name: 'Midra 4K / Alta 4K',
  bufferKeys: ['UP', 'DOWN'],

  /** `S1` -> `['screenList', '1']`; `A1` -> `['auxiliaryScreenList', '1']`. */
  split(id) {
    const p = parseId(id);
    if (!p) return null;
    return { list: p.kind === 'aux' ? 'auxiliaryScreenList' : 'screenList', key: p.n, kind: p.kind };
  },

  listNameFor(id) {
    const s = this.split(id);
    return s ? s.list : 'screenList';
  },

  takeControl(id, prop) {
    const s = this.split(id) || { list: 'screenList', key: String(id) };
    return [ROOT, 'transition', s.list, 'items', s.key, 'control', 'pp', prop];
  },

  takeStatus(id, prop) {
    const s = this.split(id) || { list: 'screenList', key: String(id) };
    return [ROOT, 'transition', s.list, 'items', s.key, 'status', 'pp', prop];
  },

  /** One time serves both directions here. Tenths of a second, as on nlc. */
  fadeCmds(id, tenths) {
    return [{ path: this.takeControl(id, 'takeTime'), value: tenths }];
  },

  banks: [
    { kind: 'master', label: 'Master', scope: 'device', targets: 'none', slots: 50, root: ['preset', 'masterBank'] },
    { kind: 'screen', label: 'Screen', scope: 'destination', targets: 'screen', slots: 200, root: ['preset', 'bank'] },
    /* A bank of its own on this platform, where nlc folds auxes into the
       screen bank. Kept as a separate kind so the panel lists it under its
       own chip rather than mixing 200 aux slots into the screen list. */
    { kind: 'aux', label: 'Aux', scope: 'destination', targets: 'aux', slots: 200, root: ['preset', 'auxBank'] }
  ],

  slotList: (bank) => [ROOT, ...bank.root, 'slotList'],

  /**
   * The bank a command really addresses.
   *
   * A cue built as a "screen preset" against `A1` is a legitimate thing to
   * ask for — the cue stack has one action kind for both — and on this
   * platform it has to go to `auxBank`. So the *target* picks the bank when
   * the kind is `screen`, and the answer is the aux bank for an aux id.
   */
  bankFor(kind, id) {
    if (kind === 'screen' && id && parseId(id)?.kind === 'aux') kind = 'aux';
    return this.banks.find((b) => b.kind === kind) || null;
  },

  recall(kind, slot, { mode, id } = {}) {
    const bank = this.bankFor(kind, id);
    if (!bank || (mode !== 'PROGRAM' && mode !== 'PREVIEW')) return null;
    const base = [ROOT, ...bank.root, 'control', 'load', 'slotList', 'items', String(slot)];
    if (bank.scope === 'device') {
      return { path: [...base, 'presetList', 'items', mode, 'pp', 'xRequest'], value: true };
    }
    const s = this.split(id);
    if (!s || (bank.targets !== 'all' && bank.targets !== s.kind)) return null;
    return { path: [...base, s.list, 'items', s.key, 'presetList', 'items', mode, 'pp', 'xRequest'], value: true };
  },

  save(kind, slot, { mode, id } = {}) {
    const bank = this.bankFor(kind, id);
    if (!bank) return null;
    if (bank.scope === 'device') {
      return {
        path: [ROOT, ...bank.root, 'control', 'save', 'slotList', 'items', String(slot), 'pp', 'xRequest'],
        value: true
      };
    }
    if (mode !== 'PROGRAM' && mode !== 'PREVIEW') return null;
    const s = this.split(id);
    if (!s || (bank.targets !== 'all' && bank.targets !== s.kind)) return null;
    return {
      path: [ROOT, ...bank.root, 'control', 'save', s.list, 'items', s.key, 'presetList', 'items', mode,
        'slotList', 'items', String(slot), 'pp', 'xRequest'],
      value: true
    };
  },

  label(kind, slot, label) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    return { path: [...this.slotList(bank), 'items', String(slot), 'control', 'pp', 'label'], value: String(label ?? '') };
  },

  delete(kind, slot) {
    const bank = this.bankFor(kind);
    if (!bank) return null;
    return { path: [...this.slotList(bank), 'items', String(slot), 'control', 'pp', 'xDelete'], value: true };
  },

  saveFiltersNode(store, kind, id) {
    const bank = this.bankFor(kind, id);
    if (!bank) return null;
    const base = [ROOT, ...bank.root, 'control', 'save'];
    if (bank.scope === 'device') return store.get(base);
    const s = this.split(id);
    return s ? store.get([...base, s.list, 'items', s.key]) : null;
  },

  slotStatus(status) {
    return {
      isValid: !!status.isValid,
      isShadow: !!status.isShadow,
      screens: Array.isArray(status.screenFilter) ? status.screenFilter : null,
      auxes: Array.isArray(status.auxFilter) ? status.auxFilter : null,
      /* Screen memories record the canvas they were saved from, under a
         different name from nlc's `screenAuxWidth`. */
      width: status.screenWidth ?? null,
      height: status.screenHeight ?? null
    };
  },

  /**
   * Which of UP and DOWN is program.
   *
   * Read out of the vendor's own bundle rather than inferred: its
   * `presetMode -> preset` function returns UP for PROGRAM when the take
   * status is `AT_UP`, `EFFECT_FROM_UP` or `COPY_FROM_UP`, and DOWN
   * otherwise; PREVIEW is the opposite. That is the same suffix rule the nlc
   * resolver applies to its letters, with the buffers named for the ends.
   *
   * `reported` is whether the device has published a transition status for
   * this destination at all. Without one the fallbacks below are guesses,
   * and a caller about to write to a buffer must not act on a guess.
   */
  buffers(store, id) {
    const transition = store.get(this.takeStatus(id, 'transition'));
    const down = endsDown(transition);
    return {
      program: down ? 'DOWN' : 'UP',
      preview: down ? 'UP' : 'DOWN',
      reported: typeof transition === 'string' && transition !== '',
      settled: RESTING.has(transition),
      transition: transition || null
    };
  },

  /**
   * Which memory each buffer holds. Published on the screen here, not in the
   * bank: `memoryId` is 0 for a buffer that was not loaded from a memory, and
   * `isModified` is the inverse of nlc's `isNotModified`.
   */
  assignments(store, id) {
    const s = this.split(id);
    if (!s) return {};
    const node = store.get([ROOT, s.list, 'items', s.key, 'presetList']);
    const out = {};
    for (const [buffer, entry] of Object.entries((node && node.items) || {})) {
      const props = pp(entry && entry.status);
      out[buffer] = {
        slot: Number.isFinite(props.memoryId) && props.memoryId > 0 ? props.memoryId : null,
        unmodified: props.isModified !== true
      };
    }
    return out;
  },

  /**
   * The destinations, read from the applied preconfig.
   *
   * A Midra has four screens and four auxes whether or not any output is
   * assigned to them, so "in service" is not "in the list". It is `enable` on
   * a screen and a `mode` other than DISABLE on an aux, both under the
   * CURRENT preconfig state — `preconfig/control` is what the operator has
   * staged and may never apply.
   */
  destinations(store) {
    const out = [];
    for (const [kind, listName, prefix] of [['screen', 'screenList', 'S'], ['aux', 'auxiliaryScreenList', 'A']]) {
      const list = store.get([ROOT, listName]);
      const items = (list && list.items) || {};
      for (const key of keysOf(list)) {
        const id = prefix + key;
        const node = items[key];
        const control = pp(node && node.control);
        const applied = pp(store.get([...CURRENT, listName, 'items', key]));
        const size = pp(node && node.canvas && node.canvas.status && node.canvas.status.size);
        const take = pp(store.get([ROOT, 'transition', listName, 'items', key, 'status']));
        const isUsed = kind === 'screen'
          ? applied.enable === true
          : (applied.mode !== undefined && applied.mode !== 'DISABLE');
        out.push({
          id, kind, listName,
          label: control.label || '',
          isUsed,
          mode: kind === 'screen' ? (pp(node && node.status).mode || null) : (applied.mode || null),
          layerCount: num(applied.layerCount),
          outputCount: kind === 'screen'
            ? num(applied.outputCount)
            : (Array.isArray(applied.outputList) ? applied.outputList.length : null),
          canvas: {
            width: num(size.sizeH) > 0 ? size.sizeH : 1920,
            height: num(size.sizeV) > 0 ? size.sizeV : 1080,
            /* An aux has no canvas node; a disabled screen reports 0x0. */
            reported: num(size.sizeH) > 0 && num(size.sizeV) > 0
          },
          transition: take.transition || null,
          tbar: num(take.tbarPosition) != null ? take.tbarPosition / 65535 : null,
          /* No `take` field on this platform; the in-flight transition
             states are the only signal, and they are the honest one. */
          isTransitioning: typeof take.transition === 'string' && !RESTING.has(take.transition)
        });
      }
    }
    return out;
  },

  /**
   * The fitted layers, gated by the applied preconfig.
   *
   * Every screen carries `liveLayerList/items/1..8`; the ones the running
   * configuration has given a scaler read a mode other than DISABLE. An aux
   * has no layers on this platform — its preset is a single background
   * source — so it reports none rather than a slot that cannot be addressed.
   */
  fittedLayers(store, id) {
    const s = this.split(id);
    if (!s || s.kind !== 'screen') return [];
    const list = store.get([...CURRENT, 'screenList', 'items', s.key, 'liveLayerList']);
    const items = (list && list.items) || {};
    const out = [];
    for (const key of keysOf(list)) {
      const mode = pp(items[key]).mode;
      if (!mode || mode === 'DISABLE') continue;
      out.push({ key: String(key), isNative: false, capability: mode });
    }
    return out;
  },

  /**
   * One buffer's layer geometry. Position and size are separate nodes here,
   * there is no anchor (the position is the layer's centre — a 1920x1080
   * layer on a 1920x1080 screen reads `posH: 960, posV: 540`), and the
   * source is `input` rather than `inputNum`.
   */
  layerGeometry(store, dest, buffer, key) {
    const s = this.split(dest.id);
    if (!s) return null;
    const node = store.get([ROOT, s.list, 'items', s.key, 'presetList', 'items', buffer, 'liveLayerList', 'items', String(key)]);
    if (!node) return null;
    const position = pp(node.position);
    const size = pp(node.size);
    const source = pp(node.source);
    const opacity = pp(node.opacity);
    return {
      posH: num(position.posH), posV: num(position.posV),
      sizeH: num(size.sizeH), sizeV: num(size.sizeV),
      anchor: 'MIDDLE_CENTER',
      source: source.input || 'NONE',
      opacity: num(opacity.opacity)
    };
  },

  /**
   * One property of one layer. `liveLayerList` under the buffer, and only on
   * a screen — an aux has no layers here, and asking for one is refused with
   * null rather than spelled into a list that does not exist.
   */
  layerParamPath(id, buffer, layer, tail) {
    const s = this.split(id);
    if (!s || s.kind !== 'screen') return null;
    return [ROOT, s.list, 'items', s.key, 'presetList', 'items', buffer, 'liveLayerList', 'items', String(layer), ...tail];
  },

  /**
   * The ratios live under `canvas/pitch` here (`canvas/cmd` on LivePremier),
   * with the same `pitchRatioH`/`pitchRatioV`/`xUpdate` trio. Which screen an
   * output feeds is not on the output: it is `usedOnScreen` in the applied
   * preconfig, and only for an output whose mode there is SCREEN_FORMAT — a
   * disabled output still carries a `usedOnScreen` of `1`.
   */
  pitch: {
    node: 'pitch',
    screenOf(store, outputKey) {
      const applied = pp(store.get([...CURRENT, 'outputList', 'items', outputKey]));
      if (applied.mode !== 'SCREEN_FORMAT' || !applied.usedOnScreen) return null;
      return 'S' + applied.usedOnScreen;
    }
  },

  /**
   * Generated from a live Pulse 4K's bundle and store (3.3.10) by the same
   * tooling: 57 parameters in fourteen groups. Size is its own group here,
   * the source property is `input`, and nothing reports the source back.
   */
  catalogue: mngCatalogue,
  sourceParam: 'source.input',
  reportedSourceParam: null,

  /** Inputs are `INPUT_<n>`; the snapshot endpoint is numbered the same way. */
  snapshotUrl(source) {
    const m = /^INPUT_(\d+)$/.exec(String(source || ''));
    return m ? `/api/device/snapshots/inputs/${m[1]}` : null;
  },

  sourceLabel(source) {
    const s = String(source || 'NONE');
    const m = /^INPUT_(\d+)$/.exec(s);
    if (m) return 'IN' + m[1];
    return s === 'NONE' ? '' : s.replace(/_/g, ' ');
  }
};

export const DIALECTS = [NLC, MNG];

/**
 * Which dialect this store speaks.
 *
 * Decided by the tree, not by the model name: a LivePremier has
 * `screenAuxGroupList`, a Midra or Alta has `transition/screenList`, and a
 * store that has neither — or has not arrived — gets `null`, which every
 * caller treats as "do not build a path yet". The same rule
 * `core/platform.js` applies to features, applied to the spelling.
 */
export function dialectFor(store) {
  if (!store || !store.ready || !store.get) return null;
  if (store.get([ROOT, 'screenAuxGroupList', 'items']) !== undefined) return NLC;
  if (store.get([ROOT, 'transition', 'screenList', 'items']) !== undefined) return MNG;
  /* A store with no screens at all — a capture trimmed to its outputs — can
     still be told apart by the pitch node, which each platform spells in a
     way the other never does. */
  const outputs = store.get([ROOT, 'outputList', 'items']) || {};
  for (const out of Object.values(outputs)) {
    const canvas = out && out.canvas;
    if (!canvas) continue;
    if (canvas.cmd) return NLC;
    if (canvas.pitch) return MNG;
  }
  return null;
}

/**
 * The dialect, or LivePremier when the store cannot say yet.
 *
 * For callers that must produce *something* to display before hydration —
 * a bank list with its slot count, a picker — and can never send it: the
 * panels refuse to write while the store is not ready, and `dialectFor` is
 * what a write path asks. Do not use this to build a command.
 */
export const dialectOrDefault = (store) => dialectFor(store) || NLC;
