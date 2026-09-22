/*
 * The memory bank's own file format, read and written.
 *
 * This is how a look built in the programmer becomes a real memory on the
 * switcher **without going near a preset buffer**. It is the one route that
 * keeps the promise the Edit page makes.
 *
 * ## What was measured, and how
 *
 * All of it on a LivePremier Simulator 6.2.73 over AWJ on 2026-09-22, and none
 * of it from a protocol guide — the guide does not mention the facility at all
 * and neither does Web RCS 6.2.73, which exposes no memory import in its UI.
 *
 * The bank carries an export and an import beside the save and load trees:
 *
 *   presetBank/export/cmd/pp/{selection[1000], path, xRequest}
 *   presetBank/export/status/pp/{fileName, status}
 *   presetBank/import/extract/cmd/pp/{path, xRequest}
 *   presetBank/import/extract/status/pp/status
 *   presetBank/import/load/$bank/@items/<n>/pp/{isValid, label, orgIndex, dstIndex}
 *   presetBank/import/load/cmd/pp/xRequest
 *
 * `path` is a DIRECTORY on export and a FILE on import; the file is always
 * called `Preset.json`, which the export reports back in `status/pp/fileName`.
 * A path that is not a directory answers `ERROR_INVALID_PATH`, and a directory
 * on import answers `ERROR_INVALID_FILE` — the two mistakes are worth knowing
 * because both look like "it did not work".
 *
 * The round trip was proven: a memory was exported, edited by hand, and
 * imported into an empty slot, and the device then reported that slot valid
 * with the label, canvas width and duration that had been typed into the file.
 * No buffer was written, no take was fired.
 *
 * ⚠️ **Only `presetBank` has this.** `masterPresetBank`, `layerBank`,
 * `keyerBank` and `monitoringBank` carry only `control` and `bankList`, and no
 * bank on Midra 4K / Alta 4K has it either. Screen and aux memories on
 * LivePremier, and nothing else.
 *
 * ## The format
 *
 * An array of memories. One memory:
 *
 *   { "BankSlot": 900,
 *     "Layer": { "0": {...}, "1": {...} },
 *     "xPEMEM_BANK_LABEL": "Wide two-shot",
 *     "xPEMEM_BANK_DURATION": 10,
 *     "xPEMEM_BANK_FILTER_CATEGORY": [...], "xPEMEM_BANK_FILTER_LAYER": [...],
 *     "xPEMEM_BANK_SCREEN_WIDTH": 1920, "xPEMEM_BANK_SCREEN_HEIGHT": 1080 }
 *
 * **NATIVE is layer `0`.** The other slots are `1`..`128` under their own
 * numbers. A memory exported with every filter open carries all 129.
 *
 * **The two filters say what the memory contains**, not what it is allowed to
 * do: slot 1 on the simulator was saved with `["SOURCE","POS"]` and its layers
 * carry twelve fields, while the same screen saved with all fourteen
 * categories carries seventy-two. So a memory this file composes declares
 * every category, because it supplies every property.
 *
 * ## The mapping, and why it is trustworthy
 *
 * Sixty-six of the seventy-two per-layer fields are the sixty-six writable
 * parameters of `vendor/surface/catalogue.json`, under different names. The
 * table below was checked rather than guessed: a memory saved with every
 * filter open was compared field-by-field against the live store's own preset
 * node for the same three layers — **198 pairs, 95 of them on a non-default
 * value, and not one disagreement**. `test/preset-file.test.js` pins it
 * against the fixture that comparison used.
 *
 * The six fields with no catalogue parameter are the interesting residue:
 *
 * - `LAYER_CAPABILITY` is not a preset property at all. It is the screen's own
 *   `layerList/items/<k>/status/pp/capability` — which layer slot the memory
 *   expects to find — so it comes from the device and not from the look.
 * - `ROTH`, `ROTV`, `ROTZ`, `BEZIER_PT1_POSZ`, `BEZIER_PT2_POSZ` have no node
 *   anywhere in the live preset tree on this firmware. They are carried
 *   through verbatim when a file is read and emitted at the device's own
 *   values when one is composed, which is the only honest thing to do with a
 *   field whose meaning has never been observed.
 *
 * Going the other way, the catalogue's one read-only parameter —
 * `source.status.inputNum`, the device's echo of the source — is correctly
 * absent from every memory.
 */

import catalogue from '../vendor/surface/catalogue.json' with { type: 'json' };

/** The device always calls it this, whatever directory it is written into. */
export const FILE_NAME = 'Preset.json';

/** Every per-layer field carries this. */
const PREFIX = 'xPEMEM_BANK_';

/** NATIVE's key in a memory file. The device's own layer list spells it out. */
export const NATIVE_KEY = '0';

/**
 * Every category a memory can carry, in the device's own order.
 *
 * Read off `presetBank/control/save/screenList/items/S1/pp/categoryFilter`,
 * which is the list the device itself offers.
 */
export const CATEGORIES = [
  'SOURCE', 'POS', 'SIZE', 'OPACITY', 'CROPPING', 'BORDER', 'TRANSITIONS',
  'EFFECTS', 'FLYING_CURVE', 'TIMING', 'SPEED', 'CUT_AND_FILL', 'MASK', 'KEYER'
];

/**
 * Catalogue parameter id -> memory field name, without the `xPEMEM_BANK_`.
 *
 * Every pair here was confirmed against a live store; see the file header.
 * Two spellings are worth flagging because they read as mistakes and are not:
 * a shadow's `sizeH`/`sizeV` are the file's `BORDER_SHADOW_POS_H`/`POS_V` (it
 * is an offset, not a size), and the whole cut-and-fill subtree is spelled
 * `MASK_*` in the file while `cropping.mask.*` is spelled `CROP_MASK_*`.
 */
export const FIELD_BY_PARAM = {
  'source.inputNum': 'INPUTNUM',
  'source.color.red': 'COLOR_RED',
  'source.color.green': 'COLOR_GREEN',
  'source.color.blue': 'COLOR_BLUE',
  'position.anchor': 'ANCHOR',
  'position.posH': 'POSH',
  'position.posV': 'POSV',
  'position.sizeH': 'SIZEH',
  'position.sizeV': 'SIZEV',
  'position.stereo3d.posZ': 'POSZ',
  'opacity.opacity': 'OPACITY',
  'effects.flags': 'EFFECT_FLAGS',
  'effects.strobe.frames': 'STROBE_FRAME',
  'cropping.classic.top': 'CROP_TOP',
  'cropping.classic.bottom': 'CROP_BOTTOM',
  'cropping.classic.left': 'CROP_LEFT',
  'cropping.classic.right': 'CROP_RIGHT',
  'cropping.classic.aspectOverride': 'ASPECT_OVERRIDE',
  'cropping.mask.top': 'CROP_MASK_TOP',
  'cropping.mask.bottom': 'CROP_MASK_BOTTOM',
  'cropping.mask.left': 'CROP_MASK_LEFT',
  'cropping.mask.right': 'CROP_MASK_RIGHT',
  'border.edge.style': 'BORDER_EDGE_FLAGS',
  'border.edge.radius': 'BORDER_EDGE_RADIUS',
  'border.edge.sizeH': 'BORDER_EDGE_SIZE_H',
  'border.edge.sizeV': 'BORDER_EDGE_SIZE_V',
  'border.edge.opacity': 'BORDER_EDGE_OPACITY',
  'border.edge.color.red': 'BORDER_EDGE_COLOR_RED',
  'border.edge.color.green': 'BORDER_EDGE_COLOR_GREEN',
  'border.edge.color.blue': 'BORDER_EDGE_COLOR_BLUE',
  'border.shadow.style': 'BORDER_SHADOW_FLAGS',
  'border.shadow.radius': 'BORDER_SHADOW_RADIUS',
  'border.shadow.sizeH': 'BORDER_SHADOW_POS_H',
  'border.shadow.sizeV': 'BORDER_SHADOW_POS_V',
  'border.shadow.opacity': 'BORDER_SHADOW_OPACITY',
  'border.shadow.color.red': 'BORDER_SHADOW_COLOR_RED',
  'border.shadow.color.green': 'BORDER_SHADOW_COLOR_GREEN',
  'border.shadow.color.blue': 'BORDER_SHADOW_COLOR_BLUE',
  'transition.flags': 'TRANSITION_FLAGS',
  'transition.opening.type': 'OPENING_TRANSITION',
  'transition.opening.way': 'OPENING_TRANSITION_WAY',
  'transition.closing.type': 'CLOSING_TRANSITION',
  'transition.closing.way': 'CLOSING_TRANSITION_WAY',
  'flying.type': 'FLYING_TYPE',
  'flying.point1.posH': 'BEZIER_PT1_POSH',
  'flying.point1.posV': 'BEZIER_PT1_POSV',
  'flying.point2.posH': 'BEZIER_PT2_POSH',
  'flying.point2.posV': 'BEZIER_PT2_POSV',
  'timing.ratio': 'OPENING_CLOSING_RATIO',
  'timing.opening.start': 'OPENING_START_OFFSET',
  'timing.opening.end': 'OPENING_END_OFFSET',
  'timing.closing.start': 'CLOSING_START_OFFSET',
  'timing.closing.end': 'CLOSING_END_OFFSET',
  'speed.type': 'TBAR_TYPE',
  'speed.point1': 'TBAR_BEZIER_PT1',
  'speed.point2': 'TBAR_BEZIER_PT2',
  'cutNFill.type': 'MASK_TYPE',
  'cutNFill.cut.inputNum': 'MASK_INPUTNUM',
  'cutNFill.cut.curve': 'MASK_CURVE',
  'cutNFill.cut.flags': 'MASK_EFFECT_FLAGS',
  'cutNFill.cut.cropping.top': 'MASK_CROP_TOP',
  'cutNFill.cut.cropping.bottom': 'MASK_CROP_BOTTOM',
  'cutNFill.cut.cropping.left': 'MASK_CROP_LEFT',
  'cutNFill.cut.cropping.right': 'MASK_CROP_RIGHT',
  'keying.enable': 'LAYER_KEYER_ENABLE',
  'keying.source': 'LAYER_KEYER_BANK_SELECT'
};

/**
 * The fields a memory carries that the live preset tree does not.
 *
 * Values are the device's own, read off a memory saved from an untouched
 * buffer. They are emitted so that a composed memory looks exactly like a
 * saved one; nothing here is interpreted.
 */
export const UNMAPPED_DEFAULTS = {
  ROTH: 0,
  ROTV: 0,
  ROTZ: 0,
  BEZIER_PT1_POSZ: 0,
  BEZIER_PT2_POSZ: 0
};

/** The layer capability a memory records when the device has not said. */
const DEFAULT_CAPABILITY = 'OFF';

/* ------------------------------------------------------------------ paths */

/** The writable layer parameters, as `{id, path, field}`, once. */
function params(cat = catalogue) {
  return cat.layer
    .filter((spec) => !spec.readOnly && FIELD_BY_PARAM[spec.id])
    .map((spec) => ({ id: spec.id, path: spec.path, field: FIELD_BY_PARAM[spec.id] }));
}

/**
 * Parameters this catalogue has that the table has no field for.
 *
 * Exported so a test can assert it is empty today and so a firmware that grows
 * a layer property shows up as a named gap rather than as a memory that
 * quietly saves less than the operator set.
 */
export function unmappedParams(cat = catalogue) {
  return cat.layer.filter((spec) => !spec.readOnly && !FIELD_BY_PARAM[spec.id]).map((spec) => spec.id);
}

function getIn(root, path) {
  let node = root;
  for (const seg of path) {
    if (node == null || typeof node !== 'object') return undefined;
    node = node[seg];
  }
  return node;
}

function setIn(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  node[path[path.length - 1]] = value;
}

/** A layer key as the file spells it. NATIVE is zero; everything else is itself. */
export const fileLayerKey = (key) => (String(key) === 'NATIVE' ? NATIVE_KEY : String(key));

/** And back. */
export const storeLayerKey = (key) => (String(key) === NATIVE_KEY ? 'NATIVE' : String(key));

/* ---------------------------------------------------------------- writing */

/**
 * Turn one look into one memory.
 *
 * `layers` is `[{key, node, capability?, unmapped?}]` where `node` is the
 * store-shaped layer subtree — exactly what `core/programmer.js` holds and
 * what the device's own preset carries, so no intermediate shape is invented.
 *
 * A property the look does not carry is left out of the file rather than
 * filled in with a guess. The device tolerates a partial layer — the proving
 * round trip imported a memory with one — and a missing field is honest where
 * an invented one would be a value the operator never chose.
 *
 * @param {object} memory
 * @param {number} memory.slot
 * @param {string} [memory.label]
 * @param {number} [memory.duration]  transition duration, tenths of a second
 * @param {{width:number, height:number}} memory.canvas
 * @param {Array<{key:string, node:object, capability?:string, unmapped?:object}>} memory.layers
 */
export function toMemory({ slot, label = '', duration = 10, canvas, layers = [] }, cat = catalogue) {
  const specs = params(cat);
  const Layer = {};
  const filterLayer = [];

  for (const { key, node, capability, unmapped } of layers) {
    const out = {};
    for (const spec of specs) {
      const value = getIn(node, spec.path);
      if (value === undefined) continue;
      out[PREFIX + spec.field] = value;
    }
    out[PREFIX + 'LAYER_CAPABILITY'] = capability || DEFAULT_CAPABILITY;
    for (const [field, fallback] of Object.entries(UNMAPPED_DEFAULTS)) {
      out[PREFIX + field] = (unmapped && field in unmapped) ? unmapped[field] : fallback;
    }
    Layer[fileLayerKey(key)] = out;
    filterLayer.push(String(key));
  }

  return {
    BankSlot: Number(slot),
    Layer,
    [PREFIX + 'DURATION']: duration,
    /* Everything, because everything was supplied. See the file header. */
    [PREFIX + 'FILTER_CATEGORY']: CATEGORIES.slice(),
    [PREFIX + 'FILTER_LAYER']: filterLayer,
    [PREFIX + 'LABEL']: String(label ?? ''),
    [PREFIX + 'SCREEN_WIDTH']: canvas?.width ?? 1920,
    [PREFIX + 'SCREEN_HEIGHT']: canvas?.height ?? 1080
  };
}

/** Several looks as one file's worth of memories. */
export function toPresetFile(memories, cat = catalogue) {
  return memories.map((m) => toMemory(m, cat));
}

/* ---------------------------------------------------------------- reading */

/**
 * Turn one memory back into a look.
 *
 * The inverse of `toMemory`, and the way a real memory is loaded into the
 * programmer — the only way, because a slot's contents are **not in the device
 * store**. A bank slot publishes `isValid`, `label`, the two filters, the
 * canvas it was saved from and its duration, and nothing whatever about its
 * layers. Exporting it is the only way to see inside one.
 */
export function fromMemory(memory, cat = catalogue) {
  const specs = params(cat);
  const layers = [];

  for (const [fileKey, fields] of Object.entries((memory && memory.Layer) || {})) {
    const node = {};
    for (const spec of specs) {
      const value = fields[PREFIX + spec.field];
      if (value === undefined) continue;
      setIn(node, spec.path, value);
    }
    const unmapped = {};
    for (const field of Object.keys(UNMAPPED_DEFAULTS)) {
      if (fields[PREFIX + field] !== undefined) unmapped[field] = fields[PREFIX + field];
    }
    layers.push({
      key: storeLayerKey(fileKey),
      node,
      capability: fields[PREFIX + 'LAYER_CAPABILITY'] ?? null,
      unmapped
    });
  }

  return {
    slot: Number(memory?.BankSlot),
    label: memory?.[PREFIX + 'LABEL'] ?? '',
    duration: memory?.[PREFIX + 'DURATION'] ?? null,
    categories: memory?.[PREFIX + 'FILTER_CATEGORY'] ?? [],
    canvas: {
      width: memory?.[PREFIX + 'SCREEN_WIDTH'] ?? null,
      height: memory?.[PREFIX + 'SCREEN_HEIGHT'] ?? null
    },
    layers
  };
}

/** A whole file's worth. */
export function fromPresetFile(json, cat = catalogue) {
  const list = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(list)) return [];
  return list.map((m) => fromMemory(m, cat));
}

/**
 * The layer subtree of a look, in the shape `toMemory` wants.
 *
 * Kept here rather than in the panel because the file format is what decides
 * which layers are worth writing: a slot the screen does not have is a layer
 * the memory should not claim to carry.
 *
 * @param {object} bufferNode  a preset node — `{layerList: {items: {...}}}`
 * @param {Array<{key:string, capability?:string}>} fitted
 */
export function layersFrom(bufferNode, fitted, { listName = 'layerList' } = {}) {
  const items = (bufferNode && bufferNode[listName] && bufferNode[listName].items) || {};
  const out = [];
  for (const { key, capability } of fitted) {
    const node = items[String(key)];
    if (!node) continue;
    out.push({ key: String(key), node, capability: capability || DEFAULT_CAPABILITY });
  }
  return out;
}
