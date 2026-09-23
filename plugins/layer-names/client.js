/*
 * Layer names — the plugin's page half.
 *
 * A flat `{ 'S1/2': 'IMAG' }` map, held here once and offered to the rest of
 * the page as the **`names` service** — `ctx.use('names')` — because several
 * surfaces read it: the Layer tab that edits it, the Edit page, the groups
 * panel, the `…` menu on source cards, and `labels.js` writing into the
 * vendor's own lists. A copy per surface is a copy that goes stale the moment
 * somebody renames. See `src/core/layer-names.js` for why the device cannot
 * hold these itself.
 *
 * Switched off, nobody provides `names`: every surface shows plain layer
 * numbers and the Layer tab offers no rename field.
 */

import { normalise, withName } from '../../src/core/layer-names.js';
import { installLayerLabels } from './labels.js';

export default function activate(ctx) {
  let names = {};

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) names = normalise((await res.json()).data).names;
    } catch (err) {
      ctx.log.warn('could not load the layer names', err);
    }
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { version: 1, names } })
      });
    } catch (err) {
      /* A failed save must not interrupt an operator mid-show. The name stands
         on this page, and the next rename retries. */
      ctx.log.warn('could not save the layer names', err);
    }
  }

  /*
   * Names into the vendor's own layer lists. ⚠️ The most fragile thing in the
   * app — it writes into the middle of Web RCS's own markup — and the only way
   * a name appears anywhere an operator is already looking. `labels.js` says
   * what it matches, and `describe()` reports what it is labelling, so a
   * firmware that moves a list shows up as a number rather than as silence.
   */
  const labels = installLayerLabels({ names: () => names, enabled: () => ctx.can('layerGroups') });

  ctx.provide('names', Object.freeze({
    /** The whole map, `{ 'S1/2': 'IMAG' }`. Read it per render; it changes. */
    get: () => names,
    /** Name a layer, or clear its name with an empty value. Saved at once. */
    rename(id, layer, value) {
      names = withName(names, id, layer, value);
      void save();
      labels.refresh();
      ctx.refresh();
    },
    /** What the vendor-page labels found — for a firmware that moved a list. */
    describe: () => labels.describe()
  }));

  void load().then(() => { labels.refresh(); ctx.refresh(); });
}
