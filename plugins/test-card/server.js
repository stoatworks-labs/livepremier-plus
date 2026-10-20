/*
 * Test Card — the plugin's server half: where its settings are kept.
 *
 * Per switcher, like the UMD Generator's: the pattern and its options, which
 * destinations have a card on, and — the part that matters — the journal of
 * what each card's layer, still and library slot held before, so Off can put
 * it back after a reload or from another browser. The picture itself lives on
 * the switcher, in its library.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  documentRoute(ctx, 'test-card', { limit: 256 * 1024 });
  documentSection(ctx, 'test-card', {
    group: 'show',
    label: 'Test cards',
    empty: (data) => !data || !data.dests || Object.keys(data.dests).length === 0
  });
}
