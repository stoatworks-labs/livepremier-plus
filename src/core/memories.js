/*
 * The memory banks, as something you can list and fire.
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
 * Midra 4K and Alta 4K keep three as well, but not the same three: a screen
 * bank (200), an **aux bank** of its own (200) where LivePremier folds auxes
 * into the screen bank, a master bank (50), and no layer bank at all. Which
 * set applies, and how each is spelled, comes from `core/dialect.js`; this
 * file states the operations once over whichever set the store has.
 *
 * All of it was read off live devices rather than transcribed from the
 * protocol guide, the same rule the rest of `core/` follows — an Aquilon C
 * (6.2.73) for LivePremier and a Pulse 4K (3.3.10) for Midra 4K.
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

import { NLC, dialectFor, dialectOrDefault, parseId } from './dialect.js';

/**
 * Which store list a destination lives in, on LivePremier.
 *
 * Kept for the callers that spell LivePremier paths directly. Anything that
 * has a store should ask its dialect instead.
 */
export const listNameFor = (id) => NLC.listNameFor(id);

/**
 * The LivePremier banks. `scope` is what a recall has to name beyond the
 * slot, and it is the only thing that really separates them:
 *
 *   'device'      nothing        master memories
 *   'destination' a screen/aux   screen memories
 *   'layer'       both           layer memories
 *
 * `targets` says which destinations a bank serves: `all`, `screen`, `aux`
 * or `none`. Slot counts are not hard-coded — see `slotCount()`; these are
 * the fallback for a store that has not hydrated yet, so an empty panel says
 * "500 empty" rather than "0 slots" and looks broken.
 */
export const BANKS = NLC.banks;

/** The banks this store's platform actually has. */
export const banksFor = (store) => dialectOrDefault(store).banks;

/** The bank descriptor for a kind on a platform, or null. */
export function bankFor(kind, store = null) {
  return dialectOrDefault(store).banks.find((b) => b.kind === kind) || null;
}

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};

/* ------------------------------------------------------------------ read */

/**
 * How many slots this device's bank actually has.
 *
 * Read from the device rather than from the table, because the counts differ
 * by model and a hard-coded 1000 would draw 950 phantom empty slots on a
 * switcher that has 50.
 */
export function slotCount(store, kind) {
  const dialect = dialectOrDefault(store);
  const bank = bankFor(kind, store);
  if (!bank) return 0;
  const list = store.get(dialect.slotList(bank));
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
 * @param {string} kind  'master' | 'screen' | 'layer' | 'aux'
 * @param {{onlyValid?: boolean}} [opts]
 */
export function listSlots(store, kind, { onlyValid = false } = {}) {
  const dialect = dialectOrDefault(store);
  const bank = bankFor(kind, store);
  if (!bank) return [];
  const list = store.get(dialect.slotList(bank));
  const items = (list && list.items) || {};
  const keys = Array.isArray(list && list.itemKeys) && list.itemKeys.length
    ? list.itemKeys.filter((k) => items[k])
    : Object.keys(items);

  const out = [];
  for (const key of keys.slice().sort((a, b) => Number(a) - Number(b))) {
    const node = items[key];
    const status = dialect.slotStatus(pp(node && node.status));
    const control = pp(node && node.control);
    if (onlyValid && !status.isValid) continue;
    out.push({
      slot: Number(key),
      label: typeof control.label === 'string' ? control.label : '',
      isValid: status.isValid,
      /* Master memories can be "self-contained": they carry their own screen
         memories rather than pointing at slots in the screen bank. Worth
         showing, because deleting a screen memory a shadow master depends on
         is safe and deleting one a plain master points at is not. */
      isShadow: status.isShadow,
      /* Which destinations this memory covers. Present on master slots only;
         the other banks answer the question through where you recall them,
         not through what they contain. */
      screens: status.screens,
      auxes: status.auxes,
      /* Screen memories record the canvas they were saved from. Recalling one
         onto a differently-sized screen is legal and the device rescales it,
         but an operator hunting a layout that came back wrong wants to see
         this. */
      width: status.width,
      height: status.height
    });
  }
  return out;
}

/**
 * Which memory sits in each of a destination's preset buffers.
 *
 * Keyed by the buffer's own name — the LETTER on LivePremier (A, B, C), `UP`
 * or `DOWN` on Midra — never by PROGRAM/PREVIEW. Which buffer is on air is a
 * separate question answered by `screens.presetBanks()`, and the two must be
 * combined by the caller rather than assumed here: this file has no business
 * knowing which end of a T-bar a screen is resting at.
 *
 * `unmodified` is the device saying the buffer still matches the memory it
 * was loaded from. It goes false the moment anyone nudges a layer, which is
 * what makes it worth showing — it is the difference between "Screen 1 is
 * showing memory 44" and "Screen 1 is showing something that started life as
 * memory 44".
 *
 * @param {{get: Function}} store
 * @param {string} id  a screen or aux key — `S1`, `A2`
 */
export function assignments(store, id) {
  const dialect = dialectFor(store);
  return dialect ? dialect.assignments(store, id) : {};
}

/* --------------------------------------------------------------- commands */

/*
 * The builders take the dialect last and default it to LivePremier, so the
 * paths they have always produced are unchanged for every existing caller
 * and test. A caller with a store passes `dialectFor(store)` — and gets
 * `null` back for everything while the store has not said which platform
 * it is, because a command spelled for a guess is worse than no command.
 */
const pick = (dialect) => (dialect === undefined ? NLC : dialect);

/**
 * Recall a memory.
 *
 * `mode` is PROGRAM or PREVIEW — the device's own words, and the only two it
 * accepts here. **There is no default**, deliberately: every other recall path
 * in this project defaults to PREVIEW because a recall that lands on air by
 * accident is the worst thing this tool could do, and a required argument is
 * a stronger guarantee than a safe default that one caller forgets to pass.
 *
 * @param {string} kind    'master' | 'screen' | 'layer' | 'aux'
 * @param {number} slot
 * @param {{mode: 'PROGRAM'|'PREVIEW', id?: string, layer?: string|number}} target
 * @returns {{path: string[], value: true}|null}
 */
export function recallCmd(kind, slot, target = {}, dialect) {
  const d = pick(dialect);
  return d ? d.recall(kind, slot, target) : null;
}

/**
 * Save the current state into a memory.
 *
 * Note the shape is NOT the mirror image of recall: on save the slot is the
 * *last* segment rather than the first, because the device models it as "this
 * source, written to that slot" rather than "that slot, loaded from this
 * source". Assuming symmetry here produces a path the device accepts into
 * nowhere — a write that reports success and saves nothing. True on both
 * platforms.
 *
 * Master memories are the exception and take a slot directly, because a master
 * memory has no single source to name: it is the whole device.
 *
 * @param {string} kind
 * @param {number} slot
 * @param {{mode: 'PROGRAM'|'PREVIEW', id?: string, layer?: string|number}} source
 */
export function saveCmd(kind, slot, source = {}, dialect) {
  const d = pick(dialect);
  return d ? d.save(kind, slot, source) : null;
}

/** Rename a memory. The label is free text and the device stores it verbatim. */
export function labelCmd(kind, slot, label, dialect) {
  const d = pick(dialect);
  return d ? d.label(kind, slot, label) : null;
}

/**
 * Erase a memory.
 *
 * An edge trigger like every other x-prefixed property: the device acts on the
 * write and reports nothing, so the only confirmation is `isValid` going false
 * on the next frame.
 */
export function deleteCmd(kind, slot, dialect) {
  const d = pick(dialect);
  return d ? d.delete(kind, slot) : null;
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
  const dialect = dialectOrDefault(store);
  if (!bankFor(kind, store)) return null;
  const props = pp(dialect.saveFiltersNode(store, kind, id));
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

/**
 * The destinations a bank can be recalled onto, out of a full list.
 *
 * LivePremier's screen bank serves screens and auxes alike; Midra's screen
 * bank serves screens and its aux bank serves auxes. The bank says which, and
 * a picker that offered an aux for a bank that cannot address one would build
 * a command the dialect then refuses — a dead button, with no explanation.
 */
export function targetsFor(bank, destinations) {
  if (!bank || bank.targets === 'none') return [];
  if (bank.targets === 'all') return destinations;
  return destinations.filter((d) => (parseId(d.id) || {}).kind === bank.targets);
}
