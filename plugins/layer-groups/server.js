/*
 * Layer Groups — the plugin's server half: where the groups are kept.
 *
 * On the cue stack's terms and for the same reason: a group names this box's
 * screens and layer slots — `S1/2`, `S2/1` — and means nothing pointed at
 * another one, so the groups are kept per switcher, in the
 * `groups-<switcher>.json` the app always wrote. `/__lpp/groups` and its
 * `{ data }` shape did not move when the feature did (`routeBase` in the
 * manifest keeps them).
 */

import { documentRoute } from '../../server/documents.js';

export default function activate(ctx) {
  /* A group list is a few dozen short rows; a megabyte is already far more
     than any show could need. */
  documentRoute(ctx, 'groups', { limit: 1024 * 1024 });
}
