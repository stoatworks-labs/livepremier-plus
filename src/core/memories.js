/*
 * The three memory banks, as something you can list and fire.
 *
 * LivePremier keeps memories in three separate banks, and they are not
 * variations on one idea — they differ in what they contain, how many there
 * are, and what you have to name to recall one:
 *
 *   master   masterPresetBank   500 slots   a whole show state, every screen
 *                                           and aux at once. Recall names only
 *                                           the slot and PROGRAM/PREVIEW.
 *   screen   presetBank        1000 slots   one screen's layers. Recall names
 *                                           the destination as well.
 *   layer    layerBank           50 slots   one layer. Recall names the
 *                                           destination AND the layer key.
 *
 * All three were read off a live Aquilon rather than transcribed from the
 * protocol guide, the same rule the rest of `core/paths.js` follows.
 *
 * ## Why this file exists at all
 *
 * The vendor's own Memories tab is a React pane, and a React pane cannot be
 * moved into a second window — its event listeners are delegated to the app's
 * root container, so a relocated subtree keeps repainting but stops
 * responding. Popping the bank out therefore means reading the bank
 * ourselves. Everything needed is already in the mirror; this file is the
 * reading half, with no DOM in it so it can be tested against a store capture
 * rather than eyeballed in a panel.
 *
 * ## The trap that would have made recall wrong
 *
 * A slot's *identity* and a slot's *destination* are different halves of the
 * path, and only the destination half knows about screens. `presetBank`
 * numbers its 1000 slots globally — slot 2 is "Keynote 1_S1" and slot 3 is
 * "Keynote 1_S2" — so the slot number does not imply a screen and the label
 * suffix is only a naming habit of whoever saved it. Firing slot 2 at S2 is a
 * perfectly legal thing to ask for, and the device will do it. Nothing here
 * tries to be clever about matching a slot to a screen; the caller says where
 * it goes.
 */

import { ROOT } from './paths.js';

/**
 * Which store list a destination lives in.
 *
 * Auxiliaries are `A1`..`A96` and screens `S1`..`S24`, and the two are
 * addressed through different collections at every level of the bank tree.
 * One rule, stated once, because getting it wrong writes into a collection
 * the device does not have and fails silently.
 */
export const listNameFor = (id) => (String(id).startsWith('A') ? 'auxiliaryList' : 'screenList');

/**
 * The three banks.
 *
 * `scope` is what a recall has to name beyond the slot, and it is the only
 * thing that really separates them:
 *
 *   'device'      nothing        master memories
 *   'destination' a screen/aux   screen memories
 *   'layer'       both           layer memories
 */
export const BANKS = [
  {
    kind: 'master',
    label: 'Master',
    root: 'masterPresetBank',
    scope: 'device',
    /* Slot counts are not hard-coded — see `slotCount()`. These are only the
       fallback for a store that has not hydrated yet, so an empty panel says
       "500 empty" rather than "0 slots" and looks broken. */
    slots: 500
  },
  { kind: 'screen', label: 'Screen', root: 'presetBank', scope: 'destination', slots: 1000 },
  { kind: 'layer', label: 'Layer', root: 'layerBank', scope: 'layer', slots: 50 }
];

const byKind = new Map(BANKS.map((b) => [b.kind, b]));

/** The bank descriptor for a kind, or null. */
export const bankFor = (kind) => byKind.get(kind) || null;

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};

/* ------------------------------------------------------------------ read */

/**
 * How many slots this device's bank actually has.
 *
 * Read from the device rather than from the table above, because the counts
 * differ by model and a hard-coded 1000 would draw 950 phantom empty slots on
 * a switcher that has 50.
 */
export function slotCount(store, kind) {
  const bank = bankFor(kind);
  if (!bank) return 0;
  const list = store.get([ROOT, bank.root, 'bankList']);
  if (!list) return bank.slots;
  const keys = Array.isArray(list.itemKeys) && list.itemKeys.length
    ? list.itemKeys
    : Object.keys(list.items || {});
  return keys.length || bank.slots;
}

/**
 * Every slot in one bank.
 *
 * `isValid` is the device's own word for "something has been saved here", and
 * it is the only honest test: an empty slot still carries a full status node,
 * and a slot someone cleared keeps its label until it is overwritten.
 *
 * Returns slots in numeric order. The store's `itemKeys` is authoritative
 * about which exist, but it is a string array, so sorting it lexically would
 * put slot 10 before slot 2 — the kind of thing that looks like a device
 * quirk for an hour before you notice it is a sort.
 *
 * @param {{get: Function}} store
 * @param {string} kind  'master' | 'screen' | 'layer'
 * @param {{onlyValid?: boolean}} [opts]
 */
export function listSlots(store, kind, { onlyValid = false } = {}) {
  const bank = bankFor(kind);
  if (!bank) return [];
  const list = store.get([ROOT, bank.root, 'bankList']);
  const items = (list && list.items) || {};
  const keys = Array.isArray(list && list.itemKeys) && list.itemKeys.length
    ? list.itemKeys.filter((k) => items[k])
    : Object.keys(items);

  const out = [];
  for (const key of keys.slice().sort((a, b) => Number(a) - Number(b))) {
    const node = items[key];
    const status = pp(node && node.status);
    const control = pp(node && node.control);
    if (onlyValid && !status.isValid) continue;
    out.push({
      slot: Number(key),
      label: typeof control.label === 'string' ? control.label : '',
      isValid: !!status.isValid,
      /* Master memories can be "self-contained": they carry their own screen
         memories rather than pointing at slots in the screen bank. Worth
         showing, because deleting a screen memory a shadow master depends on
         is safe and deleting one a plain master points at is not. */
      isShadow: !!status.isShadow,
      /* Which destinations this memory covers. Present on master slots only;
         the other two banks answer the question through where you recall
         them, not through what they contain. */
      screens: Array.isArray(status.screenFilter) ? status.screenFilter : null,
      auxes: Array.isArray(status.auxFilter) ? status.auxFilter : null,
      /* Screen memories record the canvas they were saved from. Recalling one
         onto a differently-sized screen is legal and the device rescales it,
         but an operator hunting a layout that came back wrong wants to see
         this. */
      width: status.screenAuxWidth ?? null,
      height: status.screenAuxHeight ?? null
    });
  }
  return out;
}

/**
 * Which screen memory sits in each of a destination's three preset buffers.
 *
 * The device publishes this under `presetBank/status/presetId`, keyed by the
 * preset LETTER — A, B, C — not by PROGRAM/PREVIEW. Which letter is on air is
 * a separate question answered by `screens.presetBanks()`, and the two must be
 * combined by the caller rather than assumed here: this file has no business
 * knowing which end of a T-bar a screen is resting at.
 *
 * `isNotModified` is the device saying the buffer still matches the memory it
 * was loaded from. It goes false the moment anyone nudges a layer, which is
 * what makes it worth showing — it is the difference between "Screen 1 is
 * showing memory 44" and "Screen 1 is showing something that started life as
 * memory 44".
 *
 * @param {{get: Function}} store
 * @param {string} id  a screen or aux key — `S1`, `A2`
 */
export function assignments(store, id) {
  const node = store.get([
    ROOT, 'presetBank', 'status', 'presetId', listNameFor(id), 'items', id, 'presetList'
  ]);
  const items = (node && node.items) || {};
  const out = {};
  for (const [letter, entry] of Object.entries(items)) {
    const props = pp(entry);
    out[letter] = {
      slot: Number.isFinite(props.id) ? props.id : null,
      unmodified: props.isNotModified !== false
    };
  }
  return out;
}

/* --------------------------------------------------------------- commands */

/**
 * Recall a memory.
 *
 * `mode` is PROGRAM or PREVIEW — the device's own words, and the only two it
 * accepts here. **There is no default**, deliberately: every other recall path
 * in this project defaults to PREVIEW because a recall that lands on air by
 * accident is the worst thing this tool could do, and a required argument is
 * a stronger guarantee than a safe default that one caller forgets to pass.
 *
 * @param {string} kind    'master' | 'screen' | 'layer'
 * @param {number} slot
 * @param {{mode: 'PROGRAM'|'PREVIEW', id?: string, layer?: string|number}} target
 * @returns {{path: string[], value: true}|null}
 */
export function recallCmd(kind, slot, target = {}) {
  const bank = bankFor(kind);
  const { mode, id, layer } = target;
  if (!bank || (mode !== 'PROGRAM' && mode !== 'PREVIEW')) return null;

  const base = [ROOT, bank.root, 'control', 'load', 'slotList', 'items', String(slot)];

  if (bank.scope === 'device') {
    return { path: [...base, 'presetList', 'items', mode, 'pp', 'xRequest'], value: true };
  }
  if (!id) return null;

  const dest = [...base, listNameFor(id), 'items', id, 'presetList', 'items', mode];
  if (bank.scope === 'destination') {
    return { path: [...dest, 'pp', 'xRequest'], value: true };
  }
  if (layer == null || layer === '') return null;
  return { path: [...dest, 'layerList', 'items', String(layer), 'pp', 'xRequest'], value: true };
}

/**
 * Save the current state into a memory.
 *
 * Note the shape is NOT the mirror image of recall: on save the slot is the
 * *last* segment rather than the first, because the device models it as "this
 * source, written to that slot" rather than "that slot, loaded from this
 * source". Assuming symmetry here produces a path the device accepts into
 * nowhere — a write that reports success and saves nothing.
 *
 * Master memories are the exception and take a slot directly, because a master
 * memory has no single source to name: it is the whole device.
 *
 * @param {string} kind
 * @param {number} slot
 * @param {{mode: 'PROGRAM'|'PREVIEW', id?: string, layer?: string|number}} source
 */
export function saveCmd(kind, slot, source = {}) {
  const bank = bankFor(kind);
  const { mode, id, layer } = source;
  if (!bank) return null;

  if (bank.scope === 'device') {
    return {
      path: [ROOT, bank.root, 'control', 'save', 'slotList', 'items', String(slot), 'pp', 'xRequest'],
      value: true
    };
  }
  if ((mode !== 'PROGRAM' && mode !== 'PREVIEW') || !id) return null;

  const from = [
    ROOT, bank.root, 'control', 'save', listNameFor(id), 'items', id,
    'presetList', 'items', mode
  ];
  const tail = ['slotList', 'items', String(slot), 'pp', 'xRequest'];

  if (bank.scope === 'destination') return { path: [...from, ...tail], value: true };
  if (layer == null || layer === '') return null;
  return { path: [...from, 'layerList', 'items', String(layer), ...tail], value: true };
}

/** Rename a memory. The label is free text and the device stores it verbatim. */
export function labelCmd(kind, slot, label) {
  const bank = bankFor(kind);
  if (!bank) return null;
  return {
    path: [ROOT, bank.root, 'bankList', 'items', String(slot), 'control', 'pp', 'label'],
    value: String(label ?? '')
  };
}

/**
 * Erase a memory.
 *
 * An edge trigger like every other x-prefixed property: the device acts on the
 * write and reports nothing, so the only confirmation is `isValid` going false
 * on the next frame.
 */
export function deleteCmd(kind, slot) {
  const bank = bankFor(kind);
  if (!bank) return null;
  return {
    path: [ROOT, bank.root, 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'],
    value: true
  };
}

/**
 * The filters a save will honour, as the device currently has them set.
 *
 * Save is a two-part operation: the filters say *what* gets written and the
 * xRequest says *go*. We do not touch the filters — they are the vendor UI's
 * to set, and quietly widening them would make a save do more than the
 * operator's last visible choice said it would. Reading them lets the panel
 * say what is about to happen instead.
 */
export function saveFilters(store, kind, { id } = {}) {
  const bank = bankFor(kind);
  if (!bank) return null;
  const base = [ROOT, bank.root, 'control', 'save'];
  const node = bank.scope === 'device'
    ? store.get(base)
    : (id ? store.get([...base, listNameFor(id), 'items', id]) : null);
  const props = pp(node);
  return {
    categories: Array.isArray(props.categoryFilter) ? props.categoryFilter : [],
    layers: Array.isArray(props.layerFilter) ? props.layerFilter : [],
    screens: Array.isArray(props.screenFilter) ? props.screenFilter : null,
    auxes: Array.isArray(props.auxFilter) ? props.auxFilter : null,
    /* Master saves carry a mode saying whether the screen memories underneath
       are rewritten or reused. It changes what a master save costs, so the
       panel shows it rather than firing blind. */
    mode: typeof props.mode === 'string' ? props.mode : null
  };
}
