/*
 * The ATEM Micro Panel driver — the panel itself, held by the device host.
 * ** PREVIEW **: never yet run against a panel.
 *
 * The panel is a Blackmagic HID device of the Speed Editor's family, so this
 * is that driver (`../../blackmagic-hid.js`) given the Micro Panel's model:
 * its ids, its handshake on feature report 5, and its battery report. It finds
 * the panel over USB or Bluetooth (the same ids either way), answers its
 * challenge and keeps the answer renewed, and moves bytes — key and T-bar
 * reports out as `report` events, the lamp report in through `write`. The
 * bytes are `src/core/atem-micro-panel.js`.
 *
 * What a key means is the plugin's server half (`plugins/atem-micro-panel/`),
 * which drives the switcher with no page open, as the Barco EC panel does. The
 * host still knows only the panel.
 *
 * ⚠️ ATEM Software Control drives this panel the same way, from the same
 * machine. The panel is opened non-exclusively (it has to be, on macOS, for
 * anyone else to see it), so with both running both act on every press: an
 * ATEM and a LivePremier switching together. Quit ATEM Software Control, or
 * plug the panel into a different computer from it.
 */

import { BlackmagicHidDriver } from '../../blackmagic-hid.js';
import { VENDOR_ID, PRODUCT_ID, REPORT, authenticate, decodeReport } from '../../../src/core/atem-micro-panel.js';

/** The Micro Panel, as `BlackmagicHidDriver` takes a model. */
export const ATEM_MICRO_PANEL = Object.freeze({
  vendorId: VENDOR_ID,
  productId: PRODUCT_ID,
  authenticate,
  /* Only the level is known; whether it is charging has not been seen. */
  battery(bytes) {
    if (bytes[0] !== REPORT.IN_BATTERY) return null;
    const report = decodeReport(bytes);
    return report ? { charging: null, level: report.level } : null;
  },
});

export class AtemMicroPanelDriver extends BlackmagicHidDriver {
  constructor(options = {}) {
    super({ ...options, model: ATEM_MICRO_PANEL });
  }
}
