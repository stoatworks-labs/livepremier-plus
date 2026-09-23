/*
 * Layer names — the plugin's server half: where the names are kept.
 *
 * ⚠️ This route, `/__lpp/layer-names`, is the **only** way anything outside
 * this browser tab can see a layer name, because the switcher has no field for
 * one — see `src/core/layer-names.js`. A Companion module, a second operator's
 * dashboard or a script reads it from here or not at all, and everything that
 * does gains a dependency on this app being up. That is a real cost, chosen
 * deliberately over the alternative, which was for the names not to exist.
 * So the address and the `{ data }` shape are an interface: they did not move
 * when the feature did.
 *
 * Kept per switcher — `S1/2` is a slot in one box's preconfig, and a name
 * written against a four-layer screen means nothing pointed at a frame whose
 * screen 1 has one — in the same `names-<switcher>.json` the app always wrote,
 * which the one-file setup reads too.
 *
 * GET is deliberately unauthenticated like every other route here; the proxy
 * is loopback by default and the note about binding it wider applies to this
 * as much as to the rest.
 */

import { documentRoute } from '../../server/documents.js';

export default function activate(ctx) {
  /* Names are short and there are at most a few hundred layers on a frame. */
  documentRoute(ctx, 'names', { limit: 256 * 1024 });
}
