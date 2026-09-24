/*
 * Audio Matrix — the plugin's page half.
 *
 * A whole-frame view, like Matrix Routing and the VPU map, so a sidebar entry
 * under PLUS rather than a tab beside one screen. It needs nothing from the
 * server: the matrix is in the store and a patch is one socket write, exactly
 * what the Console's `Set Audio Patch …` sends. It pops out (`popout.html`)
 * because a matrix is wide and the Web RCS sidebar is not.
 *
 * LivePremier only: a Midra 4K or Alta 4K has no channel matrix — it routes
 * eight-channel sources to points, which the Console already speaks — so the
 * manifest asks for `audioMatrix`, which only a LivePremier's store answers.
 */

import { createAudioMatrixPanel } from './panel.js';

export default function activate(ctx) {
  const matrix = createAudioMatrixPanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'audio-matrix',
    label: 'Audio Matrix',
    icon: ['audio-18', 'audio-line-18'],
    order: 55,
    render: () => matrix.render()
  });
}
