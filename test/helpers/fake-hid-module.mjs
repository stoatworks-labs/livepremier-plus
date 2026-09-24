/*
 * What `devices/host.js --hid <this file>` loads in place of node-hid: one
 * fake Speed Editor that presses CUT a moment after it is answered, so a test
 * driving the real host process can see a report come back across the IPC
 * channel.
 */

import { FakePanel, fakeHid } from './fake-speed-editor.js';

const hid = fakeHid([new FakePanel({ pressOnAuth: 0x0f })]);
export const devicesAsync = hid.devicesAsync;
export const HIDAsync = hid.HIDAsync;
export default hid;
