/*
 * A lighting desk driving the switcher (`plugins/desk-control/`): the packets,
 * which desk is in control, what the channels ask for, the fixture files, and
 * the supervisor end to end — real UDP on loopback, a pretend switcher on AWJ.
 * The live checks (the simulator, MagicQ on this Mac) are in
 * docs/DESK-CONTROL.md's status block.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';

import {
  OP, parseArtnet, buildArtDmx, buildArtPoll, buildArtTimeCode, buildPollReplies, parsePollReply,
  splitPortAddress, formatPortAddress, STYLE_MEDIA,
} from '../src/core/artnet.js';
import { parseSacn, buildSacnData, outOfOrder, multicastGroup, OPTION_PREVIEW, OPTION_TERMINATED } from '../src/core/sacn.js';
import { DmxInput, SACN_LOSS_MS, ARTNET_LOSS_MS, MAX_SOURCES } from '../src/core/dmx-input.js';
import {
  layout, patchCsv, DeskEngine, CONTROL, readFixture, sourceOf, sourceValue, opacityOf, footprint, layerLook, CENTRE,
  strobeFrames, shadowOffset, MODES,
} from '../src/core/dmx-personality.js';
import { descriptionXml, gdtfFile, gdtfName, FIXTURE_KINDS } from '../src/core/desk-gdtf.js';
import { unzipStore } from '../src/core/zip.js';
import { sceneXml, mvrFile, fixtureNumber, stableUuid, absoluteAddress } from '../src/core/desk-mvr.js';
import { normaliseDesk, deskChanged, DEFAULT_DESK, allowed, lookParams, fitValue, layerSpec } from '../plugins/desk-control/core.js';
import { DeskSupervisor } from '../plugins/desk-control/supervisor.js';
import { TakeWatch, matchRules, describeTake, COOLDOWN_MS } from '../plugins/desk-control/feedback.js';
import { AwjLink } from '../server/awj-link.js';
import { NLC, MNG } from '../src/core/dialect.js';
import { commandsFor } from '../src/core/commands.js';
import { toAwj } from '../src/core/paths.js';
import { fakeAwj } from './helpers/fake-awj.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 2000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/* ------------------------------------------------------------- Art-Net */

test('Art-Net: an ArtDmx round-trips, with its 15-bit Port-Address', () => {
  const data = Uint8Array.from({ length: 512 }, (_, i) => i & 0xff);
  const p = parseArtnet(buildArtDmx(0x1234 & 0x7fff, data, { sequence: 7, physical: 2 }));
  assert.equal(p.op, OP.DMX);
  assert.equal(p.portAddress, 0x1234);
  assert.equal(p.sequence, 7);
  assert.equal(p.physical, 2);
  assert.deepEqual([...p.data.subarray(0, 4)], [0, 1, 2, 3]);
  assert.deepEqual(splitPortAddress(0x1234), { net: 0x12, subNet: 0x3, universe: 0x4 });
  assert.equal(formatPortAddress(0x1234), '18:3:4');
  assert.equal(parseArtnet(Buffer.from('not art-net at all')), null);
});

test('Art-Net: ArtPoll and ArtTimeCode are read', () => {
  assert.equal(parseArtnet(buildArtPoll()).op, OP.POLL);
  const tc = parseArtnet(buildArtTimeCode({ hours: 1, minutes: 2, seconds: 3, frames: 4, type: 1 }));
  assert.equal(tc.op, OP.TIMECODE);
  assert.deepEqual([tc.hours, tc.minutes, tc.seconds, tc.frames, tc.rate, tc.dropFrame], [1, 2, 3, 4, 25, false]);
});

test('Art-Net: ArtPollReply says media server, four ports a reply, and which universes have a desk', () => {
  const replies = buildPollReplies({
    ip: [2, 0, 0, 10], universes: [0, 1, 2, 3, 4, 17], shortName: 'LivePremier Plus', longName: 'x', active: new Set([1]),
  });
  /* 0–3 share a reply; 4 is in the same sixteen but the fifth port; 17 is another sub-net. */
  assert.equal(replies.length, 3);
  for (const b of replies) assert.equal(b.length, 239);
  const first = parsePollReply(replies[0]);
  assert.deepEqual(first.universes, [0, 1, 2, 3]);
  assert.deepEqual(first.active, [false, true, false, false]);
  assert.deepEqual(first.ip, [2, 0, 0, 10]);
  assert.equal(replies[0][200], STYLE_MEDIA);
  assert.deepEqual(parsePollReply(replies[1]).universes, [4]);
  assert.deepEqual(parsePollReply(replies[2]).universes, [17]);
  /* BindIndex counts the replies from one node, from 1. */
  assert.deepEqual(replies.map((b) => b[211]), [1, 2, 3]);
});

/* ---------------------------------------------------------------- sACN */

test('sACN: a data packet round-trips; preview and terminated are flags', () => {
  const data = new Uint8Array(512).fill(9);
  const p = parseSacn(buildSacnData(300, data, { cid: 'ab'.repeat(16), sourceName: 'MA3', priority: 150, sequence: 200 }));
  assert.equal(p.kind, 'data');
  assert.equal(p.universe, 300);
  assert.equal(p.priority, 150);
  assert.equal(p.sequence, 200);
  assert.equal(p.sourceName, 'MA3');
  assert.equal(p.cid, 'ab'.repeat(16));
  assert.equal(p.data.length, 512);
  assert.equal(p.preview, false);
  assert.equal(parseSacn(buildSacnData(1, data, { options: OPTION_PREVIEW })).preview, true);
  assert.equal(parseSacn(buildSacnData(1, data, { options: OPTION_TERMINATED })).terminated, true);
  assert.equal(parseSacn(buildArtPoll()), null);
});

test('sACN: the multicast group and the out-of-order rule', () => {
  assert.equal(multicastGroup(1), '239.255.0.1');
  assert.equal(multicastGroup(256), '239.255.1.0');
  assert.equal(outOfOrder(null, 5), false);
  assert.equal(outOfOrder(10, 11), false);
  assert.equal(outOfOrder(10, 10), true);
  assert.equal(outOfOrder(10, 0), true);
  assert.equal(outOfOrder(10, 246), false);      /* -20: a restarted source, accepted */
  assert.equal(outOfOrder(255, 0), false);        /* wrapped */
});

/* ------------------------------------------------------- who is in control */

const level = (v) => new Uint8Array(512).fill(v);

test('arbitration: highest priority wins, Art-Net counts as 100, and a quiet source is let go', () => {
  const input = new DmxInput({ universes: [1] });
  const r1 = input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(10) }, 0);
  assert.equal(r1.active, 'artnet:2.0.0.1:0');
  assert.equal(r1.activeChanged, true);
  const r2 = input.sacn(parseSacn(buildSacnData(1, level(20), { cid: '01'.repeat(16), priority: 150 })), 10);
  assert.equal(r2.active, `sacn:${'01'.repeat(16)}`);
  assert.equal(input.frame(1)[0], 20);
  /* The sACN main goes quiet; the Art-Net desk is in control again. */
  input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(10) }, SACN_LOSS_MS);
  const lost = input.expire(SACN_LOSS_MS + 20);
  assert.equal(lost.length, 1);
  assert.equal(lost[0].active, 'artnet:2.0.0.1:0');
  assert.equal(input.frame(1)[0], 10);
  assert.equal(input.expire(SACN_LOSS_MS + ARTNET_LOSS_MS + 100)[0].active, null);
  assert.equal(input.frame(1), null);
});

test('arbitration: equal priority is the lowest key, every time — not whoever booted first', () => {
  const input = new DmxInput({ universes: [1] });
  input.artnet({ ip: '2.0.0.9', portAddress: 0, data: level(9) }, 0);
  input.artnet({ ip: '2.0.0.1', portAddress: 0, data: level(1) }, 1);
  assert.equal(input.frame(1)[0], 1);
});

test('arbitration: preview data and alternate START codes never drive; terminated lets go; old packets are dropped', () => {
  const input = new DmxInput({ universes: [1] });
  const cid = '02'.repeat(16);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(5), { cid, options: OPTION_PREVIEW })), 0), null);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(5), { cid, startCode: 0xdd })), 0), null);
  input.sacn(parseSacn(buildSacnData(1, level(5), { cid, sequence: 10 })), 0);
  assert.equal(input.sacn(parseSacn(buildSacnData(1, level(6), { cid, sequence: 9 })), 1), null);
  assert.equal(input.frame(1)[0], 5);
  const end = input.sacn(parseSacn(buildSacnData(1, level(6), { cid, sequence: 11, options: OPTION_TERMINATED })), 2);
  assert.equal(end.active, null);
  assert.equal(end.why, 'terminated');
});

test('arbitration: a fifth desk on one universe is counted, not tracked; unwatched universes are ignored', () => {
  const input = new DmxInput({ universes: [1] });
  for (let i = 1; i <= MAX_SOURCES + 1; i++) input.artnet({ ip: `2.0.0.${i}`, portAddress: 0, data: level(i) }, i);
  assert.equal(input.describe(10)[0].sources.length, MAX_SOURCES);
  assert.equal(input.describe(10)[0].exceeded, true);
  assert.equal(input.artnet({ ip: '2.0.0.1', portAddress: 5, data: level(1) }, 0), null);
});

/* ------------------------------------------------------------- the patch */

test('the patch: Master, then each screen and its layers; a screen never straddles two universes', () => {
  const { fixtures, universes } = layout({ destinations: ['S1', 'S2'], layers: 4, firstUniverse: 1 });
  assert.deepEqual(fixtures.map((f) => `${f.id}@${f.universe}.${f.address}`),
    ['master@1.1', 'S1@1.5', 'S1.L1@1.9', 'S1.L2@1.12', 'S1.L3@1.15', 'S1.L4@1.18',
      'S2@1.21', 'S2.L1@1.25', 'S2.L2@1.28', 'S2.L3@1.31', 'S2.L4@1.34']);
  assert.deepEqual(universes, [1]);
  const block = footprint('screen') + 16 * footprint('layer');
  const big = layout({ destinations: Array.from({ length: 12 }, (_, i) => `S${i + 1}`), layers: 16, firstUniverse: 3, master: false });
  for (const id of big.fixtures.filter((f) => f.kind === 'screen').map((f) => f.destination)) {
    const us = new Set(big.fixtures.filter((f) => f.destination === id).map((f) => f.universe));
    assert.equal(us.size, 1, `${id} is in one universe`);
  }
  assert.equal(big.fixtures[0].universe, 3);
  assert.equal(big.universes.length, Math.ceil(12 / Math.floor(512 / block)));
  const csv = patchCsv(fixtures).split('\r\n');
  assert.equal(csv[0], 'Name,Fixture type,Mode,Universe,Address,Channels');
  assert.equal(csv[2], 'S1,LPP Screen,Cue,1,5,4');
});

test('the channels: a layer is folder, file and opacity; folder 0 holds; full is 256', () => {
  const [f] = layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, master: false }).fixtures.slice(1);
  const frame = new Uint8Array(512);
  frame.set([1, 3, 255], f.address - 1);
  const v = readFixture(f, frame);
  assert.deepEqual(v, { folder: 1, file: 3, opacity: 255 });
  assert.deepEqual(sourceOf(v), { kind: 'LIVE', number: 3 });
  assert.equal(sourceOf({ folder: 0, file: 3 }), null);
  assert.equal(sourceOf({ folder: 1, file: 0 }), null);
  assert.deepEqual(sourceOf({ folder: 6, file: 0 }), { kind: 'NONE', number: null });
  assert.equal(sourceOf({ folder: 99, file: 1 }), null);
  assert.equal(opacityOf(255), 256);
  assert.equal(opacityOf(0), 0);
  assert.equal(sourceValue('nlc', { kind: 'STILL', number: 12 }), 'STILL_12');
  assert.equal(sourceValue('nlc', { kind: 'COLOR', number: null }), 'COLOR');
  assert.equal(sourceValue('mng', { kind: 'LIVE', number: 3 }), 'INPUT_3');
  assert.equal(sourceValue('mng', { kind: 'STILL', number: 3 }), null);
});

const word16 = (v) => [v >> 8, v & 255];

test('the modes: Cue 3, Compact 11, Standard 24, Full 53 channels a layer; Master and Screen 4 in all', () => {
  assert.deepEqual(MODES.map((m) => m.id), ['cue', 'compact', 'standard', 'full']);
  assert.deepEqual(MODES.map((m) => footprint('layer', m.id)), [3, 11, 24, 53]);
  for (const m of MODES) assert.equal(footprint('screen', m.id), 4);
  for (const m of MODES) assert.equal(footprint('master', m.id), 4);
  const [f] = layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, master: false, mode: 'compact' }).fixtures.slice(1);
  const frame = new Uint8Array(512);
  frame.set([1, 3, 255, ...word16(CENTRE + 100), ...word16(CENTRE - 50), ...word16(640), ...word16(360)], f.address - 1);
  assert.deepEqual(readFixture(f, frame), { folder: 1, file: 3, opacity: 255, x: CENTRE + 100, y: CENTRE - 50, w: 640, h: 360 },
    '16-bit, coarse then fine');
  const csv = patchCsv(layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, mode: 'full' }).fixtures).split('\r\n');
  assert.equal(csv[3], 'S1 L1,LPP Layer,Full,1,9,53');
});

test('the look: W or H at zero is the memory’s, whatever else the desk holds', () => {
  const at = { folder: 1, file: 2, opacity: 255, x: CENTRE, y: CENTRE, w: 0, h: 1080 };
  assert.deepEqual(layerLook(at), { source: { kind: 'LIVE', number: 2 }, opacity: 256 }, 'W 0: source and opacity only');
  assert.deepEqual(layerLook({ ...at, w: 1920, h: 0 }), layerLook(at), 'H 0 as well');
  assert.deepEqual(layerLook({ ...at, w: 1920, x: CENTRE - 960 }).geometry, { x: -960, y: 0, w: 1920, h: 1080 });
  assert.deepEqual(layerLook({ folder: 0, file: 0, opacity: 0 }), { opacity: 0 }, 'Cue mode is what it was');

  const std = { ...at, w: 960, h: 540, cropLeft: 1000, cropRight: 0, cropTop: 0, cropBottom: 65535, red: 10, green: 20, blue: 30, flip: 0, strobe: 0 };
  const look = layerLook(std);
  assert.equal(look.colour, undefined, 'colour only with the Colour folder');
  assert.deepEqual(look.crop, { left: 1000, right: 0, top: 0, bottom: 65535 });
  assert.deepEqual(look.effects, { flipH: false, flipV: false, effect: null, strobe: null });
  assert.deepEqual(layerLook({ ...std, folder: 5 }).colour, { red: 10, green: 20, blue: 30 });
  assert.deepEqual(layerLook({ ...std, folder: 5, w: 0 }).colour, { red: 10, green: 20, blue: 30 }, 'colour is the source’s, not the look’s');
  assert.deepEqual([64, 128, 192, 255].map((flip) => { const e = layerLook({ ...std, flip }).effects; return [e.flipH, e.flipV]; }),
    [[true, false], [false, true], [true, true], [true, true]]);
  assert.deepEqual([0, 1, 128, 255].map(strobeFrames), [null, 255, 128, 2], 'slow to fast');

  const full = { ...std, maskLeft: 0, maskRight: 0, maskTop: 5, maskBottom: 0, aspect: 60, effect: 40, borderStyle: 0,
    borderRadius: 0, borderWidth: 4, borderHeight: 4, borderOpacity: 255, borderRed: 255, borderGreen: 0, borderBlue: 0,
    shadowStyle: 224, shadowRadius: 0, shadowX: CENTRE + 640, shadowY: 0, shadowOpacity: 128, shadowRed: 0, shadowGreen: 0, shadowBlue: 0, key: 7 };
  const lf = layerLook(full);
  assert.equal(lf.aspect, '1_1');
  assert.equal(lf.effects.effect, 'BLACK_N_WHITE');
  assert.equal(layerLook({ ...full, effect: 200 }).effects.effect, null, 'past the last effect is none');
  assert.deepEqual(lf.border.style, []);
  assert.deepEqual(lf.shadow.style, ['EDGE', 'SMOOTH', 'ROUNDED']);
  assert.deepEqual([lf.shadow.sizeH, lf.shadow.sizeV], [10, -512]);
  assert.equal(shadowOffset(65535), 512);
  assert.deepEqual(lf.key, { enable: true, slot: 7 });
  assert.deepEqual(layerLook({ ...full, key: 0 }).key, { enable: false, slot: null });
  assert.deepEqual(layerLook({ ...full, key: 51 }).key, { enable: false, slot: null });
});

test('the look on the wire: LivePremier anchors the centre; a Midra has no anchor, key or strobe frames', () => {
  const canvas = { width: 3840, height: 1080 };
  const geo = { x: -100, y: 40, w: 640, h: 360 };
  assert.deepEqual(lookParams(NLC, 'geometry', geo, canvas), [
    ['position.anchor', 'MIDDLE_CENTER'], ['position.posH', 1820], ['position.posV', 580],
    ['position.sizeH', 640], ['position.sizeV', 360],
  ]);
  assert.deepEqual(lookParams(NLC, 'geometry', geo, null), [], 'no canvas, no position');
  assert.deepEqual(lookParams(MNG, 'geometry', geo, canvas).map(([id]) => id),
    ['position.posH', 'position.posV', 'size.sizeH', 'size.sizeV']);
  assert.deepEqual(lookParams(NLC, 'crop', { left: 1, right: 2, top: 3, bottom: 4 }, canvas).map(([id]) => id),
    ['cropping.classic.left', 'cropping.classic.right', 'cropping.classic.top', 'cropping.classic.bottom']);
  assert.deepEqual(lookParams(MNG, 'colour', { red: 1, green: 2, blue: 3 }).map(([id]) => id), ['color.red', 'color.green', 'color.blue']);

  const fx = { flipH: true, flipV: false, effect: 'POSTERIZE', strobe: 10 };
  assert.deepEqual(lookParams(NLC, 'effects', fx), [['effects.flags', ['FLIP_H', 'POSTERIZE', 'STROBE']], ['effects.strobe.frames', 10]]);
  const [[id, flags]] = lookParams(MNG, 'effects', fx);
  assert.deepEqual(fitValue(layerSpec(MNG, id), flags), ['FLIP_H'], 'a Midra has no posterise or strobe');
  assert.deepEqual(lookParams(MNG, 'key', { enable: true, slot: 2 }), []);
  assert.deepEqual(lookParams(NLC, 'key', { enable: true, slot: 2 }), [['keying.enable', true], ['keying.source', 'SLOT_2']]);
  assert.deepEqual(lookParams(NLC, 'key', { enable: false, slot: null }), [['keying.enable', false]]);
  assert.deepEqual(lookParams(MNG, 'aspect', 'NONE'), [['crop.aspectOverride', 'GLOBAL_SETTING']]);

  assert.equal(fitValue(layerSpec(NLC, 'border.shadow.sizeH'), -900), -512, 'clamped to the catalogue');
  assert.equal(fitValue(layerSpec(NLC, 'cropping.classic.aspectOverride'), 'SIDEWAYS'), null);
  assert.equal(fitValue(null, 1), null);
});

/* ------------------------------------------------------------- the engine */

function rig(layers = 2) {
  const patch = layout({ destinations: ['S1'], layers, firstUniverse: 1 });
  const engine = new DeskEngine(patch.fixtures);
  const frame = new Uint8Array(512);
  const at = (id) => patch.fixtures.find((f) => f.id === id).address - 1;
  const set = (id, values) => { frame.set(values, at(id)); return engine.update(1, frame); };
  return { engine, frame, set, at, patch };
}

test('engine: nothing fires on the first frame, even with Take and Control at full', () => {
  const { engine, frame, at } = rig();
  frame.set([255, 7, 255, 255], at('S1'));
  frame.set([1, 2, 255], at('S1.L1'));
  assert.deepEqual(engine.update(1, frame), []);
  assert.equal(engine.control('S1'), CONTROL.PROGRAM);
});

test('engine: a screen ignores the desk until Control rises, and is handed the desk’s layers when it does', () => {
  const { set } = rig();
  set('S1', [0, 0, 0, 0]);
  assert.deepEqual(set('S1.L1', [1, 2, 255]), [], 'Control is off');
  const out = set('S1', [64, 0, 0, 0]);
  assert.deepEqual(out, [
    { type: 'engage', destination: 'S1', buffer: CONTROL.PREVIEW },
    { type: 'layer', destination: 'S1', layer: 1, param: 'source', value: { kind: 'LIVE', number: 2 } },
    { type: 'layer', destination: 'S1', layer: 1, param: 'opacity', value: 256 },
    { type: 'layer', destination: 'S1', layer: 2, param: 'opacity', value: 0 },
  ]);
  assert.deepEqual(set('S1', [0, 0, 0, 0]), [{ type: 'release', destination: 'S1' }]);
});

test('engine: one frame that recalls, sets a layer and takes comes out in that order', () => {
  const { set, frame, at, engine } = rig();
  set('S1', [64, 0, 0, 0]);
  set('S1', [64, 0, 0, 0]);
  frame.set([64, 3, 255, 0], at('S1'));
  frame.set([2, 5, 0], at('S1.L1'));
  const out = engine.update(1, frame).map((a) => a.type + (a.param ? `:${a.param}` : ''));
  assert.deepEqual(out, ['recall', 'layer:source', 'take']);
});

test('engine: triggers fire on a rise past 50%, memories on a change to non-zero', () => {
  const { set } = rig();
  set('S1', [200, 0, 0, 0]);
  assert.deepEqual(set('S1', [200, 0, 127, 0]), []);
  assert.deepEqual(set('S1', [200, 0, 128, 0]), [{ type: 'take', destination: 'S1' }]);
  assert.deepEqual(set('S1', [200, 0, 255, 0]), [], 'held, not risen');
  assert.deepEqual(set('S1', [200, 0, 0, 200]), [{ type: 'cut', destination: 'S1' }]);
  assert.deepEqual(set('S1', [200, 4, 0, 200]), [{ type: 'recall', destination: 'S1', slot: 4 }]);
  assert.deepEqual(set('S1', [200, 0, 0, 200]), [], 'back to zero recalls nothing');
});

test('engine: a new desk in control starts from a baseline', () => {
  const { engine, frame, at } = rig();
  frame.set([200, 0, 0, 0], at('S1'));
  engine.update(1, frame);
  frame.set([200, 0, 255, 0], at('S1'));
  assert.deepEqual(engine.update(1, frame, { fresh: true }), []);
  assert.equal(engine.control('S1'), CONTROL.PROGRAM, 'a lost desk does not let go of a screen');
});

test('engine: in Compact a moved layer writes its geometry; size to zero writes nothing more', () => {
  const patch = layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, mode: 'compact' });
  const engine = new DeskEngine(patch.fixtures);
  const frame = new Uint8Array(512);
  const at = (id) => patch.fixtures.find((f) => f.id === id).address - 1;
  const set = (id, values) => { frame.set(values, at(id)); return engine.update(1, frame); };
  set('S1', [100, 0, 0, 0]);
  set('S1', [100, 0, 0, 0]);
  assert.deepEqual(set('S1.L1', [0, 0, 255, ...word16(CENTRE), ...word16(CENTRE), ...word16(0), ...word16(0)]),
    [{ type: 'layer', destination: 'S1', layer: 1, param: 'opacity', value: 256 }], 'W and H 0: no geometry');
  assert.deepEqual(set('S1.L1', [0, 0, 255, ...word16(CENTRE + 5), ...word16(CENTRE), ...word16(640), ...word16(360)]),
    [{ type: 'layer', destination: 'S1', layer: 1, param: 'geometry', value: { x: 5, y: 0, w: 640, h: 360 } }]);
  assert.deepEqual(set('S1.L1', [0, 0, 255, ...word16(CENTRE + 5), ...word16(CENTRE), ...word16(0), ...word16(360)]), [],
    'back to zero hands the look to the memory without writing');
  assert.deepEqual(engine.layersFor('S1').map((a) => a.param), ['opacity']);
});

test('engine: the Master recalls master memories and takes every screen the desk holds', () => {
  const { set } = rig();
  set('master', [0, 0, 0, 0]);
  assert.deepEqual(set('master', [0, 2, 0, 0]), [], 'Master control off');
  set('master', [200, 2, 0, 0]);
  assert.deepEqual(set('master', [200, 5, 200, 0]), [{ type: 'recallMaster', slot: 5 }, { type: 'takeAll' }]);
});

/* -------------------------------------------------------- the fixture files */

test('GDTF: one file per fixture type, a zip holding description.xml, a mode per personality mode', () => {
  assert.deepEqual([...FIXTURE_KINDS], ['master', 'screen', 'layer']);
  const xml = descriptionXml('layer');
  assert.match(xml, /<GDTF DataVersion="1.2">/);
  const modes = [...xml.matchAll(/<DMXMode Name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['Cue', 'Compact', 'Standard', 'Full']);
  const cue = xml.slice(xml.indexOf('<DMXMode Name="Cue"'), xml.indexOf('<DMXMode Name="Compact"'));
  assert.equal((cue.match(/<DMXChannel /g) || []).length, 3);
  const full = xml.slice(xml.indexOf('<DMXMode Name="Full"'));
  assert.equal((full.match(/<DMXChannel /g) || []).length, 39, '53 slots: 14 channels are 16-bit');
  assert.match(full, /Offset="4,5" InitialFunction="Base_LPPPosX/);
  assert.match(full, /Attribute="LPPPosX" OriginalAttribute="" DMXFrom="0\/2" Default="32768\/2" PhysicalFrom="-32768"/);
  assert.match(full, /Attribute="ColorAdd_R" Snap="No"/);
  assert.match(xml, /<FeatureGroup Name="Color" Pretty="Color">\s*<Feature Name="RGB"\/>/);
  assert.match(xml, /<Attribute Name="ColorAdd_R" Pretty="R" Feature="Color.RGB" PhysicalUnit="ColorComponent"\/>/);
  assert.doesNotMatch(xml, /Name="[^"]*\.[^"]*"/, 'no dots in a name');
  assert.equal((descriptionXml('screen').match(/<DMXMode /g) || []).length, 4, 'the Screen has the same four modes');
  assert.match(xml, /Attribute="Dimmer" Snap="No" Master="Grand"/);
  assert.match(xml, /InitialFunction="Base_MediaFolder1.MediaFolder1.MediaFolder1"/);
  assert.equal(gdtfName('layer', '1'), 'Stoatworks@LPP_Layer@v1.gdtf');
  const files = unzipStore(gdtfFile('screen'));
  assert.deepEqual(files.map((f) => f.name), ['description.xml']);
  assert.equal(new TextDecoder().decode(files[0].data), descriptionXml('screen'));
  assert.deepEqual(gdtfFile('master'), gdtfFile('master'), 'the same bytes every time');
});

test('MVR: fixture IDs follow the switcher, UUIDs are the same every time, addresses are absolute', () => {
  const { fixtures } = layout({ destinations: ['S1', 'S12', 'A2'], layers: 3, firstUniverse: 1, mode: 'cue' });
  const ids = Object.fromEntries(fixtures.map((f) => [f.id, fixtureNumber(f)]));
  assert.equal(ids.master, 1);
  assert.equal(ids.S1, 100);
  assert.equal(ids['S1.L3'], 103);
  assert.equal(ids['S12.L1'], 1201);
  assert.equal(ids['A2.L2'], 5202);
  assert.equal(new Set(Object.values(ids)).size, fixtures.length, 'no two alike');
  const u = stableUuid('192.168.1.203', 'fixture', 'S1.L1');
  assert.match(u, /^[0-9A-F]{8}-[0-9A-F]{4}-8[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
  assert.equal(stableUuid('192.168.1.203', 'fixture', 'S1.L1'), u);
  assert.notEqual(stableUuid('192.168.1.204', 'fixture', 'S1.L1'), u, 'another switcher, another fixture');
  assert.equal(absoluteAddress(1, 1), 1);
  assert.equal(absoluteAddress(2, 1), 513);
});

test('MVR: a layer per screen, every fixture’s GDTF inside the file under the name the scene gives it, in a mode it has', () => {
  const { fixtures } = layout({
    destinations: ['S1', 'S2'], layers: 2, firstUniverse: 3, mode: 'standard', labelOf: (id) => (id === 'S1' ? 'Main & <Left>' : ''),
  });
  const xml = sceneXml(fixtures, { version: '2', host: 'h', providerVersion: '0.18.6', protocol: 'artnet' });
  assert.match(xml, /<GeneralSceneDescription verMajor="1" verMinor="6" provider="LivePremier Plus" providerVersion="0.18.6">/);
  assert.deepEqual([...xml.matchAll(/<Layer uuid="[^"]+" name="([^"]+)">/g)].map((m) => m[1]),
    ['LivePremier Plus', 'S1 Main &amp; &lt;Left&gt;', 'S2']);
  assert.equal((xml.match(/<Fixture /g) || []).length, fixtures.length);
  assert.equal((xml.match(/<Protocol type="Art-Net"\/>/g) || []).length, fixtures.length);
  assert.doesNotMatch(xml, /sACN/);
  const s2l2 = fixtures.find((f) => f.id === 'S2.L2');
  assert.match(xml, new RegExp(`<Address break="0">${(3 - 1) * 512 + s2l2.address}</Address>`));
  assert.equal(sceneXml(fixtures, { version: '2', host: 'h' }), sceneXml(fixtures, { version: '2', host: 'h' }), 'the same text every time');

  const files = unzipStore(mvrFile(fixtures, { version: '2', host: 'h', providerVersion: '0.18.6' }));
  assert.deepEqual(files.map((f) => f.name),
    ['GeneralSceneDescription.xml', 'Stoatworks@LPP_Master@v2.gdtf', 'Stoatworks@LPP_Screen@v2.gdtf', 'Stoatworks@LPP_Layer@v2.gdtf']);
  const scene = new TextDecoder().decode(files[0].data);
  for (const [, spec, mode] of scene.matchAll(/<GDTFSpec>([^<]+)<\/GDTFSpec>\s*<GDTFMode>([^<]+)<\/GDTFMode>/g)) {
    const gdtf = files.find((f) => f.name === spec);
    assert.ok(gdtf, spec);
    const description = new TextDecoder().decode(unzipStore(gdtf.data)[0].data);
    assert.ok(description.includes(`<DMXMode Name="${mode}"`), `${spec} has a ${mode} mode`);
  }
  const noMaster = layout({ destinations: ['S1'], layers: 1, firstUniverse: 1, master: false, mode: 'cue' }).fixtures;
  assert.equal(unzipStore(mvrFile(noMaster, { version: '2' })).some((f) => f.name.includes('Master')), false, 'only the types patched');
});

/* ------------------------------------------------------------ the other way */

const reading = (transition, memories, { up = 'B', down = 'A' } = {}) => {
  const isDown = transition.endsWith('DOWN');
  return { transition, program: isDown ? down : up, preview: isDown ? up : down, memories };
};

test('takes: a start fires with the memory going to air, once; its landing does not fire again', () => {
  const w = new TakeWatch();
  assert.equal(w.observe('S1', reading('AT_DOWN', { A: 3, B: 12 })), null, 'the first reading is a baseline');
  assert.deepEqual(w.observe('S1', reading('EFFECT_FROM_DOWN', { A: 3, B: 12 })), { destination: 'S1', memory: 12, how: 'start' });
  assert.equal(w.observe('S1', reading('EFFECT_FROM_DOWN', { A: 3, B: 12 })), null, 'still the same take');
  assert.equal(w.observe('S1', reading('AT_UP', { A: 3, B: 12 })), null, 'its landing is the same take');
  assert.equal(w.observe('S1', reading('AT_UP', { A: 3, B: 12 })), null);
});

test('takes: a flip with no start seen is a take at its landing; a T-bar pulled back is not a second take', () => {
  const w = new TakeWatch();
  w.observe('S1', reading('AT_DOWN', { A: 3, B: 12 }));
  assert.deepEqual(w.observe('S1', reading('AT_UP', { A: 3, B: 12 })), { destination: 'S1', memory: 12, how: 'land' },
    'a cut, or the simulator, which reports no state between');
  assert.deepEqual(w.observe('S1', reading('EFFECT_FROM_UP', { A: 3, B: 12 })).memory, 3);
  assert.equal(w.observe('S1', reading('AT_UP', { A: 3, B: 12 })), null, 'abandoned, back where it was: fired at its start already');
  assert.equal(w.observe('S1', reading('COPY_FROM_UP', { A: 3, B: 12 })), null, 'a copy is not a take');
  assert.equal(w.observe('S1', reading('AT_UP', { A: 3, B: 12 })), null);
});

test('takes: a memory loaded straight to program fires; a screen that cannot be read starts again', () => {
  const w = new TakeWatch();
  w.observe('S1', reading('AT_DOWN', { A: 3, B: 12 }));
  assert.equal(w.observe('S1', reading('AT_DOWN', { A: 3, B: 9 })), null, 'preview (B) changing is a recall, not a take');
  assert.deepEqual(w.observe('S1', reading('AT_DOWN', { A: 40, B: 9 })), { destination: 'S1', memory: 40, how: 'load' });
  assert.equal(w.observe('S1', null), null);
  assert.equal(w.observe('S1', reading('AT_UP', { A: 40, B: 9 })), null, 'after a gap, a baseline again');
  assert.equal(describeTake({ destination: 'S1', memory: 40, how: 'load' }), 'S1 loaded memory 40');
  assert.equal(describeTake({ destination: 'S2', memory: null, how: 'land' }), 'S2 took a look from no memory');
});

test('takes: rules by screen and memory, any of either; one fire per rule per cooldown', () => {
  const rules = normaliseDesk({ deskFeedbackRules: [
    { destination: 's1', memory: '12', trigger: 'vt' },
    { destination: '', memory: null, trigger: 'any-take' },
    { destination: 'S2', memory: 12, trigger: 'vt' },
    { destination: 'S1', memory: 0, trigger: '' },
    { destination: 'nope', memory: 12, trigger: 'vt' },
  ] }).deskFeedbackRules;
  assert.deepEqual(rules[0], { destination: 'S1', memory: 12, trigger: 'vt' });
  assert.deepEqual(rules[3], { destination: 'S1', memory: null, trigger: '' }, 'no trigger chosen yet: kept, never fires');
  assert.deepEqual(rules[4], { destination: '', memory: 12, trigger: 'vt' });
  const fired = new Map();
  assert.deepEqual(matchRules(rules, { destination: 'S1', memory: 12 }, 1000, fired), ['vt', 'any-take']);
  assert.deepEqual(matchRules(rules, { destination: 'S1', memory: 12 }, 1000 + COOLDOWN_MS - 1, fired), [], 'within the cooldown');
  assert.deepEqual(matchRules(rules, { destination: 'S2', memory: 5 }, 1000 + COOLDOWN_MS, fired), ['any-take']);
  assert.deepEqual(matchRules(rules, { destination: 'S2', memory: 12 }, 5000, fired), ['any-take', 'vt'], 'in rule order, each trigger once');
  assert.equal(normaliseDesk({ deskFeedbackRules: Array.from({ length: 50 }, () => ({})) }).deskFeedbackRules.length, 32);
});

/* -------------------------------------------------------------- settings */

test('settings: off, one screen, four layers, the Master, universe 1', () => {
  assert.deepEqual(normaliseDesk({}), { ...DEFAULT_DESK, deskAllow: [], deskDestinations: ['S1'] });
  const s = normaliseDesk({
    deskEnabled: true, deskProtocol: 'nonsense', deskInterface: '10.0.0.300', deskAllow: '2.0.0.1, bad 2.0.0.2',
    deskFirstUniverse: 70000, deskDestinations: ['s2', 'S2', 'X9', 'A1'], deskLayers: 40, deskMaster: false, deskMode: 'huge',
  });
  assert.equal(s.deskProtocol, 'both');
  assert.equal(s.deskInterface, '');
  assert.deepEqual(s.deskAllow, ['2.0.0.1', '2.0.0.2']);
  assert.equal(s.deskFirstUniverse, 1);
  assert.deepEqual(s.deskDestinations, ['S2', 'A1']);
  assert.equal(s.deskLayers, 4);
  assert.equal(s.deskMaster, false);
  assert.equal(s.deskMode, 'cue');
  assert.equal(normaliseDesk({ deskMode: 'full' }).deskMode, 'full');
  assert.deepEqual(normaliseDesk({ deskDestinations: [] }).deskDestinations, [], 'no screens is a choice');
  assert.equal(deskChanged(s, normaliseDesk(s)), false);
  assert.equal(deskChanged(s, { ...s, deskLayers: 2 }), true);
  assert.equal(allowed(s, '2.0.0.1'), true);
  assert.equal(allowed(s, '2.0.0.3'), false);
  assert.equal(allowed(normaliseDesk({}), '2.0.0.3'), true);
  assert.equal(normaliseDesk({ deskCitp: 'yes' }).deskCitp, false, 'CITP is on only when it is true');
  assert.equal(deskChanged(s, { ...s, deskCitp: true }), true);
});

/* --------------------------------------------------------- the held link */

test('the held link: one connection for many exchanges, writes resolve, and it hangs up when idle', async () => {
  const awj = await fakeAwj({ 'a/b': 1, 'c/d': 'two' });
  const link = new AwjLink({ host: () => '127.0.0.1', port: awj.port, idleMs: 100 });
  try {
    const [r1, r2] = await Promise.all([
      link.exchange({ messages: [{ op: 'get', path: 'a/b' }, { op: 'get', path: 'c/d' }] }),
      link.exchange({ messages: [{ op: 'replace', path: 'a/b', value: 5 }, { op: 'get', path: 'a/b' }] }),
    ]);
    assert.deepEqual(r1.map((r) => r.value), [1, 'two']);
    assert.deepEqual(r2.map((r) => r.value), [5]);
    assert.deepEqual(await link.exchange({ messages: [{ op: 'replace', path: 'c/d', value: 'x' }] }), []);
    await until(() => awj.store.get('c/d') === 'x', 1000, 'the write');
    assert.equal(link.stats.connects, 1);
    assert.equal(link.open, true);
    await until(() => !link.open, 1000, 'the idle hang-up');
    await link.exchange({ messages: [{ op: 'get', path: 'a/b' }] });
    assert.equal(link.stats.connects, 2, 'opened again by the next exchange');
  } finally {
    link.dispose();
    await awj.close();
  }
});

test('the held link: no switcher is an error, not a hang', async () => {
  const link = new AwjLink({ host: () => null });
  await assert.rejects(link.exchange({ messages: [{ op: 'get', path: 'x' }] }), /no switcher configured/);
  link.dispose();
});

/* ------------------------------------------------------ the supervisor */

const LOOPBACK = () => ({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true }] });

async function bench({ settings = {}, store: extra = [], landsAfter = 0, landMarginMs, triggers = null, awjDelayMs = 0 } = {}) {
  const store = new Map([['DeviceObject/system/$device/@items/1/@props/dev', 'NLC_AQL_C']]);
  const set = (path, v) => store.set(toAwj(path), v);
  set(NLC.takeStatus('S1', 'isUsed'), true);
  set(NLC.takeControl('S1', 'presetUp'), 'A');
  set(NLC.takeControl('S1', 'presetDown'), 'B');
  set(NLC.takeControl('S1', 'presetPrevious'), 'C');
  set(NLC.takeStatus('S1', 'transition'), 'AT_DOWN');
  for (const [p, v] of extra) set(p, v);
  const takePath = toAwj(NLC.takeControl('S1', 'xTake'));
  const transitionPath = toAwj(NLC.takeStatus('S1', 'transition'));
  /* A take swaps which letter is on air, as the switcher does: `landsAfter`
     ms after it is written, and never if null (a take the switcher refused). */
  const flip = (st) => st.set(transitionPath, st.get(transitionPath) === 'AT_DOWN' ? 'AT_UP' : 'AT_DOWN');
  const awj = await fakeAwj(store, {
    delayMs: awjDelayMs,
    onReplace: (path, value, st) => {
      if (path !== takePath || value !== true || landsAfter === null) return;
      if (landsAfter) setTimeout(() => flip(st), landsAfter); else flip(st);
    },
  });
  const timecodes = [];
  const sup = new DeskSupervisor({
    deviceHost: () => '127.0.0.1', awjPort: awj.port,
    ports: { artnet: 0, sacn: 0 }, bindAddress: '127.0.0.1', pollReplyPort: null,
    interfaces: LOOPBACK, settleMs: 60, idleMs: 2000, ...(landMarginMs === undefined ? {} : { landMarginMs }),
    timecode: () => ({ push: (tc) => timecodes.push(tc) }),
    triggers: () => triggers, watchMs: 20,
  });
  await sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, ...settings }));
  const desk = dgram.createSocket('udp4');
  await new Promise((r) => desk.bind(0, '127.0.0.1', r));
  const heard = [];
  desk.on('message', (b) => heard.push(b));
  const frame = new Uint8Array(512);
  const at = (id) => sup.patch.fixtures.find((f) => f.id === id).address - 1;
  let seq = 0;
  const send = (buf, proto = 'artnet') => new Promise((r) => desk.send(buf, sup.bound[proto], '127.0.0.1', r));
  const dmx = (id, values) => { if (id) frame.set(values, at(id)); return send(buildArtDmx(0, frame, { sequence: ++seq & 0xff })); };
  const writes = () => awj.writes();
  const close = async () => {
    sup.stop();
    desk.close();
    await awj.close();
  };
  /* fakeAwj keeps its own copy of the store: change the switcher through it. */
  const change = (path, v) => awj.store.set(toAwj(path), v);
  return { sup, awj, set: change, desk, heard, send, dmx, frame, at, writes, timecodes, close };
}

const layerPath = (letter, layer, tail) => toAwj(NLC.layerParamPath('S1', letter, layer, tail));

test('supervisor: answers ArtPoll as a media server, with the patched universes', async () => {
  const b = await bench();
  try {
    await b.send(buildArtPoll());
    await until(() => b.heard.length, 2000, 'an ArtPollReply');
    const reply = parsePollReply(b.heard[0]);
    assert.deepEqual(reply.universes, [0]);
    assert.deepEqual(reply.ip, [127, 0, 0, 1]);
    assert.equal(b.heard[0][200], STYLE_MEDIA);
  } finally { await b.close(); }
});

test('supervisor: a desk takes S1 over, sets a layer in preview, recalls, takes — in order, to the right letters', async () => {
  const b = await bench();
  try {
    const opacity = NLC.catalogue.layer.find((p) => p.id === NLC.layerParams.opacity).path;
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    /* Baseline: everything at zero. Then a layer is set while S1 is not the desk's. */
    await b.dmx(null);
    await b.dmx('S1.L1', [1, 2, 255]);
    await sleep(80);
    assert.deepEqual(b.writes(), [], 'Control is off: nothing written');

    /* Control to preview: the desk's layers go to preview, which is A (AT_DOWN: B on air). */
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 3, 2000, 'the engage writes');
    assert.deepEqual(b.writes(), [
      { path: layerPath('A', 1, source), value: 'LIVE_2' },
      { path: layerPath('A', 1, opacity), value: 256 },
      { path: layerPath('A', 2, opacity), value: 0 },
    ]);
    b.awj.clear();

    /* One cue: memory 3, layer 2 to STILL 4 at half, take. */
    b.frame.set([100, 3, 255, 0], b.at('S1'));
    b.frame.set([2, 4, 128], b.at('S1.L2'));
    await b.dmx(null);
    const recall = commandsFor(NLC).recallScreenPreset(3, 'S1', 'PREVIEW');
    const take = toAwj(NLC.takeControl('S1', 'xTake'));
    await until(() => b.writes().some((w) => w.path === take), 3000, 'the take');
    const w = b.writes().map((x) => x.path);
    const iRecall = w.indexOf(toAwj(recall.path));
    const iLayer = w.indexOf(layerPath('A', 2, source));
    const iTake = w.indexOf(take);
    assert.ok(iRecall >= 0 && iLayer > iRecall && iTake > iLayer, `recall, layer, take: ${w.join('\n')}`);
    /* After the take B is preview; the desk's layers are written to it again. */
    await until(() => b.writes().some((x) => x.path === layerPath('B', 2, source)), 2000, 'the re-push to the new preview');
    assert.equal(b.writes().find((x) => x.path === layerPath('B', 2, source)).value, 'STILL_4');
    assert.equal(b.sup.link.stats.connects, 1, 'one held connection throughout');
  } finally { await b.close(); }
});

test('supervisor: in Compact the desk places a layer from the screen’s centre, on its canvas as read now', async () => {
  const b = await bench({
    settings: { deskMode: 'compact', deskLayers: 1 },
    store: [[NLC.canvasSize('S1', 'sizeH'), 3840], [NLC.canvasSize('S1', 'sizeV'), 1080]],
  });
  try {
    const tail = (id) => NLC.catalogue.layer.find((p) => p.id === id).path;
    await b.dmx(null);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 1, 2000, 'the engage writes');
    b.awj.clear();
    await b.dmx('S1.L1', [0, 0, 255, ...word16(CENTRE - 960), ...word16(CENTRE + 10), ...word16(1920), ...word16(1080)]);
    await until(() => b.writes().length >= 6, 2000, 'the geometry writes');
    assert.deepEqual(b.writes(), [
      { path: layerPath('A', 1, tail('opacity.opacity')), value: 256 },
      { path: layerPath('A', 1, tail('position.anchor')), value: 'MIDDLE_CENTER' },
      { path: layerPath('A', 1, tail('position.posH')), value: 960 },
      { path: layerPath('A', 1, tail('position.posV')), value: 550 },
      { path: layerPath('A', 1, tail('position.sizeH')), value: 1920 },
      { path: layerPath('A', 1, tail('position.sizeV')), value: 1080 },
    ]);

    /* The screen resized under the desk: the next move is placed on the new canvas. */
    b.set(NLC.canvasSize('S1', 'sizeH'), 1920);
    b.awj.clear();
    await b.dmx('S1.L1', [0, 0, 255, ...word16(CENTRE), ...word16(CENTRE + 10), ...word16(1920), ...word16(1080)]);
    await until(() => b.writes().length >= 5, 2000, 'the second geometry writes');
    assert.equal(b.writes().find((w) => w.path === layerPath('A', 1, tail('position.posH'))).value, 960);
  } finally { await b.close(); }
});

test('supervisor: a screen whose size cannot be read gets the rest of the look, not a guessed position', async () => {
  const b = await bench({ settings: { deskMode: 'standard', deskLayers: 1 } });
  try {
    const tail = (id) => NLC.catalogue.layer.find((p) => p.id === id).path;
    await b.dmx(null);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 1, 2000, 'the engage writes');
    b.awj.clear();
    const crop = [...word16(100), ...word16(0), ...word16(0), ...word16(0)];
    await b.dmx('S1.L1', [0, 0, 255, ...word16(CENTRE), ...word16(CENTRE), ...word16(640), ...word16(360), ...crop, 0, 0, 0, 64, 0]);
    await until(() => b.writes().some((w) => w.path === layerPath('A', 1, tail('effects.flags'))), 2000, 'the effects write');
    const paths = b.writes().map((w) => w.path);
    assert.ok(!paths.includes(layerPath('A', 1, tail('position.posH'))), 'no position');
    assert.equal(b.writes().find((w) => w.path === layerPath('A', 1, tail('cropping.classic.left'))).value, 100);
    assert.deepEqual(b.writes().find((w) => w.path === layerPath('A', 1, tail('effects.flags'))).value, ['FLIP_H']);
  } finally { await b.close(); }
});

test('supervisor: mid-transition the layer values wait, and go to the letter that is preview after it', async () => {
  const b = await bench();
  try {
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    b.set(NLC.takeStatus('S1', 'transition'), 'EFFECT_FROM_DOWN');
    await sleep(60);
    b.awj.clear();
    await b.dmx('S1.L1', [1, 7, 0]);
    await sleep(150);
    assert.deepEqual(b.writes(), [], 'nothing written mid-transition');
    assert.equal(b.sup.describe().screens[0].held, 'mid-transition');
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_UP');
    await until(() => b.writes().length, 2000, 'the held write');
    /* AT_UP: A on air, B preview. */
    assert.deepEqual(b.writes()[0], { path: layerPath('B', 1, source), value: 'LIVE_7' });
  } finally { await b.close(); }
});

test('supervisor: after a take the layers wait for it to land, however long the switcher reports the old state', async () => {
  /* As the 6.2.73 simulator does: AT_DOWN for the whole take, then AT_UP. A 0.4 s take. */
  const b = await bench({ landsAfter: 400, store: [[NLC.takeControl('S1', 'takeUpTime'), 4]] });
  try {
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    const opacity = NLC.catalogue.layer.find((p) => p.id === NLC.layerParams.opacity).path;
    await b.dmx(null);
    await b.dmx('S1.L1', [1, 2, 255]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 3, 2000, 'the engage writes');
    b.awj.clear();
    const take = toAwj(NLC.takeControl('S1', 'xTake'));
    await b.dmx('S1', [100, 0, 255, 0]);
    await until(() => b.writes().some((w) => w.path === take), 2000, 'the take');
    const fired = Date.now();
    await sleep(250);
    /* Still AT_DOWN, so A reads as preview — and A is what the take is putting on air. */
    assert.deepEqual(b.writes().map((w) => w.path), [take], 'nothing written while the take runs');
    assert.equal(b.sup.describe().screens[0].held, 'the take landing');
    await until(() => b.writes().length > 1, 2000, 'the re-push');
    assert.ok(Date.now() - fired >= 350, `not before the take landed (${Date.now() - fired} ms)`);
    /* AT_UP: A on air, B preview. */
    assert.deepEqual(b.writes()[1], { path: layerPath('B', 1, source), value: 'LIVE_2' });
    const onAir = [1, 2].flatMap((l) => [layerPath('A', l, source), layerPath('A', l, opacity)]);
    assert.ok(!b.writes().some((w) => onAir.includes(w.path)), 'nothing written to the letter on air');
  } finally { await b.close(); }
});

test('supervisor: a take that never lands holds the layers only for its take time and a margin', async () => {
  const b = await bench({ landsAfter: null, landMarginMs: 100, store: [[NLC.takeControl('S1', 'takeUpTime'), 2]] });
  try {
    const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
    await b.dmx(null);
    await b.dmx('S1.L1', [1, 2, 255]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.writes().length >= 3, 2000, 'the engage writes');
    b.awj.clear();
    const take = toAwj(NLC.takeControl('S1', 'xTake'));
    await b.dmx('S1', [100, 0, 255, 0]);
    await until(() => b.writes().some((w) => w.path === take), 2000, 'the take');
    const fired = Date.now();
    await until(() => b.writes().length > 1, 2000, 'the re-push');
    assert.ok(Date.now() - fired >= 250, `0.2 s and the margin first (${Date.now() - fired} ms)`);
    /* Nothing moved, so A is still preview. */
    assert.deepEqual(b.writes()[1], { path: layerPath('A', 1, source), value: 'LIVE_2' });
  } finally { await b.close(); }
});

test('supervisor: a fader pulled fast is a few writes of where it went, not one per frame', async () => {
  const b = await bench();
  try {
    const opacity = NLC.catalogue.layer.find((p) => p.id === NLC.layerParams.opacity).path;
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await sleep(80);
    b.awj.clear();
    for (let v = 0; v <= 255; v += 5) await b.dmx('S1.L1', [0, 0, v]);
    await until(() => b.writes().some((w) => w.value === 256), 3000, 'the last value');
    const n = b.writes().filter((w) => w.path === layerPath('A', 1, opacity)).length;
    assert.ok(n < 20, `${n} writes for 52 frames`);
  } finally { await b.close(); }
});

test('supervisor: the allow list refuses other desks; sACN drives the same way; ArtTimeCode reaches the timecode service', async () => {
  const b = await bench({ settings: { deskAllow: ['10.9.9.9'] } });
  try {
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 0, 0]);
    await until(() => b.sup.counts.refused >= 2, 1000, 'refusals');
    assert.deepEqual(b.sup.describe().universes[0].sources, []);
    await b.sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, deskProtocol: 'both' }));
    const cid = '0a'.repeat(16);
    /* This app's own Triggers output is never taken for a desk. */
    await b.send(buildSacnData(1, b.frame, { cid: '0b'.repeat(16), sourceName: 'LivePremier Plus' }), 'sacn');
    await until(() => b.sup.counts.own === 1, 1000, 'its own stream ignored');
    b.frame.fill(0);
    await b.send(buildSacnData(1, b.frame, { cid, sequence: 1 }), 'sacn');
    b.frame.set([200, 0, 0, 0], b.at('S1'));
    await b.send(buildSacnData(1, b.frame, { cid, sequence: 2 }), 'sacn');
    await until(() => b.sup.describe().screens[0].control === 'program', 1000, 'program control over sACN');
    await b.send(buildArtTimeCode({ hours: 10, minutes: 0, seconds: 1, frames: 2, type: 1 }));
    await until(() => b.timecodes.length, 1000, 'a timecode');
    assert.deepEqual(b.timecodes[0], { hours: 10, minutes: 0, seconds: 1, frames: 2, rate: 25, dropFrame: false });
  } finally { await b.close(); }
});

const memoryOf = (letter) => NLC.bufferMemory('S1', letter);

test('supervisor: a take from elsewhere fires the rule’s trigger, a desk’s own take is not fired back', async () => {
  const fires = [];
  const triggers = {
    list: () => [{ id: 'vt', name: 'VT state' }],
    fire: async (ids, why) => { fires.push({ ids, why }); return { ok: true, results: [], names: ['VT state'] }; },
  };
  const b = await bench({
    triggers,
    settings: { deskFeedback: true, deskFeedbackRules: [{ destination: 'S1', memory: 7, trigger: 'vt' }] },
    store: [[memoryOf('A'), 7], [memoryOf('B'), 2], [memoryOf('C'), 0]],
  });
  try {
    await sleep(80);
    assert.deepEqual(b.sup.describe().feedback.watching, ['S1']);
    assert.deepEqual(b.sup.describe().feedback.triggers, [{ id: 'vt', name: 'VT state' }]);

    /* Someone takes on the switcher: A (memory 7) goes to air. */
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_UP');
    await until(() => fires.length === 1, 2000, 'the trigger');
    assert.deepEqual(fires[0], { ids: ['vt'], why: 'S1 took memory 7' });
    await until(() => b.sup.history.some((e) => e.kind === 'fired'), 1000, 'the history');

    /* Back again: B (memory 2) to air matches nothing. */
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_DOWN');
    await until(() => b.sup.describe().counts.takes === 2, 2000, 'the second take');
    assert.equal(fires.length, 1);

    /* The desk takes S1: A to air again, which the rule matches — but it was the desk’s own. */
    await b.dmx(null);
    await b.dmx('S1', [100, 0, 0, 0]);
    await b.dmx('S1', [100, 0, 255, 0]);
    await until(() => b.sup.describe().counts.echoes === 1, 3000, 'the desk’s take seen');
    await sleep(100);
    assert.equal(fires.length, 1, 'not fired back to the desk');

    /* And one from elsewhere after it fires again. */
    await sleep(600);
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_DOWN');
    await sleep(100);
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_UP');
    await until(() => fires.length === 2, 2000, 'the trigger again');
  } finally { await b.close(); }
});

test('supervisor: the watch runs with no desk listened to, and says so when the Triggers plugin is off', async () => {
  const b = await bench({
    settings: { deskEnabled: false, deskFeedback: true, deskFeedbackRules: [{ destination: 'S1', memory: null, trigger: 'vt' }] },
    store: [[memoryOf('A'), 7]],
  });
  try {
    assert.equal(b.sup.bound.artnet, null, 'no desk: no Art-Net port');
    await sleep(80);
    b.set(NLC.takeStatus('S1', 'transition'), 'AT_UP');
    await until(() => b.sup.history.some((e) => /Triggers plugin is off/.test(e.error || '')), 2000, 'the warning');
    await b.sup.apply(normaliseDesk({ deskFeedback: false, deskFeedbackRules: [{ destination: 'S1', trigger: 'vt' }] }));
    assert.deepEqual(b.sup.describe().feedback.watching, []);
  } finally { await b.close(); }
});

test('supervisor: reads what every patched layer has in program, for CITP, and the inputs and stills with CITP on', async () => {
  const source = NLC.catalogue.layer.find((p) => p.id === NLC.sourceParam).path;
  /* AT_DOWN with A up and B down: B is on air. */
  const b = await bench({ settings: { deskEnabled: false }, awjDelayMs: 20, store: [
    [NLC.layerParamPath('S1', 'B', 1, source), 'LIVE_3'],
    [NLC.layerParamPath('S1', 'B', 2, source), 'COLOR'],
    [NLC.layerParamPath('S1', 'A', 1, source), 'STILL_9'],
  ] });
  try {
    /* As a desk connecting at once does: the first facts read is on the wire, its answer not yet back. */
    b.awj.clear();
    await b.sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2 }));
    await until(() => b.awj.received.length, 2000, 'the first facts read sent');
    const got = await b.sup.readLayerSources();
    assert.deepEqual([...got], [['S1.L1', 'LIVE_3'], ['S1.L2', 'COLOR']]);
    assert.equal(b.sup.layerSources, got);
    await until(() => b.sup.facts, 2000, 'the facts read, not cut short by the layer read');
    assert.equal(b.sup.history.some((e) => /reading the switcher/.test(e.error || '')), false);
    assert.equal(b.sup.switcher.limits.inputs, 0, 'without CITP no inputs are read');
    await b.sup.apply(normaliseDesk({ deskEnabled: true, deskDestinations: ['S1'], deskLayers: 2, deskCitp: true }));
    assert.equal(b.sup.switcher.limits.inputs, 48);
    assert.equal(b.sup.switcher.limits.stills, 48);
    assert.deepEqual(b.sup.interfaceAddresses(), ['127.0.0.1'], 'loopback only where there is nothing else');
  } finally { await b.close(); }
});

test('supervisor: switched off, it closes its ports', async () => {
  const b = await bench();
  try {
    assert.ok(b.sup.bound.artnet && b.sup.bound.sacn);
    await b.sup.apply(normaliseDesk({ deskEnabled: false }));
    assert.equal(b.sup.bound.artnet, null);
    assert.equal(b.sup.bound.sacn, null);
    assert.equal(b.sup.describe().enabled, false);
  } finally { await b.close(); }
});

/* ------------------------------------------------------------------ the card */

test('the card: says what the chosen mode carries, and lists the switcher-to-desk rules', async () => {
  const { install } = await import('./helpers/fake-dom.js');
  const dom = install();
  const realFetch = globalThis.fetch;
  try {
    const { KIT } = await import('../src/ui/plugin-host.js');
    const { default: activate } = await import('../plugins/desk-control/client.js');
    let settings = normaliseDesk({
      deskEnabled: true, deskMode: 'standard', deskFeedback: true, deskCitp: true,
      deskFeedbackRules: [{ destination: 'S1', memory: 12, trigger: 'vt' }, { trigger: 'gone' }],
    });
    const live = {
      interfaces: [], switcher: { destinations: [] }, patch: { fixtures: [] }, universes: [], sockets: {}, history: [], screens: [],
      counts: { written: 0, refused: 0, dropped: 0, takes: 3, fired: 2, echoes: 1 },
      feedback: { on: true, watching: ['S1'], triggers: [{ id: 'vt', name: 'VT state' }] },
      citp: {
        tcp: 4811, udp: 4809, errors: { multicast: '239.224.0.180: no route' },
        clients: [{ address: '10.0.0.5', name: 'MagicQ', version: '1.2' }], peers: [{ name: 'MagicQ', address: '10.0.0.5' }],
        streams: [{ source: 2, format: 'JPEG' }], counts: { thumbnails: 3, frames: 1 },
      },
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => live });
    let render;
    activate({
      kit: KIT, url: (p) => p, refresh: () => {},
      settings: { get: () => settings, set: async (p) => (settings = normaliseDesk({ ...settings, ...p })) },
      ui: { settingsSection: (s) => { render = s.render; } },
    });
    render();
    await sleep(10);
    const text = render().textContent;
    for (const want of ['Standard mode is 4 channels a screen and 24 a layer', 'while W or H is at zero', 'Switcher to desk',
      'VT state', 'gone (not in Triggers now)', 'Takes seen', 'Not echoed', 'Add a rule', 'Patch .mvr',
      'Be a media server for the desk (CITP)', 'TCP 4811, UDP 4809', 'MagicQ (MSEX 1.2)', 'MagicQ at 10.0.0.5', 'IN2',
      '239.224.0.180: no route', 'not grandMA3']) {
      assert.ok(text.includes(want), want);
    }
  } finally {
    globalThis.fetch = realFetch;
    dom.uninstall();
  }
});
