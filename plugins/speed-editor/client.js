/*
 * Speed Editor — the plugin's page half.
 *
 * Beside MIDI Mapping, under Virtual RC400T, for the same reason: it is a
 * control surface. The protocol and the surface adapter are vendored from
 * awj-surface (`src/vendor/surface/hid/`). The panel itself is held by the
 * server half (`server.js`, `link.js`); this half runs the mapping.
 */

import { createSpeedEditorPanel } from './panel.js';

export default function activate(ctx) {
  const speedEditor = createSpeedEditorPanel({ session: ctx.session, url: ctx.url, onRefresh: ctx.refresh });
  ctx.ui.sidebar({
    id: 'speed-editor',
    label: 'Speed Editor',
    icon: ['gpio-18', 'connector-gpio-18'],
    after: 'Virtual RC400T',
    order: 69,   // anchored entries stack upwards: below MIDI Mapping (70)
    render: () => speedEditor.render()
  });
}
