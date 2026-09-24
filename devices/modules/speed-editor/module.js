/*
 * The Speed Editor, as a device-host module. See `../../README.md` for what a
 * module is; `driver.js` is the panel itself.
 */

import { SpeedEditorDriver } from './driver.js';

export default {
  id: 'speed-editor',
  name: 'DaVinci Resolve Speed Editor',
  transport: 'hid',
  create: ({ hid, log }) => new SpeedEditorDriver({ hid, log }),
};
