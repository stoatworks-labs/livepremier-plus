/*
 * What box is this, and what firmware is on it.
 *
 * One small reader, because more than one thing now needs the answer and each
 * of them was about to dig through `system/deviceList` on its own. The
 * settings page prints it; the point of putting it in `core/` is that model
 * gating — offering a command or a graph only on hardware that has the thing —
 * has to ask the same question and get the same answer.
 *
 * ## The fields, and what they are actually worth
 *
 * `system/deviceList/items/<n>/pp` on a LivePremier reads:
 *
 *     { dev: 'NLC_CMAX', platformId: 1280, label: 'AQUILON', isSimulated: true }
 *
 * - **`dev`** is the model code and the only field precise enough to gate on.
 *   `NLC_CMAX` is an Aquilon C max; the range has a code each.
 * - **`platformId`** is a number the vendor assigns; it groups a range.
 *   Recorded, not interpreted — one observation is not a mapping.
 * - **`label`** is the product family as the vendor writes it. Human-facing.
 * - **`isSimulated`** is the simulator telling on itself, and it matters:
 *   a simulator has no VPU, so a panel that finds none on a simulated device
 *   is correct rather than broken.
 *
 * Nothing here guesses. An absent field comes back as `null` and the caller
 * decides what to do about it, because "unknown model" and "a model with no
 * VPU" are different situations and only one of them is a reason to hide a
 * feature.
 *
 * ## Why it is a list, and why most of the list is nothing
 *
 * A LivePremier can be up to four linked frames, and `deviceList` is that
 * list — but it is **always four entries long**, on a single-frame system as
 * much as on a linked one. The empty slots are not absent, they are filled in
 * with a placeholder: `dev: 'NLC_DBG'`, an empty `label`, an empty `updater`,
 * an empty serial. Seen on the simulator, and matching the real Aquilon C,
 * which reported slots 2-4 the same way.
 *
 * So `frames` is every slot and `linked` is the ones that are really there.
 * The test for "really there" is **an empty label or an empty firmware**, not
 * the string `NLC_DBG`: a placeholder that names itself is convenient, but a
 * list of magic model codes is exactly the thing that goes stale on a range
 * this project has not met yet, and a frame that is present will always say
 * what it is and what it is running.
 */

import { ROOT } from './paths.js';

const pp = (node) => (node && typeof node === 'object' ? node.pp : null) || {};
const str = (v) => (typeof v === 'string' && v !== '' ? v : null);
const num = (v) => (typeof v === 'number' ? v : null);

/**
 * Read every frame the device store knows about.
 *
 * @param {{get: Function, ready?: boolean}} store
 * @returns {{present: boolean, frames: Array<object>, linked: Array<object>, primary: object|null}}
 */
export function readIdentity(store) {
  const list = store && store.get ? store.get([ROOT, 'system', 'deviceList']) : null;
  const items = (list && list.items) || null;
  if (!items) return { present: false, frames: [], linked: [], primary: null };

  /* `itemKeys` is the device's own ordering — the master first. Falling back
     to Object.keys only when it is missing keeps that ordering meaningful. */
  const keys = Array.isArray(list.itemKeys) && list.itemKeys.length
    ? list.itemKeys.filter((k) => items[k])
    : Object.keys(items);

  const frames = keys.map((k) => readFrame(k, items[k]));
  const linked = frames.filter((f) => f.populated);
  /* Fall back to the first slot when nothing looks populated: better to print
     whatever the box did say than to report no device on a build that fills
     these fields in somewhere we have not looked. */
  return { present: frames.length > 0, frames, linked, primary: linked[0] || frames[0] || null };
}

function readFrame(key, node) {
  const head = pp(node);
  const version = pp(node && node.version);
  const serial = pp(node && node.serial);
  const hardware = pp(node && node.hardware && node.hardware.device);

  return {
    key: String(key),
    /* Is there a frame in this slot at all — see the header. */
    populated: str(head.label) !== null && str(version.updater) !== null,
    /* The model code. Gate on this one. */
    model: str(head.dev),
    platformId: num(head.platformId),
    /* Product family as the vendor writes it — AQUILON, and whatever the
       Midra 4K and Alta 4K ranges answer, which is not yet known here. */
    family: str(head.label),
    simulated: head.isSimulated === true,
    firmware: str(version.updater),
    /* Empty on a simulator, and empty is not the same as old. */
    webRcs: str(version.webRcs),
    outdated: version.isOutdated === true,
    serial: str(serial.serialNumber),
    chassis: str(hardware.chassis)
  };
}

/**
 * A one-line name for a frame, for anywhere a person reads it.
 *
 * Falls back through what is present rather than printing "undefined": the
 * code alone is still useful, and no code at all is worth saying out loud
 * because it means this build reports identity somewhere else.
 */
export function describe(frame) {
  if (!frame) return 'unknown device';
  const bits = [];
  if (frame.family) bits.push(frame.family);
  if (frame.model) bits.push(frame.model);
  if (!bits.length) bits.push('unrecognised model');
  if (frame.simulated) bits.push('(simulator)');
  return bits.join(' ');
}
