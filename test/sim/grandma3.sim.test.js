/*
 * grandMA3, live: the bytes grandMA3 onPC 2.4.2.2 sent on this Mac
 * (`test/fixtures/grandma3-2.4.2.2-feedback.json`), replayed over UDP to the
 * app's own OSC listener with the grandma3 plugin on, and every effect read
 * back off the switcher over AWJ. S1 is put back afterwards.
 *
 * Only the desk is a recording. Everything from a packet's bytes to the
 * switcher is the code that ships — which is still not a desk with a wing on
 * a show: the fader messages are on-screen ones (`via` 1), not a physical
 * fader's.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SKIP, startApp, Link, awjGet, sag, settled, guardScreen, layerPath, sleep } from './harness.js';
import { bankLetter } from '../../src/core/properties.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(await readFile(join(here, '..', 'fixtures', 'grandma3-2.4.2.2-feedback.json'), 'utf8'));

let app;
let link;
let guard;
let udp;
let port;

const pickPort = () => 41000 + Math.floor(Math.random() * 8000);

/** The recorded message: the nth with this address and function, as the desk sent it. */
function recorded(object, fn, nth = 0) {
  const all = fixture.messages.filter((m) => m.address === `/ma3/${object}` && m.args[0] === fn);
  if (!all[nth]) throw new Error(`the recording has no ${object} ${fn} #${nth}`);
  return all[nth];
}

const MAP = [
  '14.14.1.6.1 Go+         -> /lp/screen/1/take   # Take S1',
  '14.14.1.6.1 FaderMaster -> tbar S1',
  '14.14.1.6.2 Go+         -> /lp/screen/1/cut',
].join('\n');

before(async () => {
  if (SKIP) return;
  app = await startApp();
  link = await Link.open(app);
  guard = await guardScreen(link, 'S1');
  udp = dgram.createSocket('udp4');
  link.send({ path: sag('S1', 'control', 'takeUpTime'), value: 5 });
  link.send({ path: sag('S1', 'control', 'takeDownTime'), value: 5 });
  await link.waitFor(sag('S1', 'control', 'takeDownTime'), 5);

  for (let tries = 0; tries < 5; tries++) {
    port = pickPort();
    await app.configure({ plugins: { 'osc-input': { settings: { oscEnabled: true, oscPort: port, oscBind: '127.0.0.1' } } } });
    const s = await until(async () => { const o = await osc(); return (o.listening || o.lastError) && o; });
    if (s && s.listening && s.port === port) break;
    port = null;
  }
  if (!port) throw new Error('the OSC listener would not start on any port tried');
  await app.configure({ plugins: { grandma3: { enabled: true, settings: { grandma3Drive: true, grandma3Map: MAP } } } });
});

after(async () => {
  try { if (guard) await guard.restore(); }
  finally {
    udp?.close();
    link?.close();
    await app?.close();
  }
});

async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(40);
  }
  return null;
}

const osc = async () => (await app.api('/osc/state')).json;
const ma = async () => (await app.api('/grandma3/state')).json;
const heardCount = (s, object, fn) => s.heard.find((h) => h.object === object && h.fn === fn)?.count ?? 0;

/** Send one recorded packet and wait until the plugin has heard it. */
async function play(m) {
  const object = m.address.slice('/ma3/'.length);
  const was = heardCount(await ma(), object, m.args[0]);
  await new Promise((resolve, reject) =>
    udp.send(Buffer.from(m.hex, 'hex'), port, '127.0.0.1', (err) => (err ? reject(err) : resolve())));
  assert.ok(await until(async () => heardCount(await ma(), object, m.args[0]) > was), `the plugin heard ${object} ${m.args[0]}`);
}

const flipped = (from) => (from === 'AT_UP' ? 'AT_DOWN' : 'AT_UP');

/* ---------------------------------------------------------------- tests */

test('the plugin is on and reads its lines', { skip: SKIP }, async () => {
  const s = await ma();
  assert.equal(s.drive, true);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.rules.map((r) => r.key), ['14.14.1.6.1 Go+', '14.14.1.6.1 FaderMaster', '14.14.1.6.2 Go+']);
});

test('the desk’s Go+ takes S1; its Go−, with no line, is heard and sends nothing', { skip: SKIP }, async () => {
  const from = await settled(link);
  await play(recorded('14.14.1.6.1', 'Go+'));
  await link.waitFor(sag('S1', 'status', 'transition'), flipped(from), { timeout: 6000 });
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), flipped(from));

  const mark = link.mark();
  await play(recorded('14.14.1.6.1', 'Go-'));
  await sleep(1200);
  assert.equal(link.since(mark, sag('S1', 'control', 'xTake')).length, 0);
  const s = await ma();
  const goMinus = s.heard.find((h) => h.fn === 'Go-');
  assert.equal(goMinus.mapped, false);
  assert.equal(goMinus.cue, 'Take S1 2 Cue');
});

test('the desk’s fader as a T-bar: up is a take, back down is the next', { skip: SKIP }, async () => {
  const side = await settled(link);
  const faders = fixture.messages.filter((m) => m.args[0] === 'FaderMaster');
  assert.deepEqual(faders.map((m) => m.args[2]), [0, 25.5, 100, 100, 0], 'the recording is a throw up and back');

  /* Where it rests, then a stroke to the top. */
  await play(faders[0]);
  await sleep(200);
  await play(faders[1]);
  await sleep(200);
  await play(faders[2]);
  await link.waitFor(sag('S1', 'status', 'transition'), flipped(side), { timeout: 15000 });

  /* And the throw back. */
  await sleep(300);
  await play(faders[3]);
  await sleep(200);
  await play(faders[4]);
  await link.waitFor(sag('S1', 'status', 'transition'), side, { timeout: 15000 });

  const takes = await until(async () => {
    const h = (await ma()).history.filter((e) => /T-bar take on S1/.test(e.note || ''));
    return h.length >= 2 && h;
  });
  assert.equal(takes?.length, 2, 'both strokes are in the history');
});

test('a second executor’s Go+ cuts S1', { skip: SKIP }, async () => {
  const from = await settled(link);
  await play(recorded('14.14.1.6.2', 'Go+'));
  await link.waitFor(sag('S1', 'status', 'transition'), flipped(from), { timeout: 3000 });
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), flipped(from));
});

test('a line saved mid-show: Flash puts preview layer 1 at half, its release sends nothing', { skip: SKIP }, async () => {
  await settled(link);
  const pv = bankLetter(link.store, 'S1', 'PREVIEW').letter;
  const opacity = layerPath('S1', pv, 1, 'opacity', 'pp', 'opacity');
  link.send({ path: opacity, value: 256 });
  await link.waitFor(opacity, 256);

  await app.configure({ plugins: { grandma3: { settings: {
    grandma3Map: `${MAP}\n14.14.1.6.1 Flash -> /lp/screen/1/preset/${pv.toLowerCase()}/layer/1/opacity/opacity/norm 0.5`,
  } } } });
  assert.ok(await until(async () => (await ma()).rules.length === 4), 'the new line is read');

  await play(recorded('14.14.1.6.1', 'Flash', 0));
  await link.waitFor(opacity, 128, { timeout: 3000 });

  const mark = link.mark();
  await play(recorded('14.14.1.6.1', 'Flash', 1));
  await sleep(1000);
  assert.equal(link.since(mark, opacity).length, 0, 'the release wrote nothing');
  assert.equal(await awjGet(opacity), 128);
});

test('with driving off, the Go+ is heard and the switcher is left alone', { skip: SKIP }, async () => {
  await app.configure({ plugins: { grandma3: { settings: { grandma3Drive: false } } } });
  assert.ok(await until(async () => (await ma()).drive === false));
  const from = await settled(link);
  const mark = link.mark();
  await play(recorded('14.14.1.6.1', 'Go+'));
  await sleep(1500);
  assert.equal(link.since(mark, sag('S1', 'control', 'xTake')).length, 0);
  assert.equal(await awjGet(sag('S1', 'status', 'transition')), from);
});
