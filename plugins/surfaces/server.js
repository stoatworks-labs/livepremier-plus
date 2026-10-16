/*
 * Surfaces — the plugin's server half: where the surfaces are kept.
 *
 * Per switcher, like the pixel maps and the layer names: `S1` is one box's
 * screen, and the LED elements of one stage pointed at another frame's S1
 * would keep its layers inside walls that are not there.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* A few rectangles and bindings per destination. */
  documentRoute(ctx, 'surfaces', { limit: 64 * 1024 });
  documentSection(ctx, 'surfaces', {
    group: 'show',
    label: 'Surfaces',
    empty: (data) => !data || !data.surfaces || Object.keys(data.surfaces).length === 0
  });
}
