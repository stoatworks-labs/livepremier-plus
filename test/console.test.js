/*
 * The Console, typed at rather than rendered.
 *
 * What a line becomes on the wire depends on two things the panel supplies
 * the compiler — the preset buffer a mode names right now and the screen's
 * canvas — and on nothing else that needs a DOM. So these tests build the
 * panel over a real store capture with a fake session, set the line, call
 * `execute`, and read what was sent. The `Set` family is the point: until
 * 0.6.1 the panel handed mynah only the OSC dialect's `buffer` callback and
 * nothing under `facts`, and every mynah `Set` typed at it was refused with
 * "needs a live connection" beside a live connection. Nothing here rendered
 * that, because nothing here typed at it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { createConsolePanel } from '../src/ui/console-panel.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
const hydrated = (name) => { const s = new DeviceStore(); s.hydrate(fixture(name)); return s; };

/** A panel over a store, with a session that records instead of sending. */
function consoleOver(store) {
  const sent = [];
  const session = { store, state: 'live', send: (msg) => { sent.push(msg); return true; } };
  const panel = createConsolePanel({ session, onRefresh: () => {}, popoutEnabled: false });
  const type = (line) => { panel.state.line = line; panel.execute(); return panel.state.log[0]; };
  return { sent, type, panel };
}

const path = (msg) => msg.path.join('/');

test('the panel hands the compiler both facts: the buffer a mode names, and the canvas', () => {
  const { panel } = consoleOver(hydrated('midra-3.2.29-pulse4k.json'));
  const ctx = panel.runContext();
  assert.equal(typeof ctx.facts.buffer, 'function');
  assert.equal(typeof ctx.facts.canvas, 'function');
  /* Screen 1 is AT_UP in the capture: program UP, preview DOWN. */
  assert.equal(ctx.facts.buffer({ kind: 'screen', n: 1 }, 'PREVIEW'), 'DOWN');
  assert.equal(ctx.facts.buffer({ kind: 'screen', n: 1 }, 'PROGRAM'), 'UP');
  assert.deepEqual(ctx.facts.canvas({ kind: 'screen', n: 1 }), { w: 1920, h: 1080 });
  /* The OSC dialect's own callback is still there, and agrees. */
  assert.equal(ctx.osc.buffer({ kind: 'screen', n: 1 }, 'PREVIEW'), 'DOWN');
});

test('a layer Set typed at the Console writes the preview buffer on a Midra', () => {
  const { sent, type } = consoleOver(hydrated('midra-3.2.29-pulse4k.json'));
  const row = type('Set Screen 1 Layer 1 Opacity 128');
  assert.equal(row.kind, 'ok', row.detail);
  assert.match(row.detail, /1\/1 write sent/);
  assert.equal(sent.length, 1);
  assert.equal(path(sent[0]), 'device/screenList/items/1/presetList/items/DOWN/liveLayerList/items/1/opacity/pp/opacity');
  assert.equal(sent[0].value, 128);
  /* Program, when said. */
  type('Set Screen 1 Layer 1 Opacity 200 Program');
  assert.equal(path(sent[1]), 'device/screenList/items/1/presetList/items/UP/liveLayerList/items/1/opacity/pp/opacity');
  /* A percentage needs the canvas, which is the second fact. */
  const size = type('Set Screen 1 Layer 1 Size 50%');
  assert.equal(size.kind, 'ok', size.detail);
  assert.equal(sent[2].value, 960);
});

test('a layer Set typed at the Console writes the preview buffer on a LivePremier', () => {
  const { sent, type } = consoleOver(hydrated('aquilon-6.2.73-memories.json'));
  const row = type('Set Screen 1 Layer 1 Opacity 128');
  assert.equal(row.kind, 'ok', row.detail);
  assert.equal(sent.length, 1);
  /* `layerList` here, `liveLayerList` on a Midra — the dialect's business, not the Console's. */
  assert.match(path(sent[0]), /^device\/screenList\/items\/S1\/presetList\/items\/[ABC]\/layerList\/items\/1\/opacity\/pp\/opacity$/);
  assert.equal(sent[0].value, 128);
});

test('the audio layer and the routing points, typed at the Console on a Midra', () => {
  const { sent, type } = consoleOver(hydrated('midra-3.2.29-pulse4k.json'));
  assert.equal(type('Set Audio Patch Input 3 To Screen 1').kind, 'ok');
  assert.equal(path(sent[0]), 'device/screenList/items/1/presetList/items/DOWN/audio/control/pp/source');
  assert.equal(sent[0].value, 'IN3');
  assert.match(type('Set Audio Patch Input 4 To Output 1').detail, /2\/2 writes sent/);
  assert.deepEqual(sent.slice(1).map(path), [
    'device/outputList/items/1/audio/control/pp/mode',
    'device/outputList/items/1/audio/control/directRouting/pp/source'
  ]);
  assert.equal(type('Set Audio Mute Screen 1').kind, 'ok');
  assert.equal(path(sent[3]), 'device/audio/screenList/items/1/control/pp/mute');
});

test('a refusal is a log row, not a write', () => {
  const { sent, type } = consoleOver(hydrated('midra-3.2.29-pulse4k.json'));
  const row = type('Take Screen 7');
  assert.equal(row.kind, 'error');
  assert.match(row.detail, /1 to 4/);
  assert.equal(sent.length, 0);
});

test('before the store has arrived, a Set is refused for the right reason', () => {
  const { sent, type } = consoleOver(new DeviceStore());
  const row = type('Set Screen 1 Layer 1 Opacity 128');
  assert.equal(row.kind, 'error');
  assert.match(row.detail, /take state/);
  assert.equal(sent.length, 0);
});
