/* What `devices/host.js --usb <this file>` loads in place of the usb package: the pretend Maschine's screens. */

import { panel } from './fake-maschine-panel.mjs';
import { fakeUsb } from './fake-maschine.js';

const usb = fakeUsb(panel);
export const findByIds = usb.findByIds;
export default usb;
