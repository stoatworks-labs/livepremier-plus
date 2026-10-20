/*
 * What `devices/host.js --ftdi <this file>` loads in place of the FTDI
 * transport: one pretend EC panel that presses ALL TRANS a moment after it is
 * opened, so a test driving the real host process can see a report come back
 * across the IPC channel, and send a command the other way.
 */

import { FakeEcPanel, fakeFtdi } from './fake-ec-panel.js';

const panel = new FakeEcPanel();
const backend = fakeFtdi([panel]);
const open = backend.open;
backend.open = async (entry) => {
  const device = await open(entry);
  setTimeout(() => panel.tap(79), 50).unref?.();
  return device;
};

export default backend;
