/*
 * Pixel Map — the plugin's server half: where the maps are kept.
 *
 * Per switcher, like the layer names and for the same reason: `S1` is one
 * box's screen, and a map of one LED wall pointed at another frame's S1 would
 * be a confident picture of the wrong stage. It names library slots, not
 * files — the picture itself stays on the switcher, where it already is.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* A handful of fields per destination, and at most a few dozen destinations. */
  documentRoute(ctx, 'pixel-maps', { limit: 64 * 1024 });
  documentSection(ctx, 'pixel-maps', {
    group: 'show',
    label: 'Pixel maps',
    empty: (data) => !data || !data.maps || Object.keys(data.maps).length === 0
  });
}
