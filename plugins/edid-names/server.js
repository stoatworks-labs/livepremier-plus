/*
 * Plug names — the plugin's server half: where the short names and the
 * original EDIDs are kept.
 *
 * Per switcher, like the patch: IN_3's short name and the EDID it served
 * before it was named belong to one frame's IN_3, and pointed at a backup
 * frame they would name, and undo, a plug nobody touched. The original is
 * kept here rather than in the page because the switcher keeps no previous
 * EDID and a reload must not lose the way back.
 */

import { documentRoute, documentSection } from '../../server/documents.js';

export default function activate(ctx) {
  /* A short name and two EDIDs of up to 512 numbers per input. */
  documentRoute(ctx, 'plug-names', { limit: 2 * 1024 * 1024 });
  documentSection(ctx, 'plug-names', {
    group: 'rig',
    label: 'Plug names',
    empty: (data) => !data || !data.plugs || Object.keys(data.plugs).length === 0
  });
}
