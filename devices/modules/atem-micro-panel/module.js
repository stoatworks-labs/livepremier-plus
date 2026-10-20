/*
 * The ATEM Micro Panel, as a device-host module. See `../../README.md` for
 * what a module is; `driver.js` is the panel and `src/core/atem-micro-panel.js`
 * its bytes. ** PREVIEW **: never yet run against a panel.
 */

import { AtemMicroPanelDriver } from './driver.js';

export default {
  id: 'atem-micro-panel',
  name: 'ATEM Micro Panel',
  transport: 'hid',
  create: ({ hid, log }) => new AtemMicroPanelDriver({ hid, log }),
};
