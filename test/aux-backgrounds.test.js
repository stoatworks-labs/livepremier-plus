/*
 * Aux backgrounds (experimental): the path it writes and what it offers.
 *
 * The writes themselves are one property each and wait for the echo through
 * `core/wire.js`, which has its own tests; what is pinned here is that the
 * path is the aux's NATIVE source in the buffer asked for, and that the
 * picker offers only stills holding a picture and inputs the vendor's own
 * pickers would — without ever hiding a value already set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { nativePath, choices } from '../plugins/aux-backgrounds/client.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
function merge(a, b) {
  if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
  return out;
}

function store() {
  const extra = {
    device: {
      stillList: {
        itemKeys: ['1', '2'],
        items: {
          1: { control: { pp: { mode: 'IMAGE', source: 1, label: 'Slate' } }, status: { pp: { isAvailable: true, isValid: true } }, mapping: { pp: { isValid: true } } },
          2: { control: { pp: { mode: 'NONE', source: 1, label: '' } }, status: { pp: { isAvailable: true, isValid: false } }, mapping: { pp: { isValid: true } } }
        }
      }
    }
  };
  const s = new DeviceStore();
  s.hydrate(merge(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json'].map(fixture).reduce(merge, {}), extra));
  return s;
}

test('the path is the aux’s NATIVE source in the buffer asked for, and its status beside it', () => {
  assert.deepEqual(nativePath('A6', 'B'),
    ['device', 'auxiliaryList', 'items', 'A6', 'presetList', 'items', 'B', 'layerList', 'items', 'NATIVE', 'source', 'pp', 'inputNum']);
  assert.deepEqual(nativePath('A6', 'A', true).slice(-4), ['source', 'status', 'pp', 'inputNum']);
});

test('it offers none, the stills that hold a picture, and the inputs a layer would be offered — and keeps what is set', () => {
  const s = store();
  const offered = choices(s);
  assert.equal(offered[0].value, 'NONE');
  assert.ok(offered.some((c) => c.value === 'STILL_1' && /Slate/.test(c.label)), 'a still holding an image');
  assert.ok(!offered.some((c) => c.value === 'STILL_2'), 'not an empty one');
  assert.ok(!offered.some((c) => /^SCREEN_/.test(c.value)), 'never a screen');
  const kept = choices(s, ['LIVE_999', 'STILL_1']);
  assert.ok(kept.some((c) => c.value === 'LIVE_999' && /set elsewhere/.test(c.label)), 'a value set elsewhere is shown, not hidden');
  assert.equal(kept.filter((c) => c.value === 'STILL_1').length, 1, 'and nothing twice');
});
