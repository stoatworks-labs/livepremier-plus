/*
 * X-keys, as a device-host module. See `../../README.md` for what a module is;
 * `driver.js` is the panel and `src/core/xkeys.js` its bytes. ** PREVIEW **:
 * never yet run against a panel.
 */

import { XKeysDriver } from './driver.js';

export default {
  id: 'xkeys',
  name: 'X-keys',
  transport: 'hid',
  create: ({ hid, log }) => new XKeysDriver({ hid, log }),
};
