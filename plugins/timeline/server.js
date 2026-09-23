/*
 * The Timeline — the plugin's server half: where the cue stack is kept.
 *
 * A cue stack is written against one box's screens and presets and means
 * nothing pointed at another, so it is kept per switcher, in the
 * `stack-<switcher>.json` the app always wrote — which the one-file setup
 * reads too. `/__lpp/stack` and its `{ data }` shape did not move when the
 * feature did (`routeBase` in the manifest keeps them).
 */

import { documentRoute, documentSection } from '../../server/documents.js';
import { EMPTY_STACK } from '../../server/config-file.js';

export default function activate(ctx) {
  /* Saves happen on every cue edit; a show is a few hundred cues at most. */
  documentRoute(ctx, 'stack', { limit: 4 * 1024 * 1024 });
  /* And in the one-file setup, under `show`: a show is written against a box. */
  documentSection(ctx, 'stack', { group: 'show', label: 'Cue stack', empty: EMPTY_STACK });
}
