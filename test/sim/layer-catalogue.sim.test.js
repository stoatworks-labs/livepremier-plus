/*
 * Every writable layer property, written once.
 *
 * The Layer tab and the Edit page draw a field for each of the 67 properties
 * in the device's own parameter catalogue (`src/vendor/surface/catalogue.json`,
 * generated from the vendor bundle, never transcribed). A catalogue entry
 * with a wrong path, a wrong type or a range the firmware does not keep is a
 * field that silently does nothing — so this writes a different, valid value
 * to each one on preview layer 1, waits for the switcher to echo it, reads it
 * back over AWJ, and puts the original back before the next.
 *
 * Also the variables the switcher reports (`$S1.width` and the rest of the
 * system index), checked against AWJ, since they are generated from the same
 * store.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

import { SKIP, startApp, Link, awjGet, awjGetAll, settled, guardScreen, deepEqual } from './harness.js';
import { catalogueFor, writeCmd, readValue, bankLetter, paramPath } from '../../src/core/properties.js';
import { systemIndex } from '../../plugins/variables/core.js';

let app;
let link;
let guard;

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    link?.close();
    await app?.close();
  }
});

/** A value that differs from `current` and that the spec allows. */
function another(spec, current) {
  switch (spec.type) {
    case 'bool': return !current;
    case 'enum': {
      const values = spec.values || [];
      const i = values.indexOf(current);
      /* Skip NONE for sources: a layer with no source answers fewer of its
         own properties, and the point is a value the device will keep. */
      for (let k = 1; k < values.length; k++) {
        const v = values[(i + k) % values.length];
        if (v !== current && v !== 'NONE') return v;
      }
      return undefined;
    }
    case 'int':
    case 'number': {
      const hi = Number.isFinite(spec.max) ? spec.max : Infinity;
      const lo = Number.isFinite(spec.min) ? spec.min : -Infinity;
      const base = typeof current === 'number' ? current : (spec.def ?? lo);
      return base + 1 <= hi ? base + 1 : base - 1 >= lo ? base - 1 : undefined;
    }
    case 'map': {
      /* A set of flag names — `[]`, `["FORCE_TRANSITION"]` — drawn from the
         spec's values: add one that is not set, or take one away. */
      if (!Array.isArray(current)) return undefined;
      const off = (spec.values || []).find((v) => !current.includes(v));
      return off !== undefined ? [...current, off] : current.slice(1);
    }
    default: return undefined;
  }
}

test('every writable layer property in the catalogue round-trips through the switcher', { skip: SKIP }, async (t) => {
  await settled(link);
  const letter = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const target = { id: 'S1', bank: letter, layer: '1' };
  const specs = catalogueFor(link.store).layer.filter((s) => !s.readOnly);
  assert.ok(specs.length >= 60, `${specs.length} writable properties in the catalogue`);

  for (const spec of specs) {
    await t.test(spec.id, async () => {
      const path = paramPath(target, spec, link.store);
      assert.ok(path, 'the catalogue gives a path');
      const before = structuredClone(readValue(link.store, target, spec));
      assert.notEqual(before, undefined, 'the switcher reports a value there');

      const want = another(spec, before);
      assert.notEqual(want, undefined, `no other value to try for ${JSON.stringify(before)}`);
      const cmd = writeCmd(target, spec, want, link.store);
      assert.ok(cmd, 'the catalogue builds a write');

      try {
        link.send(cmd);
        const got = await link.waitFor(cmd.path, (v) => deepEqual(v, cmd.value), { timeout: 2500, label: spec.id });
        assert.deepEqual(await awjGet(cmd.path), got, 'AWJ reads what the mirror holds');
      } finally {
        if (!deepEqual(link.get(cmd.path), before)) {
          link.send({ path: cmd.path, value: before });
          await link.waitFor(cmd.path, (v) => deepEqual(v, before), { timeout: 2500 }).catch(() => {});
        }
      }
    });
  }
});

test('the switcher’s own variables read what AWJ reads', { skip: SKIP }, async () => {
  const sys = systemIndex(link.store);
  assert.ok(sys.entries.length > 100, `${sys.entries.length} variables indexed`);

  const pg = bankLetter(link.store, 'S1', 'PROGRAM').letter;
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const L = (letter, ...tail) => ['device', 'screenList', 'items', 'S1', 'presetList', 'items', letter, 'layerList', 'items', '1', ...tail];
  const checks = [
    ['S1.PGM.L1.x', L(pg, 'position', 'pp', 'posH')],
    ['S1.PGM.L1.w', L(pg, 'position', 'pp', 'sizeH')],
    ['S1.PVW.L1.opacity', L(pv, 'opacity', 'pp', 'opacity')],
    ['S1.PVW.L1.y', L(pv, 'position', 'pp', 'posV')]
  ];
  const awj = await awjGetAll(checks.map(([, p]) => p));
  checks.forEach(([name], i) => {
    const r = sys.resolve(name);
    assert.ok(r && r.ok, `${name} resolves: ${JSON.stringify(r)}`);
    assert.equal(r.value, awj[i], name);
  });

  const width = sys.resolve('S1.width');
  assert.ok(width.ok && width.value > 0);
  const rate = sys.resolve('IN1.rate');
  assert.ok(rate.ok, 'an input rate resolves');
});
