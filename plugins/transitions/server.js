/*
 * Transitions — the plugin's server half: where the styles are kept.
 *
 * Per switcher, like everything else this app keeps, through the same
 * `{ data }` route. A style names effects in the switcher's own words and
 * windows in its own 0–65535, so it means the same thing on any frame of the
 * same platform; a Midra's effects are a subset of a LivePremier's, and a
 * field a switcher does not offer is left out when the style is applied.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* At most 64 styles of a dozen short fields each. */
  documentRoute(ctx, 'transition-styles', { limit: 64 * 1024 });
  documentSection(ctx, 'transition-styles', {
    group: 'show',
    label: 'Transition styles',
    empty: (data) => !data || !Array.isArray(data.styles) || data.styles.length === 0
  });
}
