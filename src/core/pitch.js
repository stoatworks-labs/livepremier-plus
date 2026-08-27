/*
 * Adapting the device store into the shape the vendored pitch engine expects.
 *
 * Same division of labour as `core/vpu.js` and `vendor/vpu-model.js`: the
 * vendored engine knows the arithmetic and nothing about this repo; this file
 * knows the store and nothing about the arithmetic. Neither reaches into the
 * other's job.
 *
 * The device supplies everything except the one number that matters: the
 * physical pitch of each wall. It has no idea how far apart the LEDs are, and
 * it never will — that is a fact about the room. So the store gives the
 * rasters, the screen membership and whatever ratios are already set, and the
 * operator types the pitches.
 */

import { ROOT } from './paths.js';

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};

/**
 * Where the pitch ratio lives, per output.
 *
 * Not imported from the vendored engine's `awjPath()` even though it produces
 * the same array: that one is aquilon-pitch's idea of the path, and this repo's
 * writes go through `core/paths.js` conventions. They agree today; if they ever
 * stopped, the test in `test/vendor.test.js` says so rather than one silently
 * winning.
 */
export const outputPitch = (outputKey, axis) =>
  [ROOT, 'outputList', 'items', outputKey, 'canvas', 'cmd', 'pp',
    axis === 'H' ? 'pitchRatioH' : 'pitchRatioV'];

/** The commit. Writing a ratio without this moves `cmd` and nothing else. */
export const outputPitchCommit = (outputKey) =>
  [ROOT, 'outputList', 'items', outputKey, 'canvas', 'cmd', 'pp', 'xUpdate'];

/**
 * Every output the device has assigned to one screen, with what it can tell us.
 *
 * `maxWidth`/`maxHeight` is the output's REAL raster and does not move when a
 * pitch ratio is applied — `clampedWidth`/`clampedHeight` and
 * `pitchedWidth`/`pitchedHeight` do, because those are the footprint on the
 * canvas. Reading the wrong pair is the mistake that makes a ratio look like it
 * did nothing, so they are named apart here rather than passed through raw.
 *
 * @param {{get: Function}} store
 * @param {string} screenId  a screen key — `S1`
 */
export function screenOutputs(store, screenId) {
  const list = store.get([ROOT, 'outputList']);
  const items = (list && list.items) || {};
  const keys = Array.isArray(list && list.itemKeys) && list.itemKeys.length
    ? list.itemKeys.filter((k) => items[k])
    : Object.keys(items);

  const out = [];
  for (const key of keys) {
    const canvas = items[key] && items[key].canvas;
    if (!canvas) continue;
    const status = pp(canvas.status);
    if (status.usedInScreenAux !== screenId) continue;

    const cmd = pp(canvas.cmd);
    out.push({
      key,
      /* The raster the output actually drives. */
      pxWidth: status.maxWidth || 0,
      pxHeight: status.maxHeight || 0,
      /* Where the device has put it on the canvas, and how much it takes. */
      canvasX: status.left || 0,
      canvasY: status.top || 0,
      footprintWidth: status.pitchedWidth || 0,
      footprintHeight: status.pitchedHeight || 0,
      /* What is set right now, in the device's thousandths. */
      liveRawH: typeof cmd.pitchRatioH === 'number' ? cmd.pitchRatioH : null,
      liveRawV: typeof cmd.pitchRatioV === 'number' ? cmd.pitchRatioV : null,
      region: status.usedInRegion || null,
      group: status.group || null
    });
  }
  /* Numeric, not lexicographic: output 10 belongs after output 9. */
  return out.sort((a, b) => (Number(a.key) || 0) - (Number(b.key) || 0));
}

/**
 * Turn the live outputs plus the operator's typed pitches into an engine
 * project.
 *
 * `pitches` is keyed by output key: `{ '1': {hMm, vMm}, '2': {...} }`. An
 * output with no pitch typed yet is carried at zero, which the engine reads as
 * "not usable yet" and steps over — the panel stays useful while it is being
 * filled in, rather than going blank until the last field is done.
 *
 * @param {ReturnType<typeof screenOutputs>} outputs
 * @param {Record<string, {hMm: number, vMm: number}>} pitches
 * @param {{referenceKey?: string, arrangement?: 'row'|'column', name?: string}} [opts]
 */
export function toProject(outputs, pitches, opts = {}) {
  return {
    name: opts.name || 'Screen',
    arrangement: opts.arrangement === 'column' ? 'column' : 'row',
    referenceId: opts.referenceKey || '',
    groups: outputs.map((o) => {
      const p = pitches[o.key] || {};
      return {
        id: o.key,
        name: `Output ${o.key}`,
        outputKey: o.key,
        pxWidth: o.pxWidth,
        pxHeight: o.pxHeight,
        entry: { mode: 'pitch', hMm: Number(p.hMm) || 0, vMm: Number(p.vMm) || 0 }
      };
    })
  };
}

/**
 * The writes that would put a computed result onto the device.
 *
 * Deliberately a separate step from computing it. The panel shows the answer
 * without this being called; applying is a button, and a pitch change is a
 * preconfig change on a machine that may be in a show.
 *
 * Skips any group the engine marked out of range — the device would discard
 * those writes anyway, and sending them would leave the operator believing
 * something was set.
 *
 * @param {{groups: Array}} result  a `compensate()` result
 */
export function pitchWrites(result) {
  const writes = [];
  for (const g of result.groups) {
    const key = g.group.outputKey;
    if (!key) continue;
    if (g.h.outOfRange || g.v.outOfRange) continue;
    writes.push({ path: outputPitch(key, 'H'), value: g.h.raw });
    writes.push({ path: outputPitch(key, 'V'), value: g.v.raw });
    writes.push({ path: outputPitchCommit(key), value: true });
  }
  return writes;
}

/**
 * Does what is on the device already match what was computed?
 *
 * The panel leans on this to say "already set" rather than inviting someone to
 * re-apply a configuration that is present — on a live machine the safest
 * button is the one you can see you do not need to press.
 */
export function alreadyApplied(result, outputs) {
  const live = new Map(outputs.map((o) => [o.key, o]));
  let comparable = 0;
  for (const g of result.groups) {
    const o = live.get(g.group.outputKey);
    if (!o || o.liveRawH == null || o.liveRawV == null) continue;
    if (g.h.outOfRange || g.v.outOfRange) continue;
    comparable += 1;
    if (o.liveRawH !== g.h.raw || o.liveRawV !== g.v.raw) return false;
  }
  /* Nothing comparable is not the same as everything matching. */
  return comparable > 0;
}
