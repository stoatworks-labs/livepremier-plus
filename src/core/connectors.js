/*
 * The device's physical connectors — the plugs on the back of the frame.
 *
 * Nothing else in this app has needed these. The VPU map reads `outputList`
 * for the header over its grid (`core/vpu.js`), but it wants the *logical*
 * output and which screen it serves; this file wants the *socket*, on both
 * sides, because that is the end of a cable that goes somewhere else. It
 * exists for `core/patch.js`, which binds those sockets to ports on an
 * external router.
 *
 * ## The asymmetry that will catch you
 *
 * Inputs and outputs are not keyed the same way, and both spellings appear in
 * the same store. Read off a LivePremier simulator (NLC_CMAX, 6.2.73) over
 * AWJ on 2026-09-21:
 *
 * ```text
 *   inputList/items/IN_5/mapping/pp   {card: "IN_1",  physical: "IN_9", slot: 0}
 *   outputList/items/5/mapping/pp     {card: "OUT_2", physical: "5",    slot: 0, backend: "0"}
 * ```
 *
 * So: **an input's key carries an `IN_` prefix and an output's key does not**,
 * and the same is true of `physical`. Worse, `IN_1` names two different things
 * depending on which field it is in — logical input 1 as a *key*, and the
 * first input *card* under `mapping.card`. Anything that builds a path by
 * interpolating a number is wrong on one side or the other, so nothing here
 * does: keys come from the collection's own `itemKeys` and are used verbatim.
 *
 * The two sides do not even carry the same fields: an output's mapping has
 * `backend` and an input's has `frontend`. And `slot` is the position within a
 * group of four which **repeats within one card** — input card `IN_1` carries
 * IN_1..IN_4 at slots 0-3 and IN_5..IN_8 at slots 0-3 again. So the pair
 * (card, slot) is not unique and must never be used as an identity.
 * `physical` is.
 *
 * ## Why `isValid` is the gate and not `isAvailable`
 *
 * A chassis reports every connector position its model could have, fitted or
 * not; `mapping.pp.isValid` is the device saying a card is actually in that
 * slot. The same trap `core/vpu.js` documents for mixers and `core/screens.js`
 * for layer slots — the store describes the model, and a second field says
 * which of it is real.
 *
 * ## What an operator is looking at
 *
 * They are looking at a silkscreen, so this reports the device's own
 * vocabulary — card, physical connector, plug type — and invents no numbering
 * of its own. "Card 2, port 1" is how people talk, but which connector that is
 * depends on a legend this code cannot see, so the panel shows what the device
 * says and lets the operator match it. Guessing a friendlier name here would
 * be guessing about a cable.
 *
 * ## Platforms
 *
 * Everything above is `nlc-platform`. Midra 4K and Alta 4K carry an
 * `inputList` and an `outputList` too, spelled differently enough that the
 * LivePremier reading of them found nothing at all: inputs are keyed
 * `INPUT_<n>`, outputs `1`..`n` and `MTVW`, and **neither has a
 * `mapping`** — so there is no card, physical number or slot to report, and
 * `isValid` is not the gate; `status/pp/isAvailable` is. What a socket is
 * fitted with and called is therefore asked of the dialect
 * (`dialect.connector`), which says it in that platform's spelling; this file
 * walks the list, keeps the device's keys verbatim and builds the record, and
 * knows neither spelling. A store whose platform cannot be told yet is read as
 * a LivePremier, which is what this file always did.
 *
 * ⚠️ Until 2026-10-06 the Midra half was the LivePremier half, and every
 * Midra and Alta reported no inputs: a HyperDeck could not be linked to one,
 * so its on-air rules never ran.
 */

import { ROOT } from './paths.js';
import { dialectOrDefault } from './dialect.js';

/** The two sides, and the store collection each lives in. */
export const SIDES = {
  input: { collection: 'inputList', label: 'Input' },
  output: { collection: 'outputList', label: 'Output' },
};

export const SIDE_IDS = Object.keys(SIDES);

const collectionPath = (side) => [ROOT, SIDES[side].collection];

/**
 * Every connector on one side of the frame.
 *
 * @param {{get: Function, itemKeys: Function}} store
 * @param {'input'|'output'} side
 * @param {{includeUnfitted?: boolean}} [opts]
 * @returns {Array<{
 *   id: string, side: string, key: string, index: number|null,
 *   card: string|null, physical: string|null, slot: number|null,
 *   device: string|null, plug: string|null, label: string, fitted: boolean
 * }>}
 */
export function readConnectors(store, side, { includeUnfitted = false } = {}) {
  if (!SIDES[side]) throw new TypeError(`unknown connector side: ${side}`);
  const base = collectionPath(side);
  const items = store.get([...base, 'items']);
  if (!items) return [];

  const dialect = dialectOrDefault(store);
  const out = [];
  for (const key of store.itemKeys(base)) {
    const node = items[key];
    if (!node) continue;
    const found = dialect.connector(side, node);
    if (!found.fitted && !includeUnfitted) continue;
    out.push({
      id: `${side}:${key}`,
      side,
      key,
      index: logicalIndex(key),
      card: nullish(found.card),
      physical: nullish(found.physical),
      slot: Number.isInteger(found.slot) ? found.slot : null,
      device: nullish(found.device),
      plug: nullish(found.plug),
      label: String(found.label ?? ''),
      fitted: found.fitted,
    });
  }
  return out;
}

/** Both sides at once, for a panel that draws them together. */
export function readAllConnectors(store, opts) {
  return {
    input: readConnectors(store, 'input', opts),
    output: readConnectors(store, 'output', opts),
  };
}

/**
 * The number a human reads out of a key, in any spelling a switcher uses.
 *
 * `IN_5` (a LivePremier input), `INPUT_5` (a Midra or Alta input) and `5`
 * (an output on either) are all logical connector 5. Returns null rather than
 * a guess for anything else — `MTVW`, or a firmware's next spelling — so
 * it shows as the raw key instead of a wrong number.
 */
export function logicalIndex(key) {
  const match = /^(?:INPUT_|IN_|OUT_)?(\d+)$/.exec(String(key));
  return match ? Number(match[1]) : null;
}

/**
 * How a connector is written where an operator will read it.
 *
 * Deliberately the device's own words. `physical` is included only when it
 * differs from the key, because on outputs they are usually the same number
 * and printing "Output 5 · connector 5" twice reads as a bug.
 */
export function describeConnector(connector) {
  if (!connector) return '—';
  const parts = [`${SIDES[connector.side].label} ${connector.index ?? connector.key}`];
  if (connector.card) parts.push(`card ${connector.card}`);
  if (connector.physical && connector.physical !== connector.key) {
    parts.push(`connector ${connector.physical}`);
  }
  if (connector.plug) parts.push(connector.plug.replace(/_/g, ' ').toLowerCase());
  const described = parts.join(' · ');
  return connector.label ? `${described} — ${connector.label}` : described;
}

/** Index a connector list by `id`, for the many lookups a panel does. */
export function byId(connectors) {
  const map = new Map();
  for (const c of connectors) map.set(c.id, c);
  return map;
}

/** `input:IN_5` -> `{side: 'input', key: 'IN_5'}`, or null. */
export function parseConnectorId(id) {
  const match = /^(input|output):(.+)$/.exec(String(id ?? ''));
  return match ? { side: match[1], key: match[2] } : null;
}

export const connectorId = (side, key) => `${side}:${key}`;

const nullish = (v) => (v === undefined || v === '' ? null : v ?? null);
