/*
 * The Maschine MK3, as a device-host module. See `../../README.md` for what a
 * module is; `driver.js` is the panel and `src/core/maschine-mk3.js` its
 * bytes. ** PREVIEW **: never yet run against a panel.
 *
 * Its transport is node-hid, for the keys and lamps; libusb, for the screens,
 * is used when the host has it (`usb`) and missed, not fatal, when it has not.
 */

import { MaschineMk3Driver } from './driver.js';

export default {
  id: 'maschine-mk3',
  name: 'Maschine MK3',
  transport: 'hid',
  create: ({ hid, usb, usbReason, log }) => new MaschineMk3Driver({ hid, usb, usbReason, log }),
};
