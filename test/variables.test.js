/*
 * Variables: the catalogue generated from a store, the user's own and their
 * cycles, the page's service, the server's document, and the two places the
 * store's absence has to be said out loud.
 *
 * The catalogue is tested against real captures — the LivePremier
 * simulator's slices and a cut of the Midra 4K simulator (3.2.29) — because
 * the point of generating it is that it says what *this* switcher has. The
 * refusals get the most attention: a variable is a number nobody typed, and
 * the failure to defend against is a plausible wrong one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DeviceStore } from '../src/core/device-store.js';
import { run } from '../src/vendor/mynah-lang.mjs';
import {
  systemCatalogue, systemIndex, explain, normalise, checkName, findCycles,
  createUserEvaluator, makeResolver, storelessResolver, NAME_MAX
} from '../plugins/variables/core.js';
import { createVariables, renameIn, splitName } from '../plugins/variables/service.js';
import activateServer from '../plugins/variables/server.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** Deep-merge the simulator's capture slices into one device store. */
function merged(...names) {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  return names.map(fixture).reduce(merge, {});
}

/** LivePremier simulator 6.2.73: S1 in service with layer 1 allocated, program B. */
function nlc() {
  const s = new DeviceStore();
  s.hydrate(merged('sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
    'sim-6.2.73-connectors.json', 'sim-6.2.73-outputs.json', 'sim-6.2.73-inputs-signal.json'));
  return s;
}

/** Midra 4K simulator 3.2.29 (PULSE): S1 and S2 in service, two layers each. */
function mng() {
  const s = new DeviceStore();
  s.hydrate(fixture('midra-3.2.29-variables.json'));
  return s;
}

const names = (store) => systemCatalogue(store).map((e) => e.name);
const value = (store, name) => {
  const a = systemIndex(store).resolve(name);
  assert.ok(a && a.ok, `${name}: ${a ? a.error : 'unknown'}`);
  return a.value;
};
const refusal = (store, name) => {
  const a = systemIndex(store).resolve(name);
  assert.ok(a && !a.ok, `expected ${name} to be refused, got ${JSON.stringify(a)}`);
  return a.error;
};

/* ============================================================ catalogue */

test('a LivePremier: the device, the screen in service, its allocated layer, inputs, outputs, timers', () => {
  const store = nlc();
  const all = names(store);
  for (const n of ['device.model', 'S1.width', 'S1.height', 'S1.label', 'S1.layers', 'S1.outputs', 'S1.takeTime',
    'S1.PGM.memory', 'S1.PVW.memory', 'S1.PGM.L1.x', 'S1.PGM.L1.w', 'S1.PVW.L1.opacity', 'S1.PGM.L1.source',
    'IN1.width', 'IN3.rate', 'IN2.valid', 'OUT1.width', 'OUT3.cw', 'OUT2.x', 'OUT1.screen', 'TIMER1.value']) {
    assert.ok(all.includes(n), `${n} is in the catalogue`);
  }
  assert.equal(value(store, 'device.model'), 'NLC_CMAX');
  assert.equal(value(store, 'S1.width'), 1920);
  assert.equal(value(store, 'S1.takeTime'), 1, 'tenths on the wire, seconds here');
  assert.equal(value(store, 'IN1.rate'), 60, 'the store says 60000 — thousandths on LivePremier');
  assert.equal(value(store, 'IN1.valid'), 1);
  assert.equal(value(store, 'OUT2.x'), 1920);
  assert.equal(value(store, 'OUT3.cw'), 2560, 'the footprint, not the raster');
  assert.equal(value(store, 'OUT3.width'), 1920, 'the raster');
  assert.equal(value(store, 'OUT1.screen'), 'S1');
});

test('a role is read through the take state: S1 is AT_UP with B up, so program is B', () => {
  const store = nlc();
  /* The capture's preset B has layer 1 full screen; A has it at 960×960. */
  assert.equal(value(store, 'S1.PGM.L1.w'), 1920);
  assert.equal(value(store, 'S1.PVW.L1.w'), 960);
  assert.equal(value(store, 'S1.PVW.L1.h'), 960);
  /* A take swaps them — the variable follows the role, not the letter. */
  store.set(['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'], 'AT_DOWN');
  assert.equal(value(store, 'S1.PGM.L1.w'), 960);
  assert.equal(value(store, 'S1.PVW.L1.w'), 1920);
});

test('mid-take, a role variable is refused rather than guessed — and nothing else is', () => {
  const store = nlc();
  store.set(['device', 'screenAuxGroupList', 'items', 'S1', 'status', 'pp', 'transition'], 'EFFECT_FROM_UP');
  assert.match(refusal(store, 'S1.PGM.L1.x'), /S1 is mid-take/);
  assert.match(refusal(store, 'S1.PVW.L1.x'), /mid-take/);
  assert.match(refusal(store, 'S1.PGM.memory'), /mid-take/);
  assert.equal(value(store, 'S1.width'), 1920, 'a canvas is not a role');
});

test('only allocated layers are variables — the preset’s geometry for the rest is not', () => {
  const store = nlc();
  const all = names(store);
  /* S1's preset carries layer 2 and NATIVE; the screen has neither allocated. */
  assert.ok(store.get(['device', 'screenList', 'items', 'S1', 'presetList', 'items', 'A', 'layerList', 'items', '2']));
  assert.equal(all.some((n) => n.startsWith('S1.PGM.L2.')), false);
  assert.equal(all.some((n) => n.startsWith('S1.PGM.NATIVE.')), false);
  assert.match(refusal(store, 'S1.PGM.L2.x'), /no layer 2 allocated/);
  assert.match(refusal(store, 'S1.PGM.NATIVE.x'), /no NATIVE layer allocated/);
});

test('a destination not in service is said to be, not reported unknown', () => {
  const store = nlc();
  assert.equal(names(store).some((n) => n.startsWith('S2.')), false, 'S2 is not in service in the capture');
  assert.match(refusal(store, 'S2.width'), /S2 is not in service/);
  assert.equal(systemIndex(store).resolve('S99.width'), undefined, 'a screen the switcher has never had is unknown');
});

test('a canvas that has not been reported is an error, not the 1920×1080 a card falls back to', () => {
  const store = nlc();
  store.set(['device', 'screenList', 'items', 'S1', 'status', 'size', 'pp'], {});
  assert.equal(names(store).includes('S1.width'), false);
  assert.match(refusal(store, 'S1.width'), /has not reported a canvas size/);
});

test('names are matched without regard to case, in a Map', () => {
  const store = nlc();
  assert.equal(value(store, 's1.WIDTH'), 1920);
  assert.equal(value(store, 'in1.Rate'), 60);
  assert.equal(systemIndex(store).resolve('constructor'), undefined);
  assert.equal(systemIndex(store).resolve('__proto__'), undefined);
});

test('a label is text: listed, and refused in arithmetic by name', () => {
  const store = nlc();
  store.set(['device', 'screenList', 'items', 'S1', 'control', 'pp', 'label'], 'Main LED');
  assert.equal(value(store, 'S1.label'), 'Main LED');
  const resolve = makeResolver([], (n) => systemIndex(store).resolve(n));
  const r = run('Set Screen 1 Layer 1 Size $S1.label 100', { vars: { resolve }, facts: { buffer: () => 'B', canvas: () => ({ w: 1920, h: 1080 }) } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /\$S1\.label is text \("Main LED"\)/);
});

test('a Midra 4K: its own spellings, the same names', () => {
  const store = mng();
  const all = names(store);
  for (const n of ['device.name', 'S1.width', 'S2.width', 'S1.PGM.L1.x', 'S1.PGM.L2.w', 'S2.PVW.L2.opacity',
    'IN1.width', 'IN3.width', 'OUT1.rate', 'OUT2.cw', 'TIMER1.state']) {
    assert.ok(all.includes(n), `${n} is in the catalogue`);
  }
  assert.equal(value(store, 'device.name'), 'Midra 4K');
  assert.equal(value(store, 'device.model'), 'PULSE');
  assert.equal(value(store, 'S2.width'), 1024);
  assert.equal(value(store, 'S2.height'), 640);
  assert.equal(value(store, 'IN3.width'), 3840);
  assert.equal(value(store, 'IN1.rate'), 60, 'plain Hz here — the store says 60');
  assert.equal(value(store, 'OUT1.rate'), 50);
  assert.equal(value(store, 'OUT2.screen'), 'S2', 'from the applied preconfig');
  assert.equal(value(store, 'OUT2.cw'), 1024);
  /* No timer value is published on this platform, so there is no variable for one. */
  assert.equal(all.includes('TIMER1.value'), false);
  /* Program is the transition's suffix: AT_DOWN, so program DOWN. */
  const s1 = (b) => ['device', 'screenList', 'items', '1', 'presetList', 'items', b, 'liveLayerList', 'items', '1', 'position', 'pp', 'posH'];
  assert.equal(value(store, 'S1.PGM.L1.x'), store.get(s1('DOWN')));
  assert.equal(value(store, 'S1.PVW.L1.x'), store.get(s1('UP')));
  assert.notEqual(store.get(s1('DOWN')), store.get(s1('UP')), 'the capture tells the two apart');
});

test('a Midra mid-take refuses a role the same way', () => {
  const store = mng();
  store.set(['device', 'transition', 'screenList', 'items', '1', 'status', 'pp', 'transition'], 'EFFECT_FROM_DOWN');
  assert.match(refusal(store, 'S1.PGM.L1.x'), /S1 is mid-take/);
  assert.equal(value(store, 'S2.PGM.L1.x'), 960, 'another screen is not mid-take');
});

test('a store that has not arrived has no system variables, and says nothing it cannot back', () => {
  const store = new DeviceStore();
  assert.deepEqual(systemCatalogue(store), []);
  assert.equal(explain(store, 'S1.width'), undefined);
});

/* ======================================================== user variables */

test('the stored document is normalised, not refused', () => {
  const doc = normalise({
    variables: [
      { id: 'a1', name: 'gap', value: '40' },
      { name: 'GAP', value: '50' },              // a second gap, in any case
      { name: '9lives', value: '1' },             // not a name
      { name: 'x'.repeat(NAME_MAX + 1), value: '1' },
      { name: 'cols', value: 3 },                 // a number, kept as text
      { name: 'broken', value: '(1 +' },          // kept: shown as broken, not lost
      null, 'junk'
    ]
  });
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.variables.map((v) => [v.name, v.value]), [['gap', '40'], ['cols', '3'], ['broken', '(1 +']]);
  assert.equal(doc.variables[0].id, 'a1');
  assert.ok(doc.variables.every((v) => /^[a-z0-9-]+$/.test(v.id)));
  assert.deepEqual(normalise(null), { version: 1, variables: [] });
});

test('a name is checked for shape, length and clashes, in any case', () => {
  const vars = [{ id: 'a', name: 'gap', value: '1' }];
  assert.equal(checkName('wall.left', vars), null);
  assert.match(checkName('', vars), /needs a name/);
  assert.match(checkName('9x', vars), /starting with a letter/);
  assert.match(checkName('a b', vars), /letters, digits/);
  assert.match(checkName('GAP', vars), /@gap already exists/);
  assert.equal(checkName('gap', vars, 'a'), null, 'a row may keep its own name');
});

test('user variables evaluate over numbers, $ names and each other', () => {
  const store = nlc();
  const sys = (n) => systemIndex(store).resolve(n);
  const ev = createUserEvaluator([
    { name: 'gap', value: '40' },
    { name: 'half', value: '$S1.width / 2' },
    { name: 'inset', value: '@half - @gap * 2' },
    { name: 'bad', value: '$S1.widht' },
    { name: 'leans', value: '@bad + 1' },
    { name: 'empty', value: '' }
  ], sys);
  assert.deepEqual(ev.user('gap'), { ok: true, value: 40 });
  assert.deepEqual(ev.user('HALF'), { ok: true, value: 960 });
  assert.deepEqual(ev.user('inset'), { ok: true, value: 880 });
  assert.match(ev.user('bad').error, /unknown variable \$S1\.widht/);
  assert.match(ev.user('leans').error, /@bad: unknown variable/);
  assert.match(ev.user('empty').error, /no value/);
  assert.equal(ev.user('nope'), undefined);
});

test('a cycle is found before evaluating, and every member says so', () => {
  const defs = [
    { name: 'a', value: '@b + 1' },
    { name: 'b', value: '@c * 2' },
    { name: 'c', value: '@a' },
    { name: 'self', value: '@self + 1' },
    { name: 'fine', value: '3' },
    { name: 'downstream', value: '@a + @fine' }
  ];
  const cycles = findCycles(defs);
  assert.deepEqual([...cycles.keys()].sort(), ['a', 'b', 'c', 'self']);
  assert.match(cycles.get('a'), /^@(a|b|c) → @(a|b|c) → @(a|b|c) → @\1$/);
  assert.equal(cycles.get('self'), '@self → @self');
  const ev = createUserEvaluator(defs, () => undefined);
  assert.match(ev.user('b').error, /part of a cycle/);
  assert.match(ev.user('downstream').error, /@a: is part of a cycle/);
  assert.deepEqual(ev.user('fine'), { ok: true, value: 3 });
});

test('the same resolver drives mynah: a Set typed with variables', () => {
  const store = nlc();
  const resolve = makeResolver([{ name: 'gap', value: '40' }], (n) => systemIndex(store).resolve(n));
  const facts = { buffer: () => 'A', canvas: () => ({ w: 1920, h: 1080 }) };
  const r = run('Set Screen 1 Layer 1 Size ($S1.width / 2) $S1.height Position (@gap * 3) 540', { vars: { resolve }, facts });
  assert.ok(r.ok, r.ok ? '' : r.errors[0].message);
  assert.deepEqual(r.ops.map((o) => o.value), [960, 1080, 120, 540]);
});

/* ============================================================== OSC side */

test('with no store, $ names are refused with the reason, and @ names that reach one too', () => {
  const resolve = storelessResolver([
    { name: 'gap', value: '40' },
    { name: 'triple', value: '@gap * 3' },
    { name: 'half', value: '$S1.width / 2' }
  ]);
  assert.deepEqual(resolve('triple', 'user'), { ok: true, value: 120 });
  assert.match(resolve('S1.width', 'system').error, /does not hold/);
  assert.match(resolve('half', 'user').error, /\$S1\.width/);
  const r = run('/lp/screen/1/preset/a/layer/1/position/posH "@half"', { vars: { resolve } });
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /@half: \$S1\.width: needs the switcher’s state/);
  const ok = run('/lp/screen/1/preset/a/layer/1/position/posH "@triple + 1"', { vars: { resolve } });
  assert.ok(ok.ok && ok.ops[0].value === 121);
});

/* ================================================================ service */

function serviceOver(store, stored = null) {
  const saved = [];
  let fail = false;
  const v = createVariables({
    store: () => store,
    load: async () => stored,
    save: async (doc) => { if (fail) throw new Error('disk full'); saved.push(JSON.parse(JSON.stringify(doc))); },
    now: (() => { let t = 0; return () => (t += 1000); })()
  });
  return { v, saved, failNext: () => { fail = true; } };
}

test('the service loads, adds, renames with references, removes, and saves the document shape', async () => {
  const { v, saved } = serviceOver(nlc(), { version: 1, variables: [{ id: 'g', name: 'gap', value: '40' }] });
  let heard = 0;
  v.onChange(() => { heard++; });
  await v.start();
  assert.equal(v.state().loaded, true);
  assert.deepEqual(v.service.resolve('@gap'), { ok: true, value: 40 });

  const added = v.add({ name: 'triple', value: '@gap * 3' });
  assert.ok(added.row);
  assert.deepEqual(v.service.resolve('@triple'), { ok: true, value: 120 });
  assert.match(v.add({ name: 'GAP' }).error, /already exists/);

  /* A rename carries the reference with it. */
  assert.equal(v.update('g', { name: 'spacing' }), null);
  assert.equal(v.definitions().find((d) => d.name === 'triple').value, '@spacing * 3');
  assert.deepEqual(v.service.resolve('@triple'), { ok: true, value: 120 });
  assert.match(v.update('g', { name: 'triple' }), /already exists/);

  /* A definition is kept whatever it says, and says why it has no value. */
  assert.equal(v.update(added.row.id, { value: '@spacing / 0' }), null);
  assert.match(v.service.resolve('@triple').error, /division by zero/);

  v.remove('g');
  await new Promise((r) => setImmediate(r));
  const last = saved[saved.length - 1];
  assert.deepEqual(Object.keys(last), ['version', 'variables']);
  assert.deepEqual(last.variables.map((d) => d.name), ['triple']);
  assert.ok(heard >= 4);
});

test('the service resolves and evaluates for the Console and the fields', async () => {
  const { v } = serviceOver(nlc(), { variables: [{ name: 'gap', value: '40' }] });
  await v.start();
  const resolve = v.service.resolver();
  assert.deepEqual(resolve('S1.width', 'system'), { ok: true, value: 1920 });
  assert.deepEqual(resolve('gap', 'user'), { ok: true, value: 40 });
  assert.deepEqual(v.service.evaluate('$S1.width/2 - @gap'), { ok: true, value: 920 });
  assert.equal(v.service.resolve('$nope'), undefined);
  const listed = v.service.list();
  assert.ok(listed.some((e) => e.kind === 'system' && e.name === '$S1.width' && e.answer.value === 1920));
  assert.ok(listed.some((e) => e.kind === 'user' && e.name === '@gap' && e.answer.value === 40));
});

test('a definition is previewed as it is typed, cycles included, without being kept', async () => {
  const { v, saved } = serviceOver(nlc(), { variables: [{ id: 'a', name: 'a', value: '1' }, { id: 'b', name: 'b', value: '@a + 1' }] });
  await v.start();
  assert.deepEqual(v.preview('a', '$S1.width'), { ok: true, value: 1920 });
  assert.match(v.preview('a', '@b').error, /cycle/);
  assert.equal(v.definitions()[0].value, '1');
  assert.equal(saved.length, 0);
});

test('a failed save is said, and the variable stands on the page', async () => {
  const { v, failNext } = serviceOver(nlc(), null);
  await v.start();
  failNext();
  v.add({ name: 'gap', value: '40' });
  await new Promise((r) => setImmediate(r));
  assert.match(v.state().saving, /not saved — disk full/);
  assert.deepEqual(v.service.resolve('@gap'), { ok: true, value: 40 });
});

test('renameIn touches whole names only', () => {
  assert.equal(renameIn('@wall + @wall.left + @walls + @WALL', 'wall', 'w'), '@w + @wall.left + @walls + @w');
  assert.deepEqual(splitName(' $S1.width '), { sigil: '$', name: 'S1.width' });
  assert.equal(splitName('S1.width'), null);
});

/* ================================================================= server */

/** The server half over a stand-in ctx, with a real data directory. */
async function serverHalf() {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-variables-'));
  const routes = new Map();
  const sections = [];
  const services = new Map();
  let device = '10.0.0.5:80';
  const { writeFile, readFile, mkdir } = await import('node:fs/promises');
  const fileOf = (name, forDevice) => join(dir, `${name}-${(forDevice ?? device).replace(/[^a-z0-9.-]/gi, '_')}.json`);
  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  const ctx = {
    HttpError,
    device: () => device,
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    contribute: (point, spec) => sections.push({ point, spec }),
    provide: (name, api) => services.set(name, api),
    onDispose() {},
    storage: {
      async load(name, { device: d } = {}) { try { return JSON.parse(await readFile(fileOf(name, d), 'utf8')); } catch { return null; } },
      async save(name, data, { device: d } = {}) { await mkdir(dir, { recursive: true }); await writeFile(fileOf(name, d), JSON.stringify(data)); }
    }
  };
  activateServer(ctx);
  const call = async (method, body) => {
    let answer = null;
    const h = { json: (status, data) => { answer = { status, data }; }, readBody: async () => Buffer.from(body ?? '') };
    await routes.get(`${method} /`)({}, {}, h);
    return answer;
  };
  return {
    call, sections, services, file: (d) => fileOf('variables', d),
    repoint: (d) => { device = d; },
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

test('the server keeps the document per switcher, normalised, and refuses an empty body', async () => {
  const s = await serverHalf();
  try {
    assert.deepEqual(await s.call('GET'), { status: 200, data: { data: null } });
    const put = await s.call('PUT', JSON.stringify({ data: { variables: [{ name: 'gap', value: '40' }, { name: '9x', value: '1' }] } }));
    assert.equal(put.status, 200);
    assert.deepEqual(put.data.data.variables.map((v) => v.name), ['gap']);
    const got = await s.call('GET');
    assert.equal(got.data.data.variables[0].value, '40');
    await assert.rejects(s.call('PUT', ''), /invalid JSON/);
    /* Another switcher has none of them. */
    s.repoint('10.0.0.6:80');
    assert.deepEqual((await s.call('GET')).data, { data: null });
  } finally {
    await s.cleanup();
  }
});

test('the OSC resolver follows a save, and refuses $ names', async () => {
  const s = await serverHalf();
  try {
    const service = s.services.get('variables');
    assert.equal((await service.resolver())('gap', 'user'), undefined);
    await s.call('PUT', JSON.stringify({ variables: [{ name: 'gap', value: '40' }] }));
    const resolve = await service.resolver();
    assert.deepEqual(resolve('gap', 'user'), { ok: true, value: 40 });
    assert.match(resolve('S1.width', 'system').error, /does not hold/);
  } finally {
    await s.cleanup();
  }
});

test('the setup file carries the variables under show, and a restore lands on the switcher it names', async () => {
  const s = await serverHalf();
  try {
    const section = s.sections.find((c) => c.point === 'configSection').spec;
    assert.equal(section.key, 'variables');
    assert.equal(section.group, 'show');
    assert.equal(section.perDevice, true);
    assert.equal(await section.export('10.0.0.5:80'), undefined, 'nothing to write is not an empty section');
    await section.import({ variables: [{ name: 'gap', value: '40' }] }, '10.0.0.9:80');
    const exported = await section.export('10.0.0.9:80');
    assert.deepEqual(exported.variables.map((v) => [v.name, v.value]), [['gap', '40']]);
    assert.equal(await section.export('10.0.0.5:80'), undefined, 'restored onto the frame named, not the one pointed at');
  } finally {
    await s.cleanup();
  }
});
