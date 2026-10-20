/*
 * Aux follow — the plugin's server half: where the follows are kept.
 *
 * Per switcher, like the layer groups: `A1 L1 follows S1 L2` names one box's
 * aux and screen, and pointed at another frame it would cut an aux nobody
 * meant to touch.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* A row per aux layer at most. */
  documentRoute(ctx, 'aux-follow', { limit: 64 * 1024 });
  documentSection(ctx, 'aux-follow', {
    group: 'show',
    label: 'Aux follow',
    empty: (data) => !data || !Array.isArray(data.follows) || data.follows.length === 0
  });
}
