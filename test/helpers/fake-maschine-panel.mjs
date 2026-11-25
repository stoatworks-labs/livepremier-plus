/*
 * One pretend Maschine MK3 for `devices/host.js` run as a real process:
 * `fake-maschine-hid-module.mjs` is its HID half (`--hid`) and
 * `fake-maschine-usb-module.mjs` its screens (`--usb`). Both import this, and
 * a module is loaded once, so they are one panel. It presses PLAY a moment
 * after it is opened, so a test can see a report cross the IPC channel.
 */

import { FakeMaschine } from './fake-maschine.js';

export const panel = new FakeMaschine();
const opened = panel.opened.bind(panel);
panel.opened = () => {
  opened();
  setTimeout(() => panel.tap('play'), 30);
};
