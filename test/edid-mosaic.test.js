/*
 * Mosaic inputs: target finding, placement, the write sequence, and the
 * Mac's-eye check of what the plugs serve.
 *
 * `sim-6.2.73-inputs-edid.json` is cut down from a running LivePremier
 * simulator 6.2.73. `FakeSwitcher` answers writes the way that simulator did
 * on 2026-09-23 — preconfig group check/apply, GROUPED members, 1920-pixel
 * placement for a 2X1, and plug EDIDs served back exactly as stored — and can
 * reproduce its 2X2 placement collision (IN_18 and IN_20 both at 0,1080).
 * The tiles are Otter's Mosaic-mode output.
 *
 * Run: node --test test/edid-mosaic.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import {
  mosaicTargets, readTile, placeMembers, inspectMosaic, applyMosaic, clearMosaic
} from '../plugins/edid-mosaic/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = (f) => JSON.parse(readFileSync(join(here, 'fixtures', f), 'utf8'));
const TILES = load('otter-mosaic-tiles.json');
const tiles = (name) => TILES[name].map((t) => ({ ...t, bytes: Uint8Array.from(Buffer.from(t.hex, 'hex')) }));

function freshStore() {
  const store = new DeviceStore();
  store.hydrate(load('sim-6.2.73-inputs-edid.json'));
  return store;
}

const INPUTS = ['device', 'inputList', 'items'];
const PRE = ['device', 'preconfig', 'inputs'];

/** Answers writes the way the 6.2.73 simulator did. */
class FakeSwitcher {
  constructor(store, { collide2x2 = false } = {}) {
    this.store = store;
    this.collide2x2 = collide2x2;
    this.sent = [];
    this.pending = {};
    this.defaults = {};
    for (const id of Object.keys(store.get(INPUTS))) {
      const st = store.get([...INPUTS, id, 'plugList', 'items', '1', 'edid', 'status', 'pp']);
      this.defaults[id] = { data: [...st.data], dataSize: st.dataSize };
    }
  }

  send({ path, value }) {
    this.sent.push({ path: path.join('/'), value });
    setTimeout(() => this.echo(path, value), 0);
    return true;
  }

  echo(path, value) {
    const s = this.store;
    s.set(path, value);
    const p = path.join('/');
    const ids = Object.keys(s.get(INPUTS)).sort((a, b) => a.slice(3) - b.slice(3));
    const members = (id, group) => {
      const n = group === '2X2' ? 4 : group === '2X1' ? 2 : 1;
      const i = ids.indexOf(id);
      return ids.slice(i, i + n);
    };
    if (p.endsWith('new/control/pp/xCheck') && value) {
      s.set([...PRE, 'new', 'status', 'pp', 'hasChanged'], true);
    }
    if (p.endsWith('new/control/pp/xApply') && value) {
      for (const id of ids) {
        const g = s.get([...PRE, 'new', 'inputList', 'items', id, 'control', 'pp', 'group']);
        const cur = s.get([...PRE, 'current', 'inputList', 'items', id, 'status', 'pp']);
        if (!g || !cur || cur.global === 'GROUPED' || g === cur.group) continue;
        const before = members(id, cur.group);
        const after = members(id, g);
        for (const m of before) this.place(m, 'USED', 0, 0);
        s.set([...PRE, 'current', 'inputList', 'items', id, 'status', 'pp', 'group'], g);
        after.forEach((m, k) => {
          if (k === 0) return;
          const place = g === '2X1' ? [1920 * k, 0]
            : this.collide2x2 ? [[0, 1080], [1920, 0], [0, 1080]][k - 1]
              : [[0, 1080], [1920, 0], [1920, 1080]][k - 1];
          this.place(m, 'GROUPED', ...place);
        });
      }
      s.set([...PRE, 'new', 'status', 'pp', 'hasChanged'], false);
    }
    const cmd = /inputList\/items\/(IN_\d+)\/plugList\/items\/1\/edid\/cmd\/pp\/(\w+)$/.exec(p);
    if (cmd) {
      const [, id, field] = cmd;
      const status = [...INPUTS, id, 'plugList', 'items', '1', 'edid', 'status', 'pp'];
      if (field === 'xStore' && value) {
        const size = s.get([...INPUTS, id, 'plugList', 'items', '1', 'edid', 'cmd', 'pp', 'dataSize']);
        s.set([...status, 'data'], s.get([...INPUTS, id, 'plugList', 'items', '1', 'edid', 'cmd', 'pp', 'data']));
        s.set([...status, 'dataSize'], size);
      }
      if (field === 'xReset' && value) {
        s.set([...status, 'data'], [...this.defaults[id].data]);
        s.set([...status, 'dataSize'], this.defaults[id].dataSize);
      }
    }
  }

  place(id, global, left, top) {
    this.store.set([...PRE, 'current', 'inputList', 'items', id, 'status', 'pp', 'global'], global);
    this.store.set([...INPUTS, id, 'plugList', 'items', '1', 'status', 'signal', 'pp', 'imagePlugLeft'], left);
    this.store.set([...INPUTS, id, 'plugList', 'items', '1', 'status', 'signal', 'pp', 'imagePlugTop'], top);
  }
}

test('Otter tiles read back as a 2 x 1 grid under one topology id', () => {
  const [l, r] = tiles('3840x1080-2x1').map((t) => readTile(t.bytes));
  assert.deepEqual([l.cols, l.rows, l.col, l.row, l.width, l.height], [2, 1, 0, 0, 1920, 1080]);
  assert.deepEqual([r.col, r.row], [1, 0]);
  assert.equal(l.topologyId, r.topologyId);
  assert.match(l.topologyId, /^53 57 4b/); // "SWK"
});

test('a stock 256-byte EDID has no tile', () => {
  const store = freshStore();
  const bytes = store.get([...INPUTS, 'IN_23', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'data']).slice(0, 256);
  assert.equal(readTile(bytes), null);
});

test('targets: a DP pair on one card is offered, a pair across cards or types is not', () => {
  const store = freshStore();
  const byId = Object.fromEntries(mosaicTargets(store, 2, 1).map((t) => [t.id, t]));
  assert.equal(byId.IN_23.ok, true);
  assert.deepEqual(byId.IN_23.members, ['IN_23', 'IN_24']);
  assert.match(byId.IN_23.label, /DP, card IN_3/);
  // IN_12 is the last HDMI on card IN_2's run, IN_13 is SDI on the same card.
  assert.equal(byId.IN_12.ok, false);
  assert.match(byId.IN_12.why, /connector types|384-byte/);
  // IN_24 is the last input in the fixture — no partner, so no candidate.
  assert.equal(byId.IN_24, undefined);
});

test('targets: a 2 x 2 needs four on one card; 3 x 1 is not a mosaic this app builds', () => {
  const store = freshStore();
  const quad = Object.fromEntries(mosaicTargets(store, 2, 2).map((t) => [t.id, t]));
  assert.equal(quad.IN_17.ok, true);
  assert.deepEqual(quad.IN_17.members, ['IN_17', 'IN_18', 'IN_19', 'IN_20']);
  assert.equal(mosaicTargets(store, 3, 1).every((t) => !t.ok), true);
});

test('apply 2 x 1: groups, places, loads both plugs, and inspects clean', async () => {
  const store = freshStore();
  const sw = new FakeSwitcher(store);
  const session = { store, send: (c) => sw.send(c) };
  const result = await applyMosaic(session, 'IN_23', tiles('3840x1080-2x1'), { timeout: 2000 });
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  // The preconfig sequence, in the Web RCS's order.
  const order = sw.sent.map((s) => s.path.split('/').slice(-1)[0]).filter((x) => ['xCopyFromCurrent', 'group', 'xCheck', 'xApply'].includes(x));
  assert.deepEqual(order, ['xCopyFromCurrent', 'group', 'xCheck', 'xApply']);
  const check = inspectMosaic(store, 'IN_23');
  assert.equal(check.ok, true);
  assert.deepEqual(check.members.map((m) => [m.id, m.size, m.tile.col]), [['IN_23', 384, 0], ['IN_24', 384, 1]]);
  // The IN_23 target is still offered once grouped, so re-applying is allowed.
  assert.equal(mosaicTargets(store, 2, 1).find((t) => t.id === 'IN_23').ok, true);
  // And the partner cannot start a group of its own.
  assert.equal(mosaicTargets(store, 2, 1).find((t) => t.id === 'IN_22').ok, false);
});

test('apply 2 x 2: tiles follow the switcher\'s placement, not input order', async () => {
  const store = freshStore();
  const sw = new FakeSwitcher(store);
  const session = { store, send: (c) => sw.send(c) };
  const result = await applyMosaic(session, 'IN_17', tiles('3840x2160-2x2'), { timeout: 2000 });
  assert.equal(result.ok, true, result.problems.join('; '));
  const at = Object.fromEntries(inspectMosaic(store, 'IN_17').members.map((m) => [m.id, `${m.tile.col},${m.tile.row}`]));
  // IN_18 is placed bottom-left and IN_19 top-right — column-major, as reported.
  assert.deepEqual(at, { IN_17: '0,0', IN_18: '0,1', IN_19: '1,0', IN_20: '1,1' });
});

test('apply 2 x 2 refuses when the switcher places two plugs in one spot', async () => {
  const store = freshStore();
  const sw = new FakeSwitcher(store, { collide2x2: true });
  const session = { store, send: (c) => sw.send(c) };
  const result = await applyMosaic(session, 'IN_17', tiles('3840x2160-2x2'), { timeout: 2000 });
  assert.equal(result.ok, false);
  assert.match(result.problems[0], /same place/);
  // Nothing was written to a plug.
  assert.equal(sw.sent.some((s) => s.path.includes('/edid/cmd/')), false);
});

test('inspect names the failure a Mac would show', () => {
  const store = freshStore();
  const set = (id, bytes) => {
    const st = [...INPUTS, id, 'plugList', 'items', '1', 'edid', 'status', 'pp'];
    store.set([...st, 'data'], [...bytes, ...new Array(512 - bytes.length).fill(0)]);
    store.set([...st, 'dataSize'], String(bytes.length));
  };
  store.set([...PRE, 'current', 'inputList', 'items', 'IN_23', 'status', 'pp', 'group'], '2X1');
  const [l] = tiles('3840x1080-2x1');
  set('IN_23', l.bytes);
  const one = inspectMosaic(store, 'IN_23');
  assert.equal(one.ok, false);
  assert.match(one.problems.join('\n'), /IN_24 serves 256 bytes with no tiled block/);
  set('IN_24', l.bytes); // the same tile twice
  assert.match(inspectMosaic(store, 'IN_23').problems.join('\n'), /same tile/);
});

test('placeMembers: 2 x 1 is input order', () => {
  const store = freshStore();
  assert.deepEqual(placeMembers(store, ['IN_23', 'IN_24'], 2, 1).places.map((p) => [p.id, p.col]), [['IN_23', 0], ['IN_24', 1]]);
});

test('clear puts the group and both plugs back', async () => {
  const store = freshStore();
  const sw = new FakeSwitcher(store);
  const session = { store, send: (c) => sw.send(c) };
  await applyMosaic(session, 'IN_23', tiles('3840x1080-2x1'), { timeout: 2000 });
  await clearMosaic(session, 'IN_23', { timeout: 2000 });
  await new Promise((r) => setTimeout(r, 20));
  const check = inspectMosaic(store, 'IN_23');
  assert.equal(check.group, '1X1');
  assert.equal(store.get([...INPUTS, 'IN_24', 'plugList', 'items', '1', 'edid', 'status', 'pp', 'dataSize']), '256');
});

test('refuses bytes that are not tiles', async () => {
  const store = freshStore();
  const sw = new FakeSwitcher(store);
  const bogus = tiles('3840x1080-2x1').map((t) => ({ ...t, bytes: t.bytes.slice(0, 256) }));
  const result = await applyMosaic({ store, send: (c) => sw.send(c) }, 'IN_23', bogus);
  assert.equal(result.ok, false);
  assert.equal(sw.sent.length, 0);
});
