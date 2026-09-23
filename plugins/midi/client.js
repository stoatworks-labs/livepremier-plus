/*
 * MIDI Mapping — the plugin's page half.
 *
 * Not in the PLUS section: MIDI mapping belongs beside the vendor's own
 * remote-panel page, because both are about control surfaces. The surface
 * engine is vendored (`src/vendor/surface/`) and stays there with its
 * profiles, which the panel fetches by name.
 */

import { createMidiPanel } from './panel.js';

export default function activate(ctx) {
  const midi = createMidiPanel({ session: ctx.session, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'midi',
    label: 'MIDI Mapping',
    icon: ['gpio-18', 'connector-gpio-18'],
    after: 'Virtual RC400T',
    order: 70,
    render: () => midi.render()
  });
}
