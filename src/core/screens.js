/*
 * Screens and auxiliaries, as something you can draw.
 *
 * Web RCS's screen card is not a picture the device sends — there is **no
 * screen snapshot endpoint**. `/api/device/snapshots/<type>/<id>` serves
 * inputs, images, outputs, multiviewers and timers, and nothing else. The
 * card is composed in the browser: layer rectangles laid over the screen's
 * canvas, each filled with the snapshot of whatever source it is showing.
 *
 * This file does the reading half of that, with no DOM in it, so the layout
 * arithmetic can be tested against a real store capture rather than eyeballed
 * in a panel.
 *
 * ## The trap that would have made this wrong
 *
 * **A preset holds geometry for every layer slot, allocated or not.** On the
 * simulator, S1's preset A has layer 2 pointing at `LIVE_3` at full screen —
 * and layer 2 does not exist: the screen's own
 * `layerList/items/2/status/pp/capability` reads `OFF`. Drawing the preset
 * alone would have covered every screen with a stack of stale, full-frame
 * layers, all of them plausible-looking and none of them on air.
 *
 * So the preset says *where*, and the screen's layer list says *whether*.
 * Both are required, and the second is the one that is easy to miss.
 *
 * ## Which bank is on air
 *
 * `screenAuxGroupList/items/<id>/control/pp` carries `presetUp` and
 * `presetDown`, and `status/pp/transition` says which end the screen is at.
 * There is no "program" flag to read — it is this pair or nothing, and getting
 * it backwards would put the preview picture under a PGM label.
 *
 * `transition` has SIX values, not two: `AT_DOWN`, `AT_UP`, `EFFECT_FROM_DOWN`,
 * `EFFECT_FROM_UP`, `COPY_FROM_DOWN`, `COPY_FROM_UP`. Every one names the end
 * the T-bar is at or came from, so the rule is the **suffix** — a name ending
 * DOWN means `presetDown` is the letter on air. Knowing only the two resting
 * values is what made this file read the four in-flight ones backwards; see
 * `presetBanks`.
 *
 * Auxiliaries are the same shape as screens in every respect that matters
 * here, so one reader serves both; they differ only in which list they live
 * in and in `status/pp/mode`, which reads `DISABLED` until one is set up.
 */

import { ROOT } from './paths.js';
// The program/preview rule lives here and nowhere else — see presetBanks().
import { resolve } from '../vendor/surface/preset.js';

/** Canvas size fallback, only ever used when the device reports none. */
const DEFAULT_CANVAS = { width: 1920, height: 1080 };

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};

/**
 * Every screen and auxiliary the device knows about.
 *
 * @param {{get: Function}} store
 * @param {{includeUnused?: boolean}} [opts]
 */
export function listDestinations(store, { includeUnused = false } = {}) {
  const out = [];
  for (const [kind, listName] of [['screen', 'screenList'], ['aux', 'auxiliaryList']]) {
    const list = store.get([ROOT, listName]);
    const items = (list && list.items) || {};
    const keys = Array.isArray(list && list.itemKeys) && list.itemKeys.length
      ? list.itemKeys.filter((k) => items[k])
      : Object.keys(items);
    for (const id of keys) {
      const dest = readDestination(store, kind, listName, id, items[id]);
      if (dest.isUsed || includeUnused) out.push(dest);
    }
  }
  return out;
}

/**
 * Which preset bank is program on a destination, and which is preview.
 *
 * `AT_UP` / `AT_DOWN` name the end of the travel, not the bank. The pair has
 * to be read off `presetUp`/`presetDown` — never assume A is program, because
 * a take swaps them and the mapping differs between screens on one device.
 *
 * Exported because two things need it and neither should re-derive it: the
 * screen cards draw the banks, and the command line has to resolve a typed
 * `preview` or `program` to the buffer a live layer path actually takes.
 *
 * @param {{get: Function}} store
 * @param {string} id  a screen or aux key — `S1`, `A2`
 */
export function presetBanks(store, id) {
  const group = store.get([ROOT, 'screenAuxGroupList', 'items', id]) || {};
  const gControl = pp(group.control);
  const gStatus = pp(group.status);

  /*
   * The rule is the SUFFIX of the transition state, not a test against one
   * value. SCREENGROUP_STATUS has six members — AT_DOWN, AT_UP,
   * EFFECT_FROM_DOWN, EFFECT_FROM_UP, COPY_FROM_DOWN, COPY_FROM_UP — and each
   * names the end the T-bar is at or came from. This used to read
   * `transition !== 'AT_DOWN'`, which takes EFFECT_FROM_DOWN and
   * COPY_FROM_DOWN for "up" and therefore reports presetUp as program while
   * presetDown is the letter actually on air. Backwards for exactly as long as
   * a transition lasts, which is when a Console command addressed to "preview"
   * would land in the program buffer — the failure AGENTS.md says this design
   * exists to prevent.
   *
   * resolve() in vendor/surface/preset.js already had this right, with a
   * comment naming this precise mistake. One rule, one implementation.
   */
  const resolved = resolve(group);

  return {
    program: resolved?.program || 'A',
    preview: resolved?.preview || 'B',
    /* Whether the device actually said, as against these being the fallbacks.
       A command that would put a layer in the wrong buffer must refuse rather
       than run on a guess, so the caller needs to be able to tell. */
    reported: !!(gControl.presetUp && gControl.presetDown),
    /* False while the T-bar is between the ends. Mid-transition there is no
       honest answer to "which one is program", so a caller that needs
       certainty — anything about to WRITE to a bank — waits on this rather
       than acting on the letter above. */
    settled: resolved ? resolved.settled : !gStatus.transition
  };
}

function readDestination(store, kind, listName, id, node) {
  const status = pp(node && node.status);
  const control = pp(node && node.control);
  const size = pp(node && node.status && node.status.size);
  const group = store.get([ROOT, 'screenAuxGroupList', 'items', id]) || {};
  const gControl = pp(group.control);
  const gStatus = pp(group.status);
  const { program, preview } = presetBanks(store, id);

  return {
    id,
    kind,
    listName,
    /* The operator's own name for it, when they have given it one. */
    label: control.label || '',
    /* A screen with no outputs is configured but not in service. `isUsed` is
       the group's word for it; `mode` is DISABLED on an aux that is not set
       up, and both are worth honouring before drawing an empty rectangle. */
    isUsed: gStatus.isUsed === true || (status.mode !== undefined && status.mode !== 'DISABLED'),
    mode: status.mode || null,
    layerCount: typeof status.layerCount === 'number' ? status.layerCount : null,
    outputCount: typeof status.outputCount === 'number' ? status.outputCount : null,
    canvas: {
      width: typeof size.sizeH === 'number' && size.sizeH > 0 ? size.sizeH : DEFAULT_CANVAS.width,
      height: typeof size.sizeV === 'number' && size.sizeV > 0 ? size.sizeV : DEFAULT_CANVAS.height,
      /* Say when it was not reported, so a caller can decide whether a
         1920x1080 assumption is safe to draw a real layout against. */
      reported: typeof size.sizeH === 'number' && typeof size.sizeV === 'number'
    },
    banks: { program, preview },
    transition: gStatus.transition || null,
    /* 0..65535 across the travel; the fader position mid-transition. */
    tbar: typeof gStatus.tbarPosition === 'number' ? gStatus.tbarPosition / 65535 : null,
    /* `status/take` is an enum of OFF, TO_UP, TO_DOWN — catalogue.json, read
       off a real device — and 'ON' is not one of them, so this was always
       false and the TAKE tag on the screen card was dead. `!== 'OFF'` also
       gives the completion edge a cue engine wants: the device goes TO_UP for
       the length of the fade and back to OFF at the end. */
    isTransitioning: !!gStatus.take && gStatus.take !== 'OFF'
  };
}

/**
 * The layers of one bank of one destination, bottom of the stack first.
 *
 * @param {{get: Function}} store
 * @param {{id:string, listName:string, canvas:object}} dest
 * @param {'A'|'B'|'C'} bank
 */
export function readLayers(store, dest, bank) {
  const base = [ROOT, dest.listName, 'items', dest.id];
  const allocated = store.get([...base, 'layerList']);
  const preset = store.get([...base, 'presetList', 'items', bank]);
  const geometry = (preset && preset.layerList) || null;
  if (!allocated || !geometry) return [];

  const items = allocated.items || {};
  const order = Array.isArray(allocated.itemKeys) && allocated.itemKeys.length
    ? allocated.itemKeys
    : Object.keys(items);

  const layers = [];
  for (const key of order) {
    /* The gate. A preset carries all 128 slots whether or not the screen has
       them; only the screen's own list knows which are real. */
    const cap = pp(items[key] && items[key].status).capability;
    if (!cap || cap === 'OFF') continue;

    const geo = geometry.items && geometry.items[key];
    if (!geo) continue;
    const layer = readLayer(key, geo, dest.canvas);
    if (layer) layers.push(layer);
  }

  /*
   * Stacking order. `itemKeys` puts NATIVE first and then 1..N ascending,
   * which is the device's own ordering and is taken as bottom-to-top —
   * NATIVE is the slot everything else composites over.
   *
   * ⚠️ Only ever seen with ONE allocated layer, so ascending-is-on-top is the
   * device's ordering rather than a demonstrated z-order. Worth confirming on
   * a two-layer screen before anyone relies on which one occludes.
   */
  return layers;
}

function readLayer(key, node, canvas) {
  const position = pp(node.position);
  const source = pp(node.source);
  const opacity = pp(node.opacity);

  const w = num(position.sizeH);
  const h = num(position.sizeV);
  if (w == null || h == null) return null;

  const { left, top } = anchorToTopLeft(position.anchor, num(position.posH) || 0, num(position.posV) || 0, w, h);

  return {
    key: String(key),
    /* NATIVE is a layer slot that costs mixers — it is not the background,
       which lives in a different subtree and costs nothing. */
    isNative: key === 'NATIVE',
    label: key === 'NATIVE' ? 'NATIVE' : 'L' + key,
    source: source.inputNum || 'NONE',
    hasSource: !!source.inputNum && source.inputNum !== 'NONE',
    snapshot: snapshotUrl(source.inputNum),
    /* 0..256 on the wire, where 256 is opaque. */
    opacity: typeof opacity.opacity === 'number' ? Math.min(1, opacity.opacity / 256) : 1,
    rect: { left, top, width: w, height: h },
    /* The same rectangle as fractions of the canvas, which is what a view
       actually needs and what keeps the scaling arithmetic in one place. */
    frac: {
      left: left / canvas.width,
      top: top / canvas.height,
      width: w / canvas.width,
      height: h / canvas.height
    }
  };
}

const num = (v) => (typeof v === 'number' ? v : null);

/**
 * Turn an anchored position into a top-left corner.
 *
 * The anchor names read `<VERTICAL>_<HORIZONTAL>` — `MIDDLE_CENTER`,
 * `TOP_LEFT` — so each half is resolved on its own rather than from a table of
 * every combination. A name neither half recognises falls back to the centre,
 * which is what the device has been observed to use and is the least wrong
 * place to put a rectangle whose anchor we cannot read.
 */
export function anchorToTopLeft(anchor, posH, posV, width, height) {
  const [v, hz] = String(anchor || 'MIDDLE_CENTER').split('_');
  const left = hz === 'LEFT' ? posH : hz === 'RIGHT' ? posH - width : posH - width / 2;
  const top = v === 'TOP' ? posV : v === 'BOTTOM' ? posV - height : posV - height / 2;
  return { left, top };
}

/**
 * Where to find a picture of a source, if there is one.
 *
 * Only two source families have a snapshot: live inputs and stills. Patterns,
 * colours, black and anything else render as a labelled rectangle, which is
 * also what Web RCS does — there is nothing to fetch.
 */
export function snapshotUrl(inputNum) {
  const m = /^(LIVE|STILL)_(\d+)$/.exec(String(inputNum || ''));
  if (!m) return null;
  const type = m[1] === 'LIVE' ? 'inputs' : 'images';
  return `/api/device/snapshots/${type}/${m[2]}`;
}

/** A short human name for a source, for the label drawn on a layer. */
export function sourceLabel(inputNum) {
  const s = String(inputNum || 'NONE');
  const m = /^(LIVE|STILL)_(\d+)$/.exec(s);
  if (m) return (m[1] === 'LIVE' ? 'IN' : 'IMG') + m[2];
  return s === 'NONE' ? '' : s.replace(/_/g, ' ');
}
