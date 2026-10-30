/*
 * A pretend NDI runtime for the media host (`devices/media-host.js --ndi`):
 * `{ lib, reason }` as `devices/media/ndi.js`'s `loadNdi` answers it.
 *
 * Every sender has one receiver, so feeds are drawn. With
 * `LPP_TEST_NDI_OUT` set, each frame sent is noted in that file as JSON —
 * the sender's name, the size, and the colour at the centre and at (8, 8) —
 * so a test in the app's process can see what the host drew.
 */

import { writeFileSync } from 'node:fs';

const out = process.env.LPP_TEST_NDI_OUT || null;
const sent = [];

const pixel = (pic, x, y) => {
  const i = (y * pic.width + x) * 4;
  return [pic.data[i], pic.data[i + 1], pic.data[i + 2]];
};

export default {
  reason: null,
  lib: {
    path: '/pretend/libndi.dylib',
    version: '6.0.0-test',
    create: (name) => ({ name }),
    destroy: () => {},
    fullName: (inst) => `TEST (${inst.name})`,
    connections: () => 1,
    send(inst, pic) {
      sent.push({ name: inst.name, width: pic.width, height: pic.height, centre: pixel(pic, pic.width >> 1, pic.height >> 1), corner: pixel(pic, 8, 8) });
      if (out) writeFileSync(out, JSON.stringify(sent));
    },
  },
};
