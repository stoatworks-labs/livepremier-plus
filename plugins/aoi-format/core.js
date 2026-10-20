/*
 * AoI from a custom format — the arithmetic and the writes. No DOM, no I/O:
 * the page half and the tests import this.
 *
 * ## What it is for
 *
 * An LED wall is defined as a custom format — 3000×1000, say — but the
 * processor takes SDI, which carries only standard formats. So the SDI output
 * runs a standard format at least that big and an AoI (area of interest) the
 * size of the wall: the wall's pixels 1:1 in a corner of the raster, the rest
 * black. The output's footprint on the screen canvas becomes the AoI, so the
 * canvas is laid out in the wall's own pixels. This works out that AoI from a
 * custom format and writes it the way the vendor's own AoI fields do.
 *
 * ## The switcher's model, read off Web RCS 6.2.73 and 6.1.60 (the same in both)
 *
 * - **A custom format** is `customFormats/bankList/items/<n>`: `status/pp`
 *   `hUtil` × `vUtil` active pixels, `rate` in mHz, `isValid`; `control/pp/
 *   userName` its name. The vendor calls slot n "M<n>" in its output format
 *   lists (`COMPUTER_CUSTOM_<n>`).
 * - **An output's AoI** is per slice (connector), at `outputList/items/<o>/
 *   canvas/cmd/slices/aoi/sliceList/items/<k>/pp`: `mode` `FIT_FORMAT` (the
 *   whole active area) or `CUSTOM`, and `left`, `top`, `width`, `height` in
 *   thousandths of a percent of the output's active area — 100000 is 100 %
 *   (`AOI_POS_SIZE_SCALE_RATIO` 1000, × 100). Applied by pulsing `xUpdate`
 *   false → true on the same node, as the vendor's panel does.
 * - **The switcher reports the result in pixels**, at `canvas/status/slices/
 *   sliceList/items/<k>/aoi/pp`, and the reference size at `canvas/status/
 *   slices/aoi/pp/maxWidth|maxHeight`. Pixels from a value are floored
 *   (`createEasyPPAoiTransform.applyTo`), so a pixel count is written rounded
 *   up (`revertFrom`) and comes back exact — `toRaw` and `toPx` below.
 * - ⚠️ **An AoI that runs off the raster is clamped without a word.** On the
 *   6.2.73 simulator, left 8000 + width 92001 on 1920 came back 153 + 1766.
 *   So a format that does not fit is refused here, and what the switcher
 *   reports afterwards is compared with what was asked.
 *
 * Proven on the 6.2.73 simulator (2026-10-20): a 1728×576 AoI on a 1080p
 * output, top left and centred, reported exactly, and the output's canvas
 * footprint (`clampedWidth`, `pitchedWidth`) became 1728×576.
 */

import { ROOT } from '../../src/core/paths.js';

/** 100 % in the switcher's AoI units. */
export const SCALE = 100000;

export const ANCHORS = Object.freeze({
  'top-left': 'Top left',
  'top-centre': 'Top centre',
  centre: 'Centre'
});

const pp = (node) => (node && typeof node === 'object' && node.pp) || {};
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A pixel count as the switcher's value: rounded up, so it floors back to the same pixel. */
export const toRaw = (px, ref) => Math.floor((px * SCALE + ref - 1) / ref);

/** A switcher value as pixels, as the switcher counts them. */
export const toPx = (raw, ref) => Math.floor((raw * ref) / SCALE);

/** `49998` → `49.998 Hz`, trimmed: `60000` → `60 Hz`. */
export function rateLabel(mHz) {
  if (!Number.isFinite(mHz) || mHz <= 0) return '';
  return `${String(Number((mHz / 1000).toFixed(3)))} Hz`;
}

/** The valid custom formats, slot order: `{ key, name, width, height, rate, label }`. */
export function customFormats(store) {
  const list = store.get([ROOT, 'customFormats', 'bankList']);
  const items = (list && list.items) || {};
  const keys = Array.isArray(list && list.itemKeys) ? list.itemKeys : Object.keys(items);
  const out = [];
  for (const key of keys) {
    const s = pp(items[key] && items[key].status);
    const c = pp(items[key] && items[key].control);
    const width = num(s.hUtil);
    const height = num(s.vUtil);
    if (s.isValid !== true || !width || !height) continue;
    const name = typeof c.userName === 'string' ? c.userName.trim() : '';
    const rate = num(s.rate);
    out.push({
      key: String(key), name, width, height, rate,
      label: `M${key}${name ? ` ${name}` : ''} — ${width}×${height}${rate ? ` ${rateLabel(rate)}` : ''}`
    });
  }
  return out;
}

const aoiCmd = (out, slice = '1') => [ROOT, 'outputList', 'items', String(out), 'canvas', 'cmd', 'slices', 'aoi', 'sliceList', 'items', String(slice), 'pp'];
const aoiStatus = (out, slice = '1') => [ROOT, 'outputList', 'items', String(out), 'canvas', 'status', 'slices', 'sliceList', 'items', String(slice), 'aoi', 'pp'];

/**
 * What an output's canvas says about its AoI: the raster it is cut from, the
 * mode and values set, and what the switcher reports in pixels. Null for an
 * output the switcher does not list.
 */
export function outputAoi(store, out) {
  const node = store.get([ROOT, 'outputList', 'items', String(out), 'canvas']);
  if (!node) return null;
  const status = pp(node.status);
  const slices = (node.status && node.status.slices) || {};
  const max = pp(slices.aoi);
  const cmd = pp(node.cmd && node.cmd.slices && node.cmd.slices.aoi && node.cmd.slices.aoi.sliceList
    && node.cmd.slices.aoi.sliceList.items && node.cmd.slices.aoi.sliceList.items['1']);
  const rep = pp(slices.sliceList && slices.sliceList.items && slices.sliceList.items['1'] && slices.sliceList.items['1'].aoi);
  return {
    key: String(out),
    screen: status.usedInScreenAux && status.usedInScreenAux !== 'NONE' ? status.usedInScreenAux : null,
    state: status.isEnabled || null,
    group: status.group || null,
    slices: num(pp(slices).count),
    raster: { width: num(max.maxWidth), height: num(max.maxHeight) },
    mode: cmd.mode || null,
    set: { left: num(cmd.left), top: num(cmd.top), width: num(cmd.width), height: num(cmd.height) },
    reported: { left: num(rep.left), top: num(rep.top), width: num(rep.width), height: num(rep.height) }
  };
}

/** The custom format whose size the output's AoI is now, when it is a custom one. */
export function matchingFormat(output, formats) {
  if (!output || output.mode !== 'CUSTOM') return null;
  const r = output.reported;
  return formats.find((f) => f.width === r.width && f.height === r.height) || null;
}

/** Where a box of `w`×`h` goes in a raster of `W`×`H`, in whole pixels. */
export function place(anchor, w, h, W, H) {
  const centreX = Math.floor((W - w) / 2);
  if (anchor === 'centre') return { left: centreX, top: Math.floor((H - h) / 2) };
  if (anchor === 'top-centre') return { left: centreX, top: 0 };
  return { left: 0, top: 0 };
}

/**
 * The plan for giving one output the AoI of one custom format.
 *
 * @returns {{ok: true, px: object, raw: object, writes: object[]} | {ok: false, why: string}}
 */
export function plan(output, format, anchor = 'top-left') {
  if (!output) return { ok: false, why: 'The switcher does not list that output.' };
  if (!format) return { ok: false, why: 'Pick a custom format.' };
  const label = `Output ${output.key}`;
  if (output.state === 'GROUPED') return { ok: false, why: `${label} is part of another output’s group; its AoI is set on the group’s first output.` };
  if (output.state === 'CLONED' || output.state === 'DUPLICATED') return { ok: false, why: `${label} copies another output, and has no AoI of its own.` };
  if (output.group && output.group !== '1X1') return { ok: false, why: `${label} drives a ${output.group} group: each connector has its own AoI, so set them in the fields above.` };
  if (output.slices != null && output.slices !== 1) return { ok: false, why: `${label} is cut into ${output.slices} slices: set each one’s AoI in the fields above.` };
  const { width: W, height: H } = output.raster;
  if (!W || !H) return { ok: false, why: `${label} reports no active area to cut an AoI from.` };
  if (format.width > W || format.height > H) {
    return { ok: false, why: `M${format.key} is ${format.width}×${format.height}, larger than ${label}’s ${W}×${H}. Give the output a format at least that big first.` };
  }
  const at = place(anchor, format.width, format.height, W, H);
  const px = { left: at.left, top: at.top, width: format.width, height: format.height };
  const raw = { left: toRaw(px.left, W), top: toRaw(px.top, H), width: toRaw(px.width, W), height: toRaw(px.height, H) };
  /* Rounded up, a value can only overrun by the rounding; the switcher would clamp it. */
  if (raw.left + raw.width > SCALE || raw.top + raw.height > SCALE) {
    return { ok: false, why: `${format.width}×${format.height} at ${px.left},${px.top} does not round onto ${label}’s ${W}×${H} exactly.` };
  }
  const base = aoiCmd(output.key);
  const writes = [
    { path: [...base, 'mode'], value: 'CUSTOM' },
    { path: [...base, 'width'], value: raw.width },
    { path: [...base, 'height'], value: raw.height },
    { path: [...base, 'left'], value: raw.left },
    { path: [...base, 'top'], value: raw.top },
    { path: [...base, 'xUpdate'], value: false },
    { path: [...base, 'xUpdate'], value: true }
  ];
  return { ok: true, px, raw, writes };
}

/** Whether the switcher reports the pixels a plan asked for. */
export function landed(store, p, out) {
  const r = store.get(aoiStatus(out)) || {};
  return !!p && p.ok && r.left === p.px.left && r.top === p.px.top && r.width === p.px.width && r.height === p.px.height;
}

/** The output a vendor selection heading names — `Screen 1 - Region 1 - Group 2 - Output 3` — or null. */
export function selectedOutput(text) {
  const m = /(?:^|\s-\s+)Output\s+(\d+)\s*$/.exec(String(text || '').trim());
  return m ? m[1] : null;
}
