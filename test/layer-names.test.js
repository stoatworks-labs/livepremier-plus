/*
 * Layer names.
 *
 * The model is small; what is worth pinning is the handful of decisions that
 * are easy to reverse by accident — that a slot always leads its label, that
 * clearing a name removes the entry rather than storing an empty one, and
 * that looking a name up returns every match rather than the first.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalise, clean, parseKey, nameOf, layerLabel, withName, findByName,
  NAMES_VERSION, MAX_NAME
} from '../src/core/layer-names.js';

test('a stored file is coerced rather than trusted', () => {
  const out = normalise({
    version: 1,
    names: {
      'S1/2': '  Lower   third  ',
      'S1/NATIVE': 'Background plate',
      'A2/1': 'Lobby feed',
      'nonsense': 'dropped',
      'S1/': 'dropped too',
      'S3/1': 42,
      'S4/1': '   '
    }
  });

  assert.equal(out.version, NAMES_VERSION);
  assert.deepEqual(out.names, {
    'S1/2': 'Lower third',
    'S1/NATIVE': 'Background plate',
    'A2/1': 'Lobby feed'
  });
});

test('a bare map is accepted, so a hand-written file needs no wrapper', () => {
  assert.deepEqual(normalise({ 'S1/1': 'IMAG' }).names, { 'S1/1': 'IMAG' });
  assert.deepEqual(normalise(null).names, {});
  assert.deepEqual(normalise('nonsense').names, {});
});

test('a name is one line, trimmed, and bounded', () => {
  /* Names are drawn into single-row table cells and into the vendor's own
     layer list; a newline would break one and be swallowed by the other. */
  assert.equal(clean('Stage\nleft   LED'), 'Stage left LED');
  assert.equal(clean('  x  '), 'x');
  assert.equal(clean('a'.repeat(MAX_NAME + 20)).length, MAX_NAME);
  assert.equal(clean(undefined), '');
});

test('a key is a destination and a layer, or it is nothing', () => {
  assert.deepEqual(parseKey('S1/2'), { id: 'S1', layer: '2' });
  assert.deepEqual(parseKey('A12/NATIVE'), { id: 'A12', layer: 'NATIVE' });
  assert.deepEqual(parseKey('S1/native'), { id: 'S1', layer: 'NATIVE' }, 'case is settled here');
  for (const bad of ['S1', '1/2', 'X1/2', 'S1/', '', null]) assert.equal(parseKey(bad), null);
});

test('the slot leads and the name follows, never the other way round', () => {
  const names = { 'S1/2': 'IMAG', 'S1/NATIVE': 'Plate' };
  /*
   * An operator addresses layer 2 of screen 1 — at the console, in a MIDI
   * mapping, over OSC. A label of "IMAG" alone would have hidden the one part
   * that is also the address.
   */
  assert.equal(layerLabel(names, 'S1', '2'), 'L2 — IMAG');
  assert.equal(layerLabel(names, 'S1', 'NATIVE'), 'NATIVE — Plate');
  assert.equal(layerLabel(names, 'S1', '1'), 'L1', 'an unnamed layer is just its slot');
  assert.equal(layerLabel({}, 'S1', 'NATIVE', { short: true }), 'NAT');
  assert.equal(nameOf(names, 'S1', '2'), 'IMAG');
  assert.equal(nameOf(names, 'S9', '2'), null);
});

test('clearing a name removes it rather than storing a blank', () => {
  let names = withName({}, 'S1', '2', 'IMAG');
  assert.deepEqual(names, { 'S1/2': 'IMAG' });

  /* One representation for "no name", so nothing has to decide whether an
     empty string counts as named. */
  names = withName(names, 'S1', '2', '   ');
  assert.deepEqual(names, {});
  assert.equal(nameOf(names, 'S1', '2'), null);
});

test('withName does not mutate what it was given', () => {
  const before = { 'S1/1': 'A' };
  const after = withName(before, 'S1', '2', 'B');
  assert.deepEqual(before, { 'S1/1': 'A' });
  assert.deepEqual(after, { 'S1/1': 'A', 'S1/2': 'B' });
});

test('a name lookup returns every match, not the first', () => {
  /*
   * ⚠️ Two screens having a layer called IMAG is the *likely* case — it is
   * exactly what a layer group is for. Answering with one would put a source
   * on one screen and look like it had worked.
   */
  const names = { 'S1/2': 'IMAG', 'S2/1': 'imag', 'S3/1': 'Lower third' };
  assert.deepEqual(findByName(names, 'IMAG'), [{ id: 'S1', layer: '2' }, { id: 'S2', layer: '1' }]);
  assert.deepEqual(findByName(names, '  imag  '), [{ id: 'S1', layer: '2' }, { id: 'S2', layer: '1' }],
    'typed at a console, so case and spacing cannot matter');
  assert.deepEqual(findByName(names, 'IMAG', { id: 'S2' }), [{ id: 'S2', layer: '1' }]);
  assert.deepEqual(findByName(names, 'nothing'), []);
  assert.deepEqual(findByName(names, ''), []);
});

test('matches come back in a stable, human order', () => {
  const names = { 'S10/1': 'IMAG', 'S2/1': 'IMAG', 'S2/10': 'IMAG', 'S2/2': 'IMAG' };
  assert.deepEqual(findByName(names, 'IMAG').map((m) => `${m.id}/${m.layer}`),
    ['S2/1', 'S2/2', 'S2/10', 'S10/1'], 'numeric, so S10 sorts after S2 and L10 after L2');
});
