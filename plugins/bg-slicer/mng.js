/*
 * Background Slicer on a Midra 4K or an Alta 4K — the model, the plan and the
 * writes. No DOM, no I/O: `model.js` hands this to the panel instead of
 * `core.js` when the store speaks the mng dialect, and `apply-mng.js` puts the
 * plan on the switcher.
 *
 * ## The platform's own model, which is not LivePremier's
 *
 * Read off the Midra 4K simulator 3.2.29's Web RCS bundle (the code its own
 * Images and Background Sets pages run) and its store, and checked against
 * Alta 4K 1.3.7's bundle, which carries the same enums, attributes and upload
 * handler. A LivePremier cuts a background per OUTPUT, 1:1 in that output's
 * raster, from a still sized to it. A Midra has no stills and no per-output
 * background images:
 *
 *   - **One picture per SCREEN.** A screen has four Background Images
 *     (`screenList/items/<n>/backFrameList/items/1..4`, BKG1..BKG4), each
 *     pointing at a slot of the image library (`control/pp/librarySlot`,
 *     `"NONE"` or `"1"`..`"50"`) and shown in a display mode — `CENTERED`,
 *     `FULLSCREEN`, `CROPPED`, `1_1`, `CUSTOM`. The switcher reports the
 *     size it shows the image at in `status/pp/{width,height}`.
 *   - **A background set picks content for the screen.** Eight per screen,
 *     `backgroundSetList/items/1..8/control/pp/{mode,singleContent}`. In
 *     `SINGLE_AUTOCROP` ("Auto Crop") `singleContent` is one input or one
 *     Background Image (`PRESET_FRAME_<k>`) for the whole screen; in
 *     `MULTI_CUSTOM` ("Custom") each output has its own input
 *     (`outputList/items/<o>/control/pp/{multiContent,multiAlign}`) — an
 *     input only: the attribute stops at `INPUT_16`. There is no set label,
 *     no claim bookkeeping and no apply step: the vendor's page sends each
 *     write on its own.
 *   - **Auto Crop is the switcher's cut.** The Web RCS draws an Auto Crop set
 *     as its content laid over the screen canvas, each output showing its
 *     own rectangle of it (`outputList/items/<o>/canvas/status/pp/{left,top,
 *     pitchedWidth,pitchedHeight}`). So the slicer's image is the screen
 *     canvas, `canvas/status/size/pp/{sizeH,sizeV}`, cut from the picture at
 *     the canvas's own pixels, shown 1:1 (`1_1`), and the switcher crops it.
 *   - **A preset loads a set** through its background layer:
 *     `presetList/items/<UP|DOWN>/background/source/pp/set`, `"NONE"` or
 *     `"1"`..`"8"`. Whether a screen has a background layer at all, and
 *     what it may hold, is the applied preconfig's `backgroundLayerType`:
 *     `DISABLE`, `ONLY_FRAME`, `ONLY_LIVE`, `LIVE_OR_FRAME` — the vendor offers
 *     a Background Image only for the first frame-capable two, an input (and
 *     so `MULTI_CUSTOM` at all) only for the live-capable two.
 *
 * ## The library slot is the switcher's choice
 *
 * The upload is the same route as LivePremier's, `POST /api/device/images/
 * upload`, but its server imports every file with `AUTO_SLOT_WITH_DOWNSCALE`
 * ("First Empty Library Slot with Downscale") and takes no slot at all. The
 * first empty slot is the lowest-numbered with `isValid` false — and the
 * switcher does not skip a slot that a Background or Foreground Image still
 * points at. Seen on a simulator: S1's BKG1 pointed at empty slot 1, and an
 * upload landed there and appeared on S1 at once. So the plan predicts the
 * slot, refuses when any frame points at it, and the write checks the
 * prediction again just before it uploads.
 *
 * ## What "pixel-exact" can mean here
 *
 * This side of it is exact: the image is the canvas, cut from the picture
 * pixel for pixel (`test/bg-slicer-mng.test.js` checks every pixel), uploaded
 * as a PNG, and shown `1_1` — and the write waits for the switcher to report
 * the frame at exactly the canvas size, which it does only when nothing is
 * scaled. The other side is the switcher's arithmetic: at a pitch of 1.000
 * an output's rectangle of the canvas is its area of interest in the raster,
 * pixel for pixel; at any other pitch the switcher scales it, and the plan
 * says so on that output. That the crop lands where the Web RCS draws it has
 * not been seen on a Midra's outputs — a simulator's outputs are a static
 * picture.
 */

import { ROOT } from '../../src/core/paths.js';
import { listDestinations } from '../../src/core/screens.js';
import { screenOutputs } from '../../src/core/pitch.js';
import { dialectFor, MNG } from '../../src/core/dialect.js';
import {
  regionOf, outputBlits, isExact, placementFor, firstFreeSet, suggestInputs, sendingFormatOf,
  templateRate, LABEL_MAX
} from './core.js';

export { firstFreeSet, suggestInputs, sendingFormatOf, LABEL_MAX };

/** Which model this is — `model.js` and the plan carry it. */
export const PLATFORM = 'mng';

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Eight background sets per screen (`BACKGROUND_SET` 1..8). */
export const SET_COUNT = 8;
/** Four Background Images per screen (`BACK_PRESET_FRAME` 1..4, BKG1..BKG4). */
export const FRAME_COUNT = 4;
/** The key of the one image a screen gets, standing where an output's would. */
export const CANVAS_KEY = 'canvas';
/** The display mode that shows an image at its own pixels: "1:1". */
export const ONE_TO_ONE = '1_1';

const CURRENT = [ROOT, 'preconfig', 'status', 'stateList', 'items', 'CURRENT'];
const LIBRARY = [ROOT, 'stillLibrary'];

/** `S2` → `'2'`, the key the screen list uses. */
const screenKey = (id) => (MNG.split(id) || { key: String(id) }).key;
const screenPath = (id, ...tail) => [ROOT, 'screenList', 'items', screenKey(id), ...tail];

/**
 * What a screen's background layer may hold, from the applied preconfig —
 * the vendor's own two predicates (`PIPE_CFG_BACK_TYPE`).
 */
export const takesFrame = (type) => type === 'ONLY_FRAME' || type === 'LIVE_OR_FRAME';
export const takesLive = (type) => type === 'ONLY_LIVE' || type === 'LIVE_OR_FRAME';
/** `PIPE_CFG_BACK_TYPE` as the vendor's Preconfig page words it. */
export const TYPE_WORDS = { DISABLE: 'no background layer', ONLY_FRAME: 'stills only', ONLY_LIVE: 'live inputs only', LIVE_OR_FRAME: 'live inputs or stills' };

/**
 * The plain-language status of each part of the model, for the panel and the
 * docs — as `core.NOTES`, for this platform.
 */
export const NOTES = {
  canvas: { proven: true, text: 'A Midra or Alta takes one background picture per screen, the size of the screen canvas, through a Background Image of the screen — read off the Web RCS and proved on the Midra 4K simulator: the switcher reports the frame at the canvas size, 1:1.' },
  slot: { proven: true, text: 'The switcher, not this panel, chooses the library slot: an upload goes into the first empty slot, even one a Background or Foreground Image still points at. The plan refuses when one does.' },
  autocrop: { proven: false, text: 'In Auto Crop the switcher lays the picture over the screen canvas and each output shows its own rectangle of it — how the Web RCS draws a set; not yet seen on a Midra’s outputs.' },
  pitch: { proven: false, text: 'An output with a pitch ratio other than 1.000 shows its rectangle of the canvas scaled to its area of interest: the switcher resamples it.' },
  aoi: { proven: false, text: 'An output that shows only part of its raster (an area of interest) shows the canvas there; how a Custom input is aligned against that area is not established.' },
  align: { proven: false, text: 'In Custom each output shows its own input, aligned top left; with the input in the output’s own format nothing is scaled — read off the Web RCS, not seen on a switcher.' }
};

/* ------------------------------------------------------------------ topology */

/** Screens in service with a canvas — Midra 4K and Alta 4K only. */
export function readScreens(store) {
  if (!store || !store.ready || dialectFor(store) !== MNG) return [];
  return listDestinations(store)
    .filter((d) => d.kind === 'screen' && d.canvas.reported)
    .map((d) => ({ id: d.id, label: d.label || '', canvas: { width: d.canvas.width, height: d.canvas.height }, backgroundType: backgroundType(store, d.id) }));
}

/** The applied preconfig's background layer type for a screen. */
export function backgroundType(store, screenId) {
  return pp(store.get([...CURRENT, 'screenList', 'items', screenKey(screenId)])).backgroundLayerType || 'DISABLE';
}

/**
 * One output of a screen: its raster, the area of interest it shows the
 * canvas in, and where that sits on the canvas — the same region shape
 * `core.js` builds from a LivePremier output's slices, with the area of
 * interest as the one slice. No rotation, slices or groups exist here.
 */
function outputModel(store, o) {
  const node = store.get([ROOT, 'outputList', 'items', o.key]) || {};
  const st = pp(node.canvas && node.canvas.status);
  const status = pp(node.status);
  const raster = { width: o.pxWidth, height: o.pxHeight };
  const aoi = {
    x: num(st.formatLeft) ?? 0,
    y: num(st.formatTop) ?? 0,
    w: num(st.aoiWidth) || raster.width,
    h: num(st.aoiHeight) || raster.height
  };
  const ratio = { h: o.liveRawH != null ? o.liveRawH / 1000 : 1, v: o.liveRawV != null ? o.liveRawV / 1000 : 1 };
  const region = { slice: 1, ...regionOf({ rect: aoi, box: aoi, origin: { x: o.canvasX, y: o.canvasY }, rotation: 0, ratio }) };
  const connector = MNG.connector('output', node);
  return {
    key: o.key,
    name: `Out ${o.key}`,
    label: String(pp(node.control).label || ''),
    plugs: connector.plug ? connector.plug.split('/') : [],
    device: null,
    format: status.format || null,
    /* The store's rate is plain Hz here; the slicer counts in thousandths,
       as LivePremier's store does. */
    rate: num(status.rate) != null ? Math.round(status.rate * 1000) : null,
    size: { width: num(status.sizeH), height: num(status.sizeV) },
    total: { h: num(status.totalH), v: num(status.totalV) },
    state: 'USED',
    group: '1X1',
    groupShape: { cols: 1, rows: 1 },
    members: [o.key],
    capability: null,
    rotation: 0,
    ratio,
    raster,
    aoi,
    footprint: { x: o.canvasX, y: o.canvasY, w: o.footprintWidth, h: o.footprintHeight },
    regions: [region],
    slicesRead: true
  };
}

/**
 * The one image a screen gets: the canvas, 1:1. It stands where an output
 * stands in a LivePremier plan, so the cut, the render, the zip and the
 * exports need nothing of their own.
 */
export function canvasImage(screen) {
  const { width, height } = screen.canvas;
  const whole = { x: 0, y: 0, w: width, h: height };
  return {
    key: CANVAS_KEY,
    name: 'Canvas',
    label: '',
    plugs: [],
    device: null,
    format: null,
    rate: null,
    total: { h: null, v: null },
    state: 'USED',
    group: '1X1',
    groupShape: { cols: 1, rows: 1 },
    members: [],
    capability: null,
    rotation: 0,
    ratio: { h: 1, v: 1 },
    raster: { width, height },
    regions: [{ slice: 1, aoi: { ...whole }, local: { w: width, h: height }, rotation: 0, ratio: { h: 1, v: 1 }, canvas: { ...whole } }],
    slicesRead: true
  };
}

/** A screen's canvas and its outputs on it, as `core.screenTopology` gives them. */
export function screenTopology(store, screenId) {
  const screen = readScreens(store).find((s) => s.id === screenId);
  if (!screen) return null;
  const outputs = [];
  const skipped = [];
  for (const o of screenOutputs(store, screenId)) {
    if (!(o.pxWidth > 0 && o.pxHeight > 0)) { skipped.push({ key: o.key, why: 'reports no raster' }); continue; }
    outputs.push(outputModel(store, o));
  }
  return { ...screen, outputs, skipped, image: canvasImage(screen) };
}

/** What about an output is the switcher's arithmetic rather than proven, as `NOTES` keys. */
export function assumptionsFor(output) {
  if (output.key === CANVAS_KEY) return ['autocrop'];
  const out = [];
  if (output.ratio.h !== 1 || output.ratio.v !== 1) out.push('pitch');
  const a = output.aoi;
  if (a && (a.x || a.y || a.w !== output.raster.width || a.h !== output.raster.height)) out.push('aoi');
  return out;
}

/* ---------------------------------------------------------------- the device */

/**
 * The eight background sets of a screen, in the shape `core.readSets` gives
 * them — `contents` keyed by output, or by `canvas` for an Auto Crop set's
 * one content — plus what this platform has: the mode, the single content
 * and each output's input and alignment. A set is on program or preview
 * when that buffer's background layer selects it.
 */
export function readSets(store, screenId) {
  const list = store.get(screenPath(screenId, 'backgroundSetList')) || {};
  const items = list.items || {};
  const banks = MNG.buffers(store, screenId);
  const selected = (buffer) => String(pp(store.get(screenPath(screenId, 'presetList', 'items', buffer, 'background', 'source'))).set || 'NONE');
  const onProgram = selected(banks.program);
  const onPreview = selected(banks.preview);
  const out = [];
  for (let n = 1; n <= SET_COUNT; n++) {
    const set = items[String(n)];
    if (!set) continue;
    const ctl = pp(set.control);
    const outputs = {};
    for (const [k, v] of Object.entries((set.outputList && set.outputList.items) || {})) {
      const c = pp(v && v.control);
      outputs[k] = { content: c.multiContent || 'NONE', align: c.multiAlign || 'TOP_LEFT' };
    }
    const mode = ctl.mode || 'SINGLE_AUTOCROP';
    const single = ctl.singleContent || 'NONE';
    const contents = {};
    if (mode === 'SINGLE_AUTOCROP') { if (single !== 'NONE') contents[CANVAS_KEY] = single; }
    else for (const [k, o] of Object.entries(outputs)) if (o.content !== 'NONE') contents[k] = o.content;
    const empty = single === 'NONE' && Object.values(outputs).every((o) => o.content === 'NONE');
    out.push({
      index: n,
      label: '',
      mode,
      single,
      outputs,
      contents,
      onProgram: onProgram === String(n),
      onPreview: onPreview === String(n),
      empty
    });
  }
  return out;
}

/** The sets of a screen naming a Background Image (`PRESET_FRAME_<k>`), anywhere in them. */
function setsNaming(sets, frame) {
  const content = `PRESET_FRAME_${frame}`;
  return sets.filter((s) => s.single === content || Object.values(s.outputs).some((o) => o.content === content));
}

/**
 * The four Background Images of a screen. Free: pointing at no library slot,
 * named by nobody, and in no set of the screen.
 */
export function readFrames(store, screenId, sets = readSets(store, screenId)) {
  const list = store.get(screenPath(screenId, 'backFrameList')) || {};
  const items = list.items || {};
  const out = [];
  for (let k = 1; k <= FRAME_COUNT; k++) {
    const node = items[String(k)];
    if (!node) continue;
    const ctl = pp(node.control);
    const st = pp(node.status);
    const naming = setsNaming(sets, k);
    const librarySlot = String(ctl.librarySlot ?? 'NONE');
    out.push({
      index: k,
      label: String(ctl.label || ''),
      librarySlot,
      mode: ctl.mode || 'CENTERED',
      sizeH: num(ctl.sizeH),
      sizeV: num(ctl.sizeV),
      valid: st.isValid === true,
      width: num(st.width) || 0,
      height: num(st.height) || 0,
      inSets: naming.map((s) => s.index),
      onAir: naming.some((s) => s.onProgram),
      free: librarySlot === 'NONE' && !ctl.label && naming.length === 0
    });
  }
  return out;
}

/** The first free Background Image of a screen, else null. */
export const firstFreeFrame = (frames) => frames.find((f) => f.free) || null;

/**
 * The image library: `{ slots: [{ slot, free, used, fileName, width, height,
 * size }], limits }`. There is no size budget in this store, only the
 * per-file limits the import states (`stillLibrary/import/status/pp`).
 */
export function readLibrary(store) {
  const bank = store.get([...LIBRARY, 'bankList']) || {};
  const items = bank.items || {};
  const keys = Array.isArray(bank.itemKeys) ? bank.itemKeys : Object.keys(items);
  const slots = keys.map((k) => {
    const st = pp(items[k] && items[k].status);
    return {
      slot: Number(k),
      free: st.isValid !== true,
      used: st.isUsed === true,
      fileName: String(st.fileName || ''),
      width: num(st.width) || 0,
      height: num(st.height) || 0,
      size: num(st.fileSize) || 0
    };
  }).filter((s) => Number.isInteger(s.slot)).sort((a, b) => a.slot - b.slot);
  const limits = pp(store.get([...LIBRARY, 'import', 'status']));
  return {
    slots,
    sizeKB: 0,
    maxKB: 0,
    limits: {
      maxWidth: num(limits.maxWidth) || 18000,
      maxHeight: num(limits.maxHeight) || 18000,
      maxPixels: num(limits.maxTotalPixel) || 35389440,
      maxBytes: num(limits.maxFileSize) || 26214400
    }
  };
}

/** The slots the next `count` uploads will land in: the first empty ones, in order. */
export function nextSlots(library, count = 1) {
  return library.slots.filter((s) => s.free).slice(0, count).map((s) => s.slot);
}

/**
 * Every frame on the switcher that points at a library slot — Background and
 * Foreground Images of every screen. An upload into that slot shows on each
 * of them at once.
 */
export function framesOn(store, slot) {
  const out = [];
  const screens = store.get([ROOT, 'screenList', 'items']) || {};
  for (const [key, node] of Object.entries(screens)) {
    for (const [list, abbr] of [['backFrameList', 'BKG'], ['topFrameList', 'FRG']]) {
      for (const [k, f] of Object.entries((node && node[list] && node[list].items) || {})) {
        if (String(pp(f && f.control).librarySlot) === String(slot)) out.push({ screen: `S${key}`, list, index: k, name: `S${key} ${abbr}${k}` });
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------ live inputs */

/**
 * Inputs a Custom set could show, as `core.liveCandidates` gives them:
 * available (`status/pp/isAvailable` — there is no `mapping` here), named and
 * typed by the active plug, with what each is receiving. There is no claim
 * bookkeeping on this platform, so nothing is `usedOnOutput`.
 */
export function liveCandidates(store) {
  const list = store.get([ROOT, 'inputList']) || {};
  const items = list.items || {};
  const signals = new Map(MNG.inputFormats(store).map((f) => [f.key, f]));
  const out = [];
  for (const key of Object.keys(items).filter((k) => /^INPUT_\d+$/.test(k)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
    const node = items[key];
    const status = pp(node && node.status);
    if (status.isAvailable !== true) continue;
    const c = MNG.connector('input', node);
    out.push({
      key,
      label: String(c.label || ''),
      plug: c.plug || null,
      device: null,
      usedOnOutput: null,
      compatibility: [],
      onAir: false,
      state: null,
      signal: signals.get(key) || null
    });
  }
  return out;
}

/** The input plug a Custom input is read from — the one the input is set to. */
const activePlug = (store, input) => String(pp(store.get([ROOT, 'inputList', 'items', input, 'control'])).plug
  || pp(store.get([ROOT, 'inputList', 'items', input, 'status'])).plug || '1');

/**
 * The plug's EDID preferred formats, as `{ key: true }` — `edid/status/pp/
 * prefFormatAvailable`, the list the vendor's EDID page offers. The keys
 * are `SET_EDID_FORMAT`'s, spelt as LivePremier's templates are
 * (`1920_1080_60HZ`, `…_RB`, `CUSTOM_<n>`). Empty on a simulator.
 */
export function plugTemplates(store, input) {
  const list = pp(store.get([ROOT, 'inputList', 'items', input, 'plugList', 'items', activePlug(store, input), 'edid', 'status'])).prefFormatAvailable;
  const out = {};
  for (const k of Array.isArray(list) ? list : []) out[String(k)] = true;
  return out;
}

/**
 * Which preferred format makes a source send exactly an output's format —
 * the choice `core.edidChoice` makes, against this platform's list: a custom
 * output format (`COMPUTER_CUSTOM_<n>`) is `CUSTOM_<n>`, anything else
 * `<w>_<h>_<rate>`, and only what the plug offers.
 */
export function edidChoice(output, templates) {
  const custom = /^COMPUTER_CUSTOM_(\d+)$/.exec(String(output.format || ''));
  if (custom) {
    const key = `CUSTOM_${custom[1]}`;
    return templates && templates[key] ? { kind: 'custom', key, label: `custom format ${custom[1]}` }
      : { kind: null, why: `the plug offers no EDID for custom format ${custom[1]}` };
  }
  const rate = templateRate(output.rate);
  if (!rate) return { kind: null, why: `no EDID format for a rate of ${(output.rate / 1000).toFixed(3)} Hz` };
  const base = `${output.raster.width}_${output.raster.height}_${rate}`;
  const rb = /_RB\d?$/.test(String(output.format || ''));
  const key = (rb ? [`${base}_RB`, base] : [base, `${base}_RB`]).find((k) => templates && templates[k] === true);
  if (key) return { kind: 'template', key, label: key.replace(/_/g, ' ').replace(/(\d+) (\d+)/, '$1×$2') };
  if (!templates || !Object.keys(templates).length) return { kind: null, why: 'the plug lists no EDID preferred formats' };
  return { kind: null, why: `the plug offers no EDID for ${output.raster.width} × ${output.raster.height} at ${rate.replace('HZ', '.').replace(/\.$/, '')} Hz` };
}

/**
 * The writes that set an input plug's EDID preferred format, as the vendor's
 * EDID page sends them: `xRequestPrefFormat` NONE, then the format.
 */
export function edidWrites(input, choice, plug = '1') {
  if (!choice || !choice.kind) return [];
  const path = [ROOT, 'inputList', 'items', input, 'plugList', 'items', String(plug), 'edid', 'cmd', 'pp', 'xRequestPrefFormat'];
  return [{ path, value: 'NONE' }, { path, value: choice.key }];
}
export { activePlug };

/* ------------------------------------------------------------------- paths */

/** One property of a Background Image's control. */
export const framePath = (screenId, frame, prop) => screenPath(screenId, 'backFrameList', 'items', String(frame), 'control', 'pp', prop);
/** One property of a Background Image's status. */
export const frameStatusPath = (screenId, frame, prop) => screenPath(screenId, 'backFrameList', 'items', String(frame), 'status', 'pp', prop);
/** A background set's mode or single content. */
export const setPath = (screenId, set, prop) => screenPath(screenId, 'backgroundSetList', 'items', String(set), 'control', 'pp', prop);
/** A Custom set's input or alignment for one output. */
export const setOutputPath = (screenId, set, out, prop) =>
  screenPath(screenId, 'backgroundSetList', 'items', String(set), 'outputList', 'items', String(out), 'control', 'pp', prop);
/** The background set a preset buffer's background layer shows. */
export const presetSetPath = (screenId, buffer) => screenPath(screenId, 'presetList', 'items', buffer, 'background', 'source', 'pp', 'set');
/** One status property of a preset buffer's background layer. */
export const presetBackgroundStatus = (screenId, buffer, prop) => screenPath(screenId, 'presetList', 'items', buffer, 'background', 'status', 'pp', prop);
/** A library slot's status. */
export const librarySlotPath = (slot, prop) => [...LIBRARY, 'bankList', 'items', String(slot), 'status', 'pp', prop];
/** Empty a library slot — the bin on the vendor's card, pulsed. */
export const libraryDeleteWrites = (slot) => {
  const path = [...LIBRARY, 'bankList', 'items', String(slot), 'control', 'pp', 'xDelete'];
  return [{ path, value: false }, { path, value: true }];
};

/* ------------------------------------------------------------ write lists */

/**
 * Point a Background Image at a library slot and show it 1:1, with a label:
 * the slot as the vendor's library picker sends it (`librarySlot`, the slot
 * number as a string), then the display mode, then the label. Each write
 * carries the value it replaces, so Undo is the list run backwards.
 */
export function frameWrites(store, screenId, frame, slot, label) {
  return withBefore(store, [
    { path: framePath(screenId, frame, 'librarySlot'), value: String(slot) },
    { path: framePath(screenId, frame, 'mode'), value: ONE_TO_ONE },
    { path: framePath(screenId, frame, 'label'), value: String(label || '').slice(0, LABEL_MAX) }
  ]);
}

/**
 * Fill a set with one Background Image across the screen: Auto Crop if it is
 * not already, then the content — the vendor's page offers the drop only in
 * Auto Crop, and its reset puts contents back before the mode, which is the
 * order Undo runs these in.
 */
export function autocropWrites(store, screenId, set, frame) {
  return withBefore(store, [
    { path: setPath(screenId, set, 'mode'), value: 'SINGLE_AUTOCROP' },
    { path: setPath(screenId, set, 'singleContent'), value: `PRESET_FRAME_${frame}` }
  ]);
}

/**
 * Fill a set with an input per output: Custom, then each output's input and
 * its alignment (top left). `inputs` maps output key to `INPUT_<n>`.
 */
export function customWrites(store, screenId, set, inputs) {
  const writes = [{ path: setPath(screenId, set, 'mode'), value: 'MULTI_CUSTOM' }];
  for (const [out, input] of Object.entries(inputs)) {
    writes.push({ path: setOutputPath(screenId, set, out, 'multiContent'), value: input });
    writes.push({ path: setOutputPath(screenId, set, out, 'multiAlign'), value: 'TOP_LEFT' });
  }
  return withBefore(store, writes);
}

/** Load a set into a preset buffer's background layer. */
export const presetWrites = (store, screenId, buffer, set) =>
  withBefore(store, [{ path: presetSetPath(screenId, buffer), value: String(set) }]);

/**
 * Each write with the value now in the store beside it, dropping the ones
 * that would change nothing — a set already in Auto Crop is not told so
 * again, and Undo has nothing to put back for it.
 */
function withBefore(store, writes) {
  return writes
    .map((w) => ({ ...w, before: store.get(w.path) }))
    .filter((w) => w.before !== w.value);
}

/** File name of a screen's image: what the library card will show. */
export function imageName(screenId, output, stem = 'bg') {
  const safe = String(stem || 'bg').replace(/\.[a-z0-9]+$/i, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'bg';
  const what = output.key === CANVAS_KEY ? 'canvas' : `Out${output.key}`;
  return `${safe}_${screenId}_${what}_${output.raster.width}x${output.raster.height}.png`;
}

/* -------------------------------------------------------------- the plan */

/**
 * Everything that would be written, worked out before anything is — the
 * shape `core.buildPlan` returns, so the panel, the render and the exports
 * read it the same way, with `platform: 'mng'` and, per screen, the frame,
 * the library slot the switcher will choose, and how each output crops the
 * canvas (`crops`).
 *
 * `job` is `core.buildPlan`'s, plus `frames: { S2: 3 }` for a Background
 * Image the operator chose. Only a free Background Image and an empty set
 * are chosen by default; a set on program is refused unless
 * `opts.allowProgram`, and so is a frame a set on program shows.
 */
export function buildPlan(store, job, opts = {}) {
  const problems = [];
  const warnings = [];
  const source = job.source === 'live' ? 'live' : 'stills';
  const image = job.image && job.image.width > 0 ? job.image : null;
  if (!image) problems.push(source === 'live' ? 'Set the content size (or choose a picture) first.' : 'Choose a picture first.');

  const library = readLibrary(store);
  const inService = readScreens(store);
  const spanned = (job.screens || []).map((id) => inService.find((s) => s.id === id)).filter(Boolean);
  const stillsScreens = source === 'stills' ? spanned.length : 0;
  /* Uploads go in plan order, each into the first empty slot at the time. */
  const slots = nextSlots(library, stillsScreens);
  let slotAt = 0;

  const screens = [];
  for (const id of job.screens || []) {
    const topo = screenTopology(store, id);
    if (!topo) { problems.push(`${id} is not a screen in service.`); continue; }
    const type = topo.backgroundType;
    const sets = readSets(store, id);
    const assign = source === 'live' || !(job.options && job.options.assignSet === false);
    const setIndex = assign ? Number((job.sets || {})[id]) || (firstFreeSet(sets) || {}).index || null : null;
    const set = assign ? sets.find((s) => s.index === setIndex) || null : null;
    if (assign && !set) problems.push(`${id}: no empty background set — choose one to overwrite.`);
    else if (set && set.onProgram && !opts.allowProgram) problems.push(`${id}: background set ${set.index} is on program — confirm to write it live.`);
    if (assign && source === 'stills' && !takesFrame(type)) {
      problems.push(`${id}: its background layer takes ${TYPE_WORDS[type] || type} (Preconfig ▸ Screens), so it cannot show a Background Image.`);
    }
    if (source === 'live' && !takesLive(type)) {
      problems.push(`${id}: its background layer takes ${TYPE_WORDS[type] || type} (Preconfig ▸ Screens), so a set cannot hold its inputs.`);
    }
    const place = placementFor(job, id, spanned);
    if (!place) problems.push(`${id}: the picture is not placed on this screen.`);
    const display = { ok: type !== 'DISABLE', type, why: type === 'DISABLE' ? 'no background layer in the applied preconfig (Preconfig ▸ Screens) — the set can be built, not shown' : null };

    let outputs;
    let frame = null;
    let crops = [];
    if (source === 'stills') {
      const frames = readFrames(store, id, sets);
      const chosen = Number((job.frames || {})[id]) || null;
      frame = chosen ? frames.find((f) => f.index === chosen) || null : firstFreeFrame(frames);
      if (!frame) problems.push(`${id}: no free Background Image — clear one in Images, or choose one to overwrite.`);
      else if (!frame.free) {
        warnings.push(`${id}: Background Image ${frame.index} is replaced${frame.librarySlot !== 'NONE' ? ` (it shows library slot ${frame.librarySlot})` : ''}${frame.inSets.length ? `, and set${frame.inSets.length > 1 ? 's' : ''} ${frame.inSets.join(', ')} show${frame.inSets.length > 1 ? '' : 's'} it` : ''}.`);
        if (frame.onAir && !opts.allowProgram) problems.push(`${id}: Background Image ${frame.index} is in a set on program — confirm to write it live.`);
      }
      const img = topo.image;
      const blits = image && place ? outputBlits(img, place, image) : [];
      const slot = slots[slotAt++] ?? null;
      const row = {
        key: img.key,
        name: img.name,
        label: '',
        raster: img.raster,
        format: null,
        rate: null,
        total: img.total,
        plugs: [],
        group: '1X1',
        members: [],
        rotation: 0,
        capability: null,
        assumptions: assumptionsFor(img),
        regions: img.regions,
        blits,
        exact: blits.length > 0 && blits.every(isExact),
        covered: blits.length > 0,
        librarySlot: slot,
        still: null,
        frame: frame ? frame.index : null,
        frameBefore: frame ? { librarySlot: frame.librarySlot, mode: frame.mode, label: frame.label } : null,
        content: frame ? `PRESET_FRAME_${frame.index}` : null,
        previous: set ? describeSet(set) : 'NONE'
      };
      if (!blits.length && place) warnings.push(`${id}: the picture does not reach the canvas; it gets a plain background.`);
      const L = library.limits;
      if (img.raster.width > L.maxWidth || img.raster.height > L.maxHeight || img.raster.width * img.raster.height > L.maxPixels) {
        problems.push(`${id}: a ${img.raster.width} × ${img.raster.height} canvas is larger than the image library takes (${L.maxPixels.toLocaleString()} pixels) — the switcher would downscale it.`);
      }
      if (slot == null) problems.push(`${id}: the image library has no empty slot.`);
      else {
        const on = framesOn(store, slot);
        if (on.length) {
          problems.push(`${id}: the switcher puts an upload into the first empty library slot — slot ${slot} — and ${on.map((f) => f.name).join(', ')} already point${on.length === 1 ? 's' : ''} at it, so ${on.length === 1 ? 'it' : 'they'} would show this image too. Clear ${on.length === 1 ? 'that image' : 'those images'} in Images, or fill slot ${slot}, first.`);
        }
      }
      if (set && set.mode === 'MULTI_CUSTOM') warnings.push(`${id} set ${set.index}: Custom becomes Auto Crop; its inputs stay in it, unused.`);
      else if (set && set.single !== 'NONE' && set.single !== row.content) warnings.push(`${id} set ${set.index}: replaces ${set.single}.`);
      outputs = [row];
      crops = topo.outputs.map((o) => ({
        key: o.key,
        name: o.name,
        label: o.label,
        canvas: { ...o.regions[0].canvas },
        aoi: { ...o.aoi },
        raster: { ...o.raster },
        ratio: { ...o.ratio },
        exact: o.ratio.h === 1 && o.ratio.v === 1,
        assumptions: assumptionsFor(o)
      }));
    } else {
      outputs = topo.outputs.map((o) => {
        const blits = image && place ? outputBlits(o, place, image) : [];
        const input = (job.live || {})[`${id}/${o.key}`] || null;
        const before = set && set.outputs[o.key] ? set.outputs[o.key].content : 'NONE';
        const row = {
          key: o.key,
          name: o.name,
          label: o.label,
          raster: o.raster,
          format: o.format,
          rate: o.rate,
          total: o.total,
          plugs: o.plugs,
          group: o.group,
          members: o.members,
          rotation: 0,
          capability: null,
          assumptions: [...assumptionsFor(o), 'align'],
          regions: o.regions,
          aoi: o.aoi,
          blits,
          exact: blits.length > 0 && blits.every(isExact),
          covered: blits.length > 0,
          input,
          edid: (job.edid || {})[`${id}/${o.key}`] || null,
          content: input,
          align: 'TOP_LEFT',
          previous: set && set.mode === 'MULTI_CUSTOM' ? before : (set && set.single !== 'NONE' ? set.single : 'NONE')
        };
        if (!blits.length && place) warnings.push(`${id} ${o.name}: the picture does not reach this output.`);
        if (!input) problems.push(`${id} ${o.name}: choose the input that carries it.`);
        if (set && set.mode === 'MULTI_CUSTOM' && before !== 'NONE' && before !== input) warnings.push(`${id} set ${setIndex} ${o.name}: replaces ${before}.`);
        return row;
      });
      if (set && set.mode === 'SINGLE_AUTOCROP' && set.single !== 'NONE') warnings.push(`${id} set ${set.index}: Auto Crop (${set.single}) becomes Custom.`);
      if (!topo.outputs.length) problems.push(`${id} has no outputs to give a background.`);
    }
    for (const s of topo.skipped) warnings.push(`${id} Out ${s.key}: skipped — ${s.why}.`);
    screens.push({
      id, label: topo.label, canvas: topo.canvas, assign, set, setIndex, place, outputs, crops,
      frame: frame ? { index: frame.index, free: frame.free, librarySlot: frame.librarySlot, onAir: frame.onAir } : null,
      backgroundType: type,
      display,
      /* What `core.buildPlan` calls it, for the code that reads either plan. */
      native: { fitted: display.ok, capability: type }
    });
  }

  const inputsUsed = new Map();
  for (const s of screens) for (const o of s.outputs) {
    if (!o.input) continue;
    if (inputsUsed.has(o.input)) problems.push(`${o.input} is chosen for ${inputsUsed.get(o.input)} and ${s.id} ${o.name} — one input per output.`);
    else inputsUsed.set(o.input, `${s.id} ${o.name}`);
  }

  return {
    ok: problems.length === 0,
    platform: PLATFORM,
    source,
    problems,
    warnings,
    screens,
    capacityChanges: [],
    library: { free: library.slots.filter((s) => s.free).length, slots, sizeKB: 0, maxKB: 0, maxBytes: library.limits.maxBytes }
  };
}

/** What a set holds, in a word or two, for "Replaces". */
function describeSet(set) {
  if (set.mode === 'SINGLE_AUTOCROP') return set.single;
  const n = Object.values(set.outputs).filter((o) => o.content !== 'NONE').length;
  return n ? `Custom, ${n} input${n === 1 ? '' : 's'}` : 'NONE';
}
