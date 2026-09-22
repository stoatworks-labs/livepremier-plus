/*
 * Pitch Compensation — the plugin's page half.
 *
 * Under Preconfig because that is literally where the two fields it fills in
 * live — Preconfig > Canvas > Pitch. A panel that computes a number you then
 * type in one flyout over belongs in the same flyout. The engine is vendored
 * (`src/vendor/pitch-engine.js`) and stays there beside its sync script.
 */

import { createPitchPanel } from './panel.js';

export default function activate(ctx) {
  const pitch = createPitchPanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'pitch',
    label: 'Pitch Compensation',
    submenuOf: 'Preconfig',
    /* Before this app's own settings, which close the flyout at 90. */
    order: 80,
    render: () => pitch.render()
  });
}
