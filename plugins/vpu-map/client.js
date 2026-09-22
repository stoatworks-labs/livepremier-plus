/*
 * VPU Map — the plugin's page half.
 *
 * A whole-device view, so a sidebar entry of its own rather than a tab on the
 * per-screen strip. It never writes: every property it reads is read-only in
 * the device's own model, and the tool's value on a show floor depends on that
 * staying provably true. `panel.js` has the drawing; the model it draws from is
 * vendored in `src/vendor/vpu-model.js` and adapted in `src/core/vpu.js`, both
 * shared with Pitch Compensation, so they stay where both can reach them.
 *
 * Midra 4K and Alta 4K have no VPU to map — their processing is fixed rather
 * than allocated — so the manifest asks for the `vpuMap` capability and the
 * entry is simply not there on those.
 */

import { createVpuPanel } from './panel.js';

export default function activate(ctx) {
  const vpu = createVpuPanel({ session: ctx.session, platform: ctx.platform, onRefresh: ctx.refresh });
  ctx.ui.sidebar({ id: 'vpu', label: 'VPU Map', icon: 'hardware-18', order: 20, render: () => vpu.render() });
}
