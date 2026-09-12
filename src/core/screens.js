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
 * ## Two platforms, one reader
 *
 * Every path is asked of the store's dialect (`core/dialect.js`), so the same
 * functions serve a LivePremier and a Midra 4K. The identifiers do not change
 * between them — a destination is `S1` or `A2` on both — only what those
 * spell on the wire. The traps below were each met on one platform and are
 * written down here because the other has its own version of the same thing.
 *
 * ## The trap that would have made this wrong
 *
 * **A preset holds geometry for every layer slot, allocated or not.** On the
 * LivePremier simulator, S1's preset A has layer 2 pointing at `LIVE_3` at
 * full screen — and layer 2 does not exist: the screen's own
 * `layerList/items/2/status/pp/capability` reads `OFF`. A Midra carries eight
 * slots on every screen and the applied preconfig says which have a scaler.
 * Drawing the preset alone would cover every screen with a stack of stale,
 * full-frame layers, all of them plausible-looking and none of them on air.
 *
 * So the preset says *where*, and the platform's fitted-layer list says
 * *whether*. Both are required, and the second is the one that is easy to miss.
 *
 * ## Which buffer is on air
 *
 * `transition` has SIX values, not two: `AT_DOWN`, `AT_UP`, `EFFECT_FROM_DOWN`,
 * `EFFECT_FROM_UP`, `COPY_FROM_DOWN`, `COPY_FROM_UP` — the same enum on both
 * platforms. Every one names the end the T-bar is at or came from, so the rule
 * is the **suffix**. On LivePremier the end names a letter through
 * `presetUp`/`presetDown`; on Midra the buffers are called `UP` and `DOWN` and
 * the end names one directly. Knowing only the two resting values is what
 * made an earlier version read the four in-flight ones backwards.
 */

import { dialectFor, NLC } from './dialect.js';

/** Canvas size fallback, only ever used when the device reports none. */
const DEFAULT_CANVAS = { width: 1920, height: 1080 };

/**
 * Every screen and auxiliary the device knows about.
 *
 * @param {{get: Function}} store
 * @param {{includeUnused?: boolean}} [opts]
 */
export function listDestinations(store, { includeUnused = false } = {}) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  const all = dialect.destinations(store).map((d) => ({
    ...d,
    /* The program/preview pair, so a card can label its two buffers. */
    banks: (({ program, preview }) => ({ program, preview }))(dialect.buffers(store, d.id))
  }));
  return includeUnused ? all : all.filter((d) => d.isUsed);
}

/**
 * Which preset buffer is program on a destination, and which is preview.
 *
 * Exported because several things need it and none should re-derive it: the
 * screen cards draw the buffers, the command line has to resolve a typed
 * `preview` or `program` to the buffer a live layer path actually takes, and
 * the properties panel refuses to write while `settled` is false.
 *
 * @param {{get: Function}} store
 * @param {string} id  a screen or aux key — `S1`, `A2`
 * @returns {{program:string, preview:string, reported:boolean, settled:boolean, transition:string|null}}
 */
export function presetBanks(store, id) {
  const dialect = dialectFor(store);
  if (!dialect) {
    /* Nothing to read yet. The fallbacks are LivePremier's letters, and
       `reported: false` is what stops anyone writing to them. */
    return { program: 'A', preview: 'B', reported: false, settled: true, transition: null };
  }
  return dialect.buffers(store, id);
}

/**
 * The layers of one buffer of one destination, bottom of the stack first.
 *
 * @param {{get: Function}} store
 * @param {{id:string, listName:string, canvas:object}} dest
 * @param {string} bank  a buffer key — `A`/`B`/`C` on LivePremier, `UP`/`DOWN` on Midra
 */
export function readLayers(store, dest, bank) {
  const dialect = dialectFor(store);
  if (!dialect) return [];
  const canvas = dest.canvas || DEFAULT_CANVAS;

  const layers = [];
  for (const fitted of dialect.fittedLayers(store, dest.id)) {
    const geo = dialect.layerGeometry(store, dest, bank, fitted.key);
    if (!geo) continue;
    const layer = readLayer(dialect, fitted, geo, canvas);
    if (layer) layers.push(layer);
  }

  /*
   * Stacking order. The device's own item order is taken as bottom-to-top —
   * on LivePremier NATIVE first and then 1..N, on Midra 1..8, where NATIVE is
   * the slot everything else composites over.
   *
   * ⚠️ Only ever seen with ONE allocated layer on LivePremier, so
   * ascending-is-on-top is the device's ordering rather than a demonstrated
   * z-order. Worth confirming on a two-layer screen before anyone relies on
   * which one occludes.
   */
  return layers;
}

function readLayer(dialect, fitted, geo, canvas) {
  const w = geo.sizeH;
  const h = geo.sizeV;
  if (w == null || h == null) return null;

  const { left, top } = anchorToTopLeft(geo.anchor, geo.posH || 0, geo.posV || 0, w, h);
  const hasSource = !!geo.source && geo.source !== 'NONE';

  return {
    key: fitted.key,
    /* NATIVE is a layer slot that costs mixers — it is not the background,
       which lives in a different subtree and costs nothing. */
    isNative: fitted.isNative,
    label: fitted.isNative ? 'NATIVE' : 'L' + fitted.key,
    source: geo.source || 'NONE',
    hasSource,
    snapshot: dialect.snapshotUrl(geo.source),
    /* 0..256 on the wire, where 256 is opaque. */
    opacity: typeof geo.opacity === 'number' ? Math.min(1, geo.opacity / 256) : 1,
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

/**
 * Turn an anchored position into a top-left corner.
 *
 * The anchor names read `<VERTICAL>_<HORIZONTAL>` — `MIDDLE_CENTER`,
 * `TOP_LEFT` — so each half is resolved on its own rather than from a table of
 * every combination. A name neither half recognises falls back to the centre,
 * which is what the device has been observed to use and is the least wrong
 * place to put a rectangle whose anchor we cannot read. Midra has no anchor
 * property at all and positions are always the centre.
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
 * Only live inputs and stills have a snapshot. Patterns, colours, black and
 * anything else render as a labelled rectangle, which is also what Web RCS
 * does — there is nothing to fetch. Without a store to ask, the LivePremier
 * spelling is assumed, which is what every existing caller passed.
 */
export function snapshotUrl(inputNum, store = null) {
  return (dialectFor(store) || NLC).snapshotUrl(inputNum);
}

/** A short human name for a source, for the label drawn on a layer. */
export function sourceLabel(inputNum, store = null) {
  return (dialectFor(store) || NLC).sourceLabel(inputNum);
}
