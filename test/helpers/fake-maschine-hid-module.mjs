/* What `devices/host.js --hid <this file>` loads in place of node-hid: the pretend Maschine's controls and lamps. */

import { panel } from './fake-maschine-panel.mjs';
import { fakeMaschineHid } from './fake-maschine.js';

const hid = fakeMaschineHid([panel]);
export const devicesAsync = hid.devicesAsync;
export const HIDAsync = hid.HIDAsync;
export default hid;
