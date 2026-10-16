/*
 * UMD Generator — the plugin's server half: where its settings are kept.
 *
 * Per switcher, like the layer names: box names, label positions and the
 * library slot and still a UMD went into belong to one frame's A1, and the
 * same names pointed at a backup frame's A1 would label the wrong pictures.
 * The picture itself lives on the switcher, in its library.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  documentRoute(ctx, 'umd', { limit: 64 * 1024 });
  documentSection(ctx, 'umd', {
    group: 'show',
    label: 'UMDs',
    empty: (data) => !data || !data.dests || Object.keys(data.dests).length === 0
  });
}
