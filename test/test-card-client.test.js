/*
 * Test Card's page half end to end, against a stand-in switcher: the queue,
 * the document on disk, the journal, Off, program, the follower, and the
 * failures the first review found (2026-10-20) — a put that fails half way,
 * an Off that fails, a take during the upload, two pages on one switcher.
 *
 * The switcher is `umd.test.js`'s stand-in (every write echoed inbound a
 * millisecond later, an upload validates its slot), over a LivePremier-shaped
 * store: S1, 3840 × 1080, Out 1 and Out 2 side by side, L1 DUAL and L2 4K,
 * stills 46 (4K), 47 and 48, library slots 199 and 200 empty. Program is A,
 * preview B. Pictures are drawn into a recording context; the PNG is four
 * bytes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DeviceStore } from '../src/core/device-store.js';
import { same } from '../src/core/wire.js';
import { install } from './helpers/fake-dom.js';

const KEYS = ['1', '2'];

function layerNode({ source = 'NONE', left = 0, top = 0, width = 1920, height = 1080 } = {}) {
  return {
    source: { pp: { inputNum: source }, status: { pp: { inputNum: source } } },
    position: { pp: { anchor: 'MIDDLE_CENTER', posH: left + width / 2, posV: top + height / 2, sizeH: width, sizeV: height } },
    opacity: { pp: { opacity: 256 } },
    effects: { pp: { flags: [] } },
    cropping: { classic: { pp: { top: 0, bottom: 0, left: 0, right: 0, aspectOverride: 'NONE' } }, mask: { pp: { top: 0, bottom: 0, left: 0, right: 0 } } }
  };
}

function outputNode(left) {
  return {
    mapping: { pp: { device: '1', isValid: true } },
    control: { pp: { label: '' } },
    status: { pp: { format: 'HDTV_1080P', rate: 60000, sizeH: 1920, sizeV: 1080 } },
    plugList: { itemKeys: ['1'], items: { 1: { status: { pp: { type: 'HDMI' } } } } },
    canvas: {
      cmd: { pp: { pitchRatioH: 1000, pitchRatioV: 1000, rotation: 'NONE' } },
      status: {
        pp: { isEnabled: 'USED', usedInScreenAux: 'S1', group: '1X1', capability: 'DUAL', rotation: 'NONE', left, top: 0, pitchedWidth: 1920, pitchedHeight: 1080, maxWidth: 1920, maxHeight: 1080 },
        slices: { pp: { mode: 'FREE', count: 1 }, boundingBox: { pp: { left: 0, top: 0, width: 1920, height: 1080 } }, sliceList: { itemKeys: ['1'], items: { 1: { pp: { top: 0, left: 0 }, aoi: { pp: { top: 0, left: 0, width: 1920, height: 1080 } } } } } }
      }
    }
  };
}

function still(capability = 'DUAL') {
  return {
    control: { pp: { label: '', mode: 'NONE', source: 1, rescale: 'SCALE_TO_CAPABILITY' } },
    status: { pp: { isAvailable: true, isEnabled: true, isValid: false, isUsed: false, capability, isOnProgram: false, isOnPreview: false } },
    mapping: { pp: { isValid: true } }
  };
}

function switcherStore() {
  const s = new DeviceStore();
  const preset = () => ({ layerList: { itemKeys: ['NATIVE', ...KEYS], items: { NATIVE: layerNode(), 1: layerNode({ source: 'LIVE_1', width: 960, height: 540 }), 2: layerNode() } } });
  s.hydrate({
    device: {
      screenAuxGroupList: { itemKeys: ['S1'], items: { S1: { control: { pp: { presetUp: 'B', presetDown: 'A' } }, status: { pp: { isUsed: true, transition: 'AT_DOWN', take: 'OFF' } } } } },
      screenList: {
        itemKeys: ['S1'],
        items: {
          S1: {
            control: { pp: { label: '' } },
            status: { pp: { mode: 'FREESTYLE' }, size: { pp: { sizeH: 3840, sizeV: 1080 } } },
            layerList: { itemKeys: ['NATIVE', ...KEYS], items: { NATIVE: { status: { pp: { capability: 'OFF' } } }, 1: { status: { pp: { capability: 'DUAL' } } }, 2: { status: { pp: { capability: '4K' } } } } },
            presetList: { itemKeys: ['A', 'B'], items: { A: preset(), B: preset() } }
          }
        }
      },
      outputList: { itemKeys: ['1', '2'], items: { 1: outputNode(0), 2: outputNode(1920) } },
      stillList: {
        itemKeys: ['46', '47', '48'],
        items: { 46: still('4K'), 47: still(), 48: still() },
        library: { bankList: { itemKeys: ['199', '200'], items: { 199: { status: { pp: { isValid: false } } }, 200: { status: { pp: { isValid: false } } } } } }
      },
      preconfig: { stills: { current: { stillList: { items: Object.fromEntries(['46', '47', '48'].map((k) => [k, { status: { pp: { global: 'USED', capability: k === '46' ? '4K' : 'DUAL' } } }])) } } } }
    }
  });
  return s;
}

/** The switcher, `umd.test.js`'s stand-in; `drop(path)` true swallows a write as a switcher that refused it would. */
function standIn(store) {
  const session = new EventTarget();
  session.store = store;
  const log = [];
  const sw = { drop: () => false, onUpload: () => {} };
  const report = (path, value) => {
    const changed = !same(store.get(path), value);
    store.set(path, value);
    if (changed) session.dispatchEvent(new CustomEvent('frame', { detail: { path, value, dir: 'in' } }));
  };
  session.send = ({ path, value }) => {
    log.push([path.join('/'), value]);
    if (sw.drop(path.join('/'), value)) return true;
    setTimeout(() => {
      report(path, value);
      const p = path.join('/');
      if (/library\/bankList\/items\/\d+\/control\/pp\/xDelete$/.test(p) && value === true) report([...path.slice(0, -3), 'status', 'pp', 'isValid'], false);
    }, 1);
    return true;
  };
  return { session, log, sw, report };
}

/** The app's document route and the switcher's upload route, as one `fetch`. */
function network(sw, report) {
  const disk = { data: null, puts: 0 };
  const uploads = [];
  let hash = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('/__lpp/test-card')) {
      if (init.method === 'PUT') {
        disk.data = JSON.parse(init.body).data;
        disk.puts += 1;
        return { ok: true, status: 200, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => ({ data: disk.data }) };
    }
    const slot = Number(init.body.get('librarySlot'));
    const file = init.body.get('FILES');
    uploads.push([slot, file.name]);
    const base = ['device', 'stillList', 'library', 'bankList', 'items', String(slot), 'status', 'pp'];
    sw.onUpload(slot);
    setTimeout(() => {
      report([...base, 'isValid'], true);
      report([...base, 'fileName'], file.name);
      report([...base, 'hashName'], `h${++hash}`);
    }, 2);
    return { ok: true, status: 200, json: async () => ({ [file.name]: 'FINISH' }), text: async () => '' };
  };
  return { disk, uploads, fetchImpl };
}

class FakeOffscreen {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() {
    const state = { fillStyle: '#000', font: '10px sans-serif' };
    return new Proxy(state, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
        if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(0, w * h * 4)), width: w, height: h });
        return () => {};
      },
      set(t, k, v) { t[k] = v; return true; }
    });
  }
  async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }); }
}

/** A switcher, a disk, and as many pages on it as asked for. */
async function rig(pages = 1) {
  const dom = install();
  const fetchBefore = globalThis.fetch;
  const offBefore = globalThis.OffscreenCanvas;
  const store = switcherStore();
  const { session, log, sw, report } = standIn(store);
  const net = network(sw, report);
  globalThis.fetch = net.fetchImpl;
  globalThis.OffscreenCanvas = FakeOffscreen;
  const { createTestCard } = await import('../plugins/test-card/client.js');
  const ctx = { session, url: (p = '/') => `/__lpp/test-card${p === '/' ? '' : p}`, can: () => true, use: () => null, log: { info() {}, warn() {} } };
  const cards = [];
  for (let i = 0; i < pages; i++) {
    const tc = createTestCard(ctx, { tab: false });
    await tc.loaded;
    cards.push(tc);
  }
  const done = () => {
    globalThis.fetch = fetchBefore;
    if (offBefore === undefined) delete globalThis.OffscreenCanvas; else globalThis.OffscreenCanvas = offBefore;
    dom.uninstall();
  };
  return { store, session, log, sw, net, cards, tc: cards[0], done };
}

const at = (store, ...p) => store.get(['device', ...p]);
const layer = (store, b, k = '2') => at(store, 'screenList', 'items', 'S1', 'presetList', 'items', b, 'layerList', 'items', k);
const settle = (tc) => tc.idle().then(() => new Promise((r) => setTimeout(r, 5))).then(() => tc.idle());

test('Enable on an output: its card on S1’s top layer in preview, at that output’s footprint, with the journal on disk; Off puts it all back', async () => {
  const r = await rig();
  try {
    const { store, tc, net } = r;
    tc.render({ kind: 'output', key: '2' });
    await tc.actions.setOn(true);
    await settle(tc);
    assert.equal(tc.run().error, null, tc.run().steps.map((s) => s.text).join(' | '));
    const b = layer(store, 'B');
    assert.equal(b.source.pp.inputNum, 'STILL_48');
    assert.deepEqual(b.position.pp, { anchor: 'MIDDLE_CENTER', posH: 2880, posV: 540, sizeH: 1920, sizeV: 1080 });
    assert.equal(layer(store, 'A').source.pp.inputNum, 'NONE', 'program is not touched');
    assert.deepEqual(net.uploads, [[200, 'testcard-S1.png']]);
    const e = net.disk.data.dests.S1;
    assert.deepEqual([e.mode, e.outputs, e.placed.letter, e.placed.still, e.placed.slot], ['outputs', ['2'], 'B', 48, 200]);
    assert.equal(e.journal.writes.find((w) => w.path.at(-1) === 'inputNum').value, 'NONE', 'what the layer held before');

    await tc.actions.setOn(false);
    await settle(tc);
    assert.equal(layer(store, 'B').source.pp.inputNum, 'NONE');
    assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'mode'), 'NONE');
    assert.equal(at(store, 'stillList', 'library', 'bankList', 'items', '200', 'status', 'pp', 'isValid'), false);
    assert.equal(net.disk.data.dests.S1, undefined);
  } finally { r.done(); }
});

test('a put whose layer write is refused shows as on, with its journal on disk, and Off takes back the still and the slot', async () => {
  const r = await rig();
  try {
    const { store, tc, net, sw } = r;
    sw.drop = (p) => /presetList\/items\/B\/layerList\/items\/2\/source/.test(p);
    tc.render({ kind: 'output', key: '1' });
    await tc.actions.setOn(true);
    await settle(tc);
    assert.match(tc.run().error || '', /did not take still 48/);
    const e = net.disk.data.dests.S1;
    assert.equal(e.mode, 'outputs', 'still on, so Off is there');
    assert.equal(e.placed, null);
    assert.deepEqual([e.journal.uploads, e.journal.stills.map((s) => s.still)], [[200], ['48']]);
    assert.ok(e.journal.writes.length, 'the layer’s "before" went to disk before the write did');
    assert.match(tc.model({ kind: 'output', key: '1' }).where.text, /did not finish/);

    sw.drop = () => false;
    await tc.actions.setOn(false);
    await settle(tc);
    assert.equal(tc.run().error, null, tc.run().steps.map((s) => s.text).join(' | '));
    assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'mode'), 'NONE');
    assert.equal(at(store, 'stillList', 'library', 'bankList', 'items', '200', 'status', 'pp', 'isValid'), false);
    assert.equal(net.disk.data.dests.S1, undefined);
  } finally { r.done(); }
});

test('an Off that does not all go back stays on, with its journal, and Off again finishes it', async () => {
  const r = await rig();
  try {
    const { store, tc, net, sw } = r;
    tc.render({ kind: 'output', key: '1' });
    await tc.actions.setOn(true);
    await settle(tc);
    sw.drop = (p, v) => /stillList\/items\/48\/control\/pp\/mode$/.test(p) && v === 'NONE';
    await tc.actions.setOn(false);
    await settle(tc);
    assert.match(tc.run().error || '', /press Off again/);
    assert.equal(net.disk.data.dests.S1.mode, 'outputs');
    assert.ok(net.disk.data.dests.S1.journal);
    assert.equal(tc.model({ kind: 'output', key: '1' }).on, true, 'the switch still reads on, so it can be pressed');

    sw.drop = () => false;
    await tc.actions.setOn(false);
    await settle(tc);
    if (process.env.TC_DEBUG) console.log(tc.run().steps.map((s) => s.state + ' ' + s.text).join('\n'));
    assert.equal(tc.run().error, null, tc.run().steps.map((s) => s.text).join(' | '));
    assert.equal(at(store, 'stillList', 'items', '48', 'control', 'pp', 'mode'), 'NONE');
    assert.equal(net.disk.data.dests.S1, undefined);
  } finally { r.done(); }
});

test('program: Enable asks first and writes nothing until confirmed; a take during the upload does not put the card on program', async () => {
  const r = await rig();
  try {
    const { store, tc, log, sw, report } = { ...r, report: (p, v) => r.store.set(p, v) };
    tc.render({ kind: 'output', key: '1' });
    tc.actions.setProgram(true);
    await tc.actions.setOn(true);
    assert.equal(tc.model({ kind: 'output', key: '1' }).confirming, true);
    assert.equal(log.length, 0, 'nothing written before Confirm');
    tc.actions.cancel();
    tc.actions.setProgram(false);

    /* Preview, but the T-bar lands mid-upload: B is program by the layer write. */
    sw.onUpload = () => { report(['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'], 'AT_UP'); };
    await tc.actions.setOn(true);
    await settle(tc);
    assert.equal(layer(store, 'B').source.pp.inputNum, 'NONE', 'B became program during the upload, and was left alone');
    assert.equal(layer(store, 'A').source.pp.inputNum, 'STILL_48', 'the card went to what was preview by then');
  } finally { r.done(); }
});

test('the follower: a new pattern is one more upload into the same slot, and nothing is written to the still', async () => {
  const r = await rig();
  try {
    const { tc, net, log } = r;
    tc.render({ kind: 'output', key: '1' });
    await tc.actions.setOn(true);
    await settle(tc);
    log.length = 0;
    await tc.actions.pickKind('grid');
    await new Promise((res) => setTimeout(res, 700));
    await settle(tc);
    assert.deepEqual(net.uploads.map((u) => u[0]), [200, 200]);
    assert.ok(!log.some(([p]) => p.includes('stillList/items/48')), 'the still follows the file by itself');
    assert.equal(net.disk.data.settings.kind, 'grid');
    assert.equal(net.disk.data.dests.S1.journal.writes.find((w) => w.path.at(-1) === 'inputNum').value, 'NONE', 'the journal still holds the first "before"');
  } finally { r.done(); }
});

test('two pages on one switcher: an option changed on a page loaded earlier does not lose the other page’s card', async () => {
  const r = await rig(2);
  try {
    const [a, b] = r.cards;
    a.render({ kind: 'output', key: '1' });
    await a.actions.setOn(true);
    await settle(a);
    assert.ok(r.net.disk.data.dests.S1.placed);
    b.render({ kind: 'output', key: '2' });
    await b.actions.setOption('levels', 'legal');
    await settle(b);
    assert.equal(r.net.disk.data.settings.levels, 'legal');
    assert.ok(r.net.disk.data.dests.S1.placed, 'page A’s placement survived page B’s save');
    assert.ok(r.net.disk.data.dests.S1.journal);
  } finally { r.done(); }
});

test('Take everything off: a card for another output can be taken down from any page of its destination', async () => {
  const r = await rig();
  try {
    const { store, tc, net } = r;
    tc.render({ kind: 'output', key: '1' });
    await tc.actions.setOn(true);
    await settle(tc);
    tc.render({ kind: 'canvas', id: 'S1' });
    assert.equal(tc.model({ kind: 'canvas', id: 'S1' }).elsewhere, true);
    await tc.actions.allOff();
    await settle(tc);
    assert.equal(layer(store, 'B').source.pp.inputNum, 'NONE');
    assert.equal(net.disk.data.dests.S1, undefined);
  } finally { r.done(); }
});

test('the panel draws for an output and for the canvas', async () => {
  const r = await rig();
  try {
    const out = r.tc.render({ kind: 'output', key: '1' });
    assert.match(out.textContent, /Test Card/);
    assert.equal(out.querySelectorAll('.lpp-tc-tile').length, 16);
    assert.match(out.textContent, /Enable puts the card on S1’s preview/);
    const canvas = r.tc.render({ kind: 'canvas', id: 'S1' });
    assert.match(canvas.textContent, /Per output/);
    assert.match(canvas.textContent, /L2 \(4K\)/);
    assert.match(r.tc.render({ kind: 'canvas', id: null }).textContent, /Choose a screen or an aux/);
  } finally { r.done(); }
});
