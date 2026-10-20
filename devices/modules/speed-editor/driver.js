/*
 * The Speed Editor driver — the panel itself, held by the device host
 * (`devices/host.js`), a process of its own beside LivePremier Plus.
 *
 * ## Why here, and not WebHID in the page
 *
 * The first build opened the panel from the page over WebHID, and on the
 * first real panel (2026-09-24, USB, Chrome on macOS) it could not get past
 * the handshake. Chrome's `receiveFeatureReport` asks for the *largest*
 * feature report the device declares — 33 bytes, the serial number in report
 * 8 — whatever report it is reading, and the panel refuses a read of any
 * shorter report at that length (`IOHIDDeviceGetReport` 0xE0005000). So the
 * 10-byte challenge in report 6 could never be read, and a page has no way to
 * ask for less. hidapi, which the host uses through node-hid, reads at the length
 * it is told, and the same vendored `authenticate` then passes on the real
 * panel with a 600 s lease.
 *
 * WebHID had a second fault this does not: the panel has no stable
 * identity to Chrome, so every time it re-enumerated the grant was gone and
 * somebody had to choose it again. Here it is found by vendor and product id,
 * on every plug-in.
 *
 * ## What this does, and what it leaves to the page
 *
 * It finds the panel, answers its challenge and keeps the answer renewed, and
 * moves bytes: input reports out as `report` events, output reports (the
 * lamps, the wheel's mode) in through `write`. It decodes nothing but the
 * battery. The mapping — which key does what, pickup, which lamps are lit —
 * is the same Engine the MIDI panel runs, in the page, because that is where
 * the store mirror is and neither this host nor the server has one (see
 * `server/awj.js`). So the panel drives the switcher while a Web RCS page is
 * open with the Speed Editor started, and not otherwise.
 *
 * ## Held only while it is wanted
 *
 * The panel is opened when a page starts the Speed Editor (`want(true)`) and
 * let go when no page is driving it any more. Until then it is only looked
 * for, so the panel shows as found without the host holding it: DaVinci
 * Resolve, or anything else, can have it while nobody here is using it, and
 * an app nobody started never keeps a USB handle — which would also keep
 * Node's event loop alive past a server's close.
 *
 * ## Shared, not seized
 *
 * The device is opened non-exclusively, as it has to be on macOS for anyone
 * else to see it. DaVinci Resolve opening it too would answer the same
 * challenge and hear the same keys, so both apps would act on every press.
 */

/* The protocol is awj-surface's, vendored once for the whole repo; the page's
   adapter reads the same file. */
import { VENDOR_ID, PRODUCT_ID, REPORT, authenticate, decodeReport } from '../../../src/vendor/surface/hid/speed-editor.js';
/* The finding, opening, handshaking and renewing are shared with the ATEM
   Micro Panel since 2026-10-20 — moved there unchanged. */
import { BlackmagicHidDriver } from '../../blackmagic-hid.js';

/** The Speed Editor, as `BlackmagicHidDriver` takes a model. */
export const SPEED_EDITOR = Object.freeze({
  vendorId: VENDOR_ID,
  productId: PRODUCT_ID,
  authenticate,
  /* The one thing decoded here: the page is told the battery. */
  battery(bytes) {
    if (bytes[0] !== REPORT.IN_BATTERY) return null;
    const report = decodeReport(bytes);
    return report ? { charging: report.charging, level: report.level } : null;
  },
});

/**
 * @param hid   node-hid's module: `devicesAsync()` and `HIDAsync.open(path, opts)`
 * @param log   fn(message)
 */
export class SpeedEditorDriver extends BlackmagicHidDriver {
  constructor(options = {}) {
    super({ ...options, model: SPEED_EDITOR });
  }
}
