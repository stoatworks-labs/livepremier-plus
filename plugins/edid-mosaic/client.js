/*
 * Mosaic inputs — the plugin's page half.
 *
 * No panel of its own: the operator builds the tiles in the EDID editor's
 * Mosaic mode (plugin `edid`), and that editor finds this service at call time
 * with `ctx.use('edid-mosaic')`. Switched off, the service is absent and the
 * editor simply does not offer "Apply to inputs".
 */

import { mosaicTargets, applyMosaic, inspectMosaic, clearMosaic } from './core.js';

export default function activate(ctx) {
  const { session } = ctx;
  ctx.provide('edid-mosaic', {
    /** Where a cols x rows mosaic could start: `{ id, label, members, ok, why? }[]`. */
    targets: (cols, rows) => (session.store.ready ? mosaicTargets(session.store, cols, rows) : []),
    /** Group the run from `firstId` and load each plug's tile. Resolves `{ ok, steps, problems }`. */
    apply: async (firstId, tiles) => {
      const result = await applyMosaic(session, firstId, tiles);
      (result.ok ? ctx.log.info : ctx.log.warn)(`mosaic ${firstId}: ${result.ok ? 'applied' : 'failed'} — ${[...result.steps, ...result.problems].join('; ')}`);
      return result;
    },
    /** What a grouped input's plugs are serving, checked the way a Mac reads them. */
    inspect: (firstId) => inspectMosaic(session.store, firstId),
    /** Back to 1X1 and the switcher's own EDIDs. */
    clear: (firstId) => clearMosaic(session, firstId)
  });
}
