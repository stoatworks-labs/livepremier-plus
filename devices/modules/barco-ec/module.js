/*
 * The Barco EC-30 / EC-40 / EC-50 panel, as a device-host module. See
 * `../../README.md` for what a module is; `driver.js` is the panel and
 * `src/core/ec-panel.js` its bytes. ** PREVIEW **: never yet run against a panel.
 */

import { BarcoEcDriver } from './driver.js';

export default {
  id: 'barco-ec',
  name: 'Barco EC-30 / EC-40 / EC-50',
  transport: 'ftdi',
  create: ({ ftdi, ftdiReason, log }) => new BarcoEcDriver({ ftdi, reason: ftdiReason, log }),
};
