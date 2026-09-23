/*
 * OSC in, AWJ out, and the document that describes both.
 *
 * Same discipline as `proxy.test.js`: the socket tests run against a real
 * stand-in on a real port rather than a mock. Everything worth catching here
 * lives in the plumbing — datagram framing, the 0x04 terminator, a reply that
 * straddles a read boundary, a UDP socket that keeps the process alive — and a
 * mocked `net.connect` would simply agree with whatever the code did.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decode, createOscServer } from '../server/osc.js';
import { exchange } from '../server/awj.js';
import { PARAMS, PROVENANCE, paramsFor } from '../src/core/osc-dictionary.js';
import { normalise, DEFAULT_SETTINGS, normaliseOsc, OSC_DEFAULTS, oscChanged } from '../src/core/settings.js';
import { oscDictionary, resolveOsc, run, MIDRA } from '../src/vendor/mynah-lang.mjs';
import { generate, PLUGIN_OSC } from '../tools/gen-osc-docs.mjs';
import { MATRIX_OSC, resolveMatrixOsc } from '../src/core/patch.js';
import { HYPERDECK_OSC, parseDeckOsc } from '../plugins/hyperdeck/core.js';
import { COMMAND_NAMES } from '../plugins/hyperdeck/protocol.js';

const here = dirname(fileURLToPath(import.meta.url));
const EOT = 0x04;

/* ------------------------------------------------------- an OSC encoder */

/*
 * Written here rather than imported, on purpose. `server/osc.js` only decodes;
 * a test that encoded with the same code it decodes with would pass on a
 * shared misunderstanding of the padding rule, which is the one part of OSC
 * framing that is easy to get wrong in both directions at once.
 */
const pad = (n) => (n + 3) & ~3;
function ostr(s) {
  const b = Buffer.alloc(pad(s.length + 1));
  b.write(s, 'utf8');
  return b;
}
const oint = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const oflt = (n) => { const b = Buffer.alloc(4); b.writeFloatBE(n); return b; };
const omsg = (addr, tags = '', ...args) =>
  tags === ''
    ? ostr(addr)
    : Buffer.concat([ostr(addr), ostr(`,${tags}`), ...args]);

function obundle(...elements) {
  const parts = [ostr('#bundle'), Buffer.alloc(8)];
  for (const e of elements) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(e.length);
    parts.push(size, e);
  }
  return Buffer.concat(parts);
}

/** Wait for something on the other end of a socket to have happened. */
async function until(cond, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/* ------------------------------------------------------ a stand-in device */

/**
 * A TCP server that speaks just enough AWJ to be argued with.
 *
 * It records every message it is sent, answers a `get` with a canned value,
 * and says nothing at all to a `replace` — which is what the real device does,
 * and the thing most likely to be got wrong by anything waiting for an
 * acknowledgement that is never coming.
 */
async function fakeAwj({ splitReplies = false, answer = 'NLC_RS4', answers = null } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let i;
      while ((i = buffer.indexOf(EOT)) !== -1) {
        const frame = buffer.subarray(0, i);
        buffer = buffer.subarray(i + 1);
        let msg;
        try { msg = JSON.parse(frame.toString('utf8')); } catch { continue; }
        received.push(msg);
        if (msg.op !== 'get') continue;

        /* `answers(path)` says what this pretend device has. A path it does
           not have is answered the way the real one answers: an empty path
           and a null value — seen on both simulators on 2026-09-12. */
        const value = answers ? answers(msg.path) : answer;
        const reply = Buffer.concat([
          Buffer.from(JSON.stringify(value === undefined ? { path: '', value: null } : { path: msg.path, value }), 'utf8'),
          Buffer.from([EOT]),
        ]);
        if (splitReplies) {
          /* Deliberately across two writes, mid-JSON. A reader that parses per
             chunk rather than per 0x04 frame passes every other test and fails
             this one. */
          const at = Math.floor(reply.length / 2);
          socket.write(reply.subarray(0, at));
          setTimeout(() => socket.write(reply.subarray(at)), 10);
        } else {
          socket.write(reply);
        }
      }
    });
    socket.on('error', () => {});
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    received,
    close: () => new Promise((r) => server.close(r)),
  };
}

/* ========================================================== the OSC wire == */

test('decodes the OSC types a surface actually sends', () => {
  assert.deepEqual(decode(omsg('/lp/screen/1/take', 'i', oint(1))),
    [{ address: '/lp/screen/1/take', args: [1] }]);
  assert.deepEqual(decode(omsg('/lp/screen/1/take', 'f', oflt(0.5))),
    [{ address: '/lp/screen/1/take', args: [0.5] }]);
  assert.deepEqual(decode(omsg('/lp/screen/1/memory/5/label', 's', ostr('Act One Top'))),
    [{ address: '/lp/screen/1/memory/5/label', args: ['Act One Top'] }]);
  assert.deepEqual(decode(omsg('/lp/screen/1/take', 'T')),
    [{ address: '/lp/screen/1/take', args: [true] }]);
  assert.deepEqual(decode(omsg('/lp/screen/1/take', 'F')),
    [{ address: '/lp/screen/1/take', args: [false] }]);
  /* Impulse is a bang with no value. A sender that emits one means a press. */
  assert.deepEqual(decode(omsg('/lp/screen/1/take', 'I')),
    [{ address: '/lp/screen/1/take', args: [1] }]);
});

test('a message with no type tag at all is one with no arguments', () => {
  /* OSC 1.0 makes the type tag optional and some senders omit it. Read as a
     bare trigger, which is what it means. */
  assert.deepEqual(decode(ostr('/lp/screen/1/take')),
    [{ address: '/lp/screen/1/take', args: [] }]);
});

test('unpacks a bundle, because senders emit them routinely', () => {
  const packet = obundle(
    omsg('/lp/screen/1/take', 'i', oint(1)),
    omsg('/lp/screen/2/take', 'i', oint(1)),
  );
  assert.deepEqual(decode(packet).map((m) => m.address),
    ['/lp/screen/1/take', '/lp/screen/2/take']);
});

test('one unreadable element does not lose the rest of a bundle', () => {
  const bad = Buffer.from('not osc at all\0\0');
  const packet = obundle(bad, omsg('/lp/screen/2/take', 'i', oint(1)));
  assert.deepEqual(decode(packet).map((m) => m.address), ['/lp/screen/2/take']);
});

test('refuses a packet that is not OSC rather than guessing at it', () => {
  assert.throws(() => decode(Buffer.from('ab')), /too short/);
  assert.throws(() => decode(ostr('no-leading-slash')), /starts with \//);
});

/* ====================================================== the address space == */

test('resolves an address from typed arguments, not from rendered text', () => {
  /* The reason it must: rendering back to text and re-parsing would split a
     label at its spaces and turn a whole float into an int. */
  const r = resolveOsc(
    { address: '/lp/screen/1/memory/5/label', args: ['Act One Top'] },
    { params: PARAMS },
  );
  assert.equal(r.ok, true);
  assert.equal(r.ops[0].value, 'Act One Top');
});

test('the catalogue widens the space past what mynah alone answers', () => {
  const wide = resolveOsc(
    { address: '/lp/screen/1/preset/a/layer/2/cropping/classic/left', args: [100] },
    { params: PARAMS },
  );
  assert.equal(wide.ok, true);
  assert.equal(
    wide.ops[0].path.toAwj(),
    'DeviceObject/$screen/@items/S1/$preset/@items/A/$layer/@items/2/cropping/classic/@props/left',
  );

  /* And the same address against the built-in table alone is not there — which
     is what makes this a widening rather than a coincidence. */
  const narrow = resolveOsc(
    { address: '/lp/screen/1/preset/a/layer/2/cropping/classic/left', args: [100] },
  );
  assert.equal(narrow.ok, false);
});

test('a read-only parameter is refused by name, not as an unknown address', () => {
  const r = resolveOsc(
    { address: '/lp/screen/1/preset/a/layer/1/source/status/inputNum', args: ['LIVE_1'] },
    { params: PARAMS },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /read-only/);
});

test('over UDP, preview and program are refused with the reason', () => {
  /* No store mirror in this process, so the take state is unknown — and a
     layer move that landed in whichever buffer happened to be live is exactly
     the failure the rule exists to prevent. */
  const r = resolveOsc(
    { address: '/lp/screen/1/preset/program/layer/1/opacity/opacity', args: [128] },
    { params: PARAMS },
  );
  assert.equal(r.ok, false);
  assert.match(r.errors[0].message, /take state/);
  assert.match(r.errors[0].message, /\/a, \/b or \/c/);
});

/* ============================================================ AWJ on TCP == */

test('a get is answered, and a replace is met with silence', async () => {
  const device = await fakeAwj();
  try {
    const replies = await exchange({
      host: '127.0.0.1',
      port: device.port,
      messages: [{ op: 'get', path: 'DeviceObject/system/$device/@items/1/@props/dev' }],
    });
    assert.deepEqual(replies, [
      { path: 'DeviceObject/system/$device/@items/1/@props/dev', value: 'NLC_RS4' },
    ]);

    /* The important half: this must return promptly rather than sit waiting
       for an acknowledgement the protocol never sends. */
    const none = await exchange({
      host: '127.0.0.1',
      port: device.port,
      messages: [{ op: 'replace', path: 'DeviceObject/a/@props/b', value: true }],
    });
    assert.deepEqual(none, []);
  } finally {
    await device.close();
  }
});

test('a reply split across two reads is still one reply', async () => {
  const device = await fakeAwj({ splitReplies: true });
  try {
    const replies = await exchange({
      host: '127.0.0.1',
      port: device.port,
      messages: [{ op: 'get', path: 'DeviceObject/system/$device/@items/1/@props/dev' }],
    });
    assert.equal(replies.length, 1);
    assert.equal(replies[0].value, 'NLC_RS4');
  } finally {
    await device.close();
  }
});

test('every message is terminated by 0x04, not by a newline', async () => {
  const device = await fakeAwj();
  try {
    await exchange({
      host: '127.0.0.1',
      port: device.port,
      messages: [
        { op: 'replace', path: 'DeviceObject/a/@props/b', value: 1 },
        { op: 'replace', path: 'DeviceObject/a/@props/c', value: 2 },
      ],
    });
    /* `exchange` resolves once the bytes have flushed out of this process; the
       stand-in reads them on its own turn of the loop. Waiting for the count
       rather than asserting straight away is the difference between testing
       the framing and testing the scheduler. */
    await until(() => device.received.length === 2);

    /* The stand-in splits on 0x04 and on nothing else, so two messages arriving
       as two is the assertion. */
    assert.equal(device.received.length, 2);
    assert.deepEqual(device.received[1], { op: 'replace', path: 'DeviceObject/a/@props/c', value: 2 });
  } finally {
    await device.close();
  }
});

test('a device that is not there fails with something worth reading', async () => {
  await assert.rejects(
    exchange({ host: '127.0.0.1', port: 1, messages: [{ op: 'get', path: 'DeviceObject/a/@props/b' }] }),
    /127\.0\.0\.1:1/,
  );
});

/* ================================================= OSC in, AWJ out, end to end */

test('a UDP take reaches the switcher as an AWJ write', async () => {
  const device = await fakeAwj();
  let entry = null;
  let resolveEntry;
  const heard = new Promise((r) => { resolveEntry = r; });

  const osc = createOscServer({
    port: 0,
    address: '127.0.0.1',
    deviceHost: () => '127.0.0.1',
    onActivity: (e) => { entry = e; resolveEntry(e); },
  });
  await osc.start();

  /* Port 0 binds an ephemeral one, and `state.port` reports the port actually
     bound rather than the one asked for. */
  const bound = osc.state.port;
  assert.ok(bound > 0, 'the listener did not report the port it bound');

  try {
    /* The AWJ port is fixed at 10606 in `awj.js`, so the end-to-end path is
       exercised through `exchange` directly above; here the assertion is that
       the datagram resolved to the right write and was attempted. */
    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.send(omsg('/lp/screen/1/take', 'i', oint(1)), bound, '127.0.0.1', () => { client.close(); r(); }));
    await Promise.race([heard, new Promise((_, rej) => setTimeout(() => rej(new Error('nothing heard')), 3000))]);

    assert.equal(entry.address, '/lp/screen/1/take');
    /* Either it reached the device, or it failed trying — both prove the
       message resolved to a write rather than being refused as an address. */
    assert.ok(entry.error === undefined || /10606|ECONN|no answer/.test(entry.error),
      `unexpected refusal: ${entry.error}`);
  } finally {
    await osc.stop();
    await device.close();
  }
});

/*
 * The listener holds no store, so it asks the switcher which platform it is
 * before spelling anything for it: a LivePremier answers the per-frame `dev`,
 * a Midra or Alta answers `platformLabel`, and each answers the other's path
 * with a null frame. Two pretend devices, one per family.
 */
async function udpThrough(device, address) {
  const entries = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const osc = createOscServer({
    port: 0,
    address: '127.0.0.1',
    deviceHost: () => '127.0.0.1',
    awjPort: device.port,
    onActivity: (e) => { entries.push(e); resolveDone(e); },
  });
  await osc.start();
  try {
    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.send(omsg(address, 'i', oint(1)), osc.state.port, '127.0.0.1', () => { client.close(); r(); }));
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('nothing heard')), 3000))]);
    /* The write is flushed before the entry is logged, but the pretend device
       reads it on its own socket a tick later. */
    if (!entries[0].error) await until(() => device.received.some((m) => m.op === 'replace'), 1000).catch(() => {});
    return { entry: entries[0], platform: osc.state.platform, writes: device.received.filter((m) => m.op === 'replace') };
  } finally {
    await osc.stop();
  }
}

test('a switcher that names its platform gets Midra addresses', async () => {
  const device = await fakeAwj({
    answers: (path) => (path.endsWith('@props/platformLabel') ? 'Midra 4K' : undefined),
  });
  try {
    const { entry, platform, writes } = await udpThrough(device, '/lp/screen/1/take');
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(platform, 'Midra 4K / Alta 4K');
    assert.deepEqual(writes.map((w) => w.path), ['DeviceObject/transition/$screen/@items/1/control/@props/xTake']);
  } finally {
    await device.close();
  }
});

test('given an exchange, the listener talks through it and opens nothing of its own', async () => {
  /* How the OSC input plugin runs it: with `ctx.awj`, which knows how the app
     reaches the switcher. Everything the listener says to the device goes
     through the function handed in, and nothing else is dialled. */
  const said = [];
  const awj = async (messages) => {
    said.push(...messages);
    return messages.map((m) => (m.op === 'get' && m.path.endsWith('$device/@items/1/@props/dev')
      ? { path: m.path, value: 'NLC_C' }
      : { path: m.op === 'get' ? '' : m.path, value: null }));
  };
  const entries = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const osc = createOscServer({
    port: 0, address: '127.0.0.1',
    deviceHost: () => 'switcher.example:80',
    awj,
    onActivity: (e) => { entries.push(e); resolveDone(e); }
  });
  await osc.start();
  try {
    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.send(omsg('/lp/screen/1/take', 'i', oint(1)), osc.state.port, '127.0.0.1', () => { client.close(); r(); }));
    await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(new Error('nothing heard')), 3000))]);
    assert.equal(entries[0].error, undefined, entries[0].error);
    assert.equal(osc.state.platform, 'LivePremier');
    assert.ok(said.some((m) => m.op === 'replace' && m.path.endsWith('xTake')), 'the take went through the exchange');
  } finally {
    await osc.stop();
  }
});

test('a switcher with a device list gets LivePremier addresses', async () => {
  const device = await fakeAwj({
    answers: (path) => (path.endsWith('$device/@items/1/@props/dev') ? 'NLC_C' : undefined),
  });
  try {
    const { entry, platform, writes } = await udpThrough(device, '/lp/screen/1/take');
    assert.equal(entry.error, undefined, entry.error);
    assert.equal(platform, 'LivePremier');
    assert.deepEqual(writes.map((w) => w.path), ['DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake']);
  } finally {
    await device.close();
  }
});

test('a switcher that answers neither identity path gets nothing sent, with the reason', async () => {
  const device = await fakeAwj({ answers: () => undefined });
  try {
    const { entry, writes } = await udpThrough(device, '/lp/screen/1/take');
    assert.match(entry.error, /neither identity path/);
    assert.equal(writes.length, 0);
  } finally {
    await device.close();
  }
});

test('a button release is logged and sends nothing', async () => {
  let entry = null;
  let resolveEntry;
  const heard = new Promise((r) => { resolveEntry = r; });

  const osc = createOscServer({
    port: 0,
    address: '127.0.0.1',
    deviceHost: () => '127.0.0.1',
    onActivity: (e) => { entry = e; resolveEntry(e); },
  });
  await osc.start();
  try {
    const client = dgram.createSocket('udp4');
    await new Promise((r) => client.send(omsg('/lp/screen/1/take', 'i', oint(0)), osc.state.port, '127.0.0.1', () => { client.close(); r(); }));
    await Promise.race([heard, new Promise((_, rej) => setTimeout(() => rej(new Error('nothing heard')), 3000))]);

    assert.equal(entry.writes, 0);
    assert.match(entry.summary, /released/);
    assert.equal(entry.error, undefined);
  } finally {
    await osc.stop();
  }
});

test('the listener stops cleanly, so nothing keeps the process alive', async () => {
  const osc = createOscServer({ port: 0, address: '127.0.0.1', deviceHost: () => null });
  await osc.start();
  assert.equal(osc.state.listening, true);
  await osc.stop();
  assert.equal(osc.state.listening, false);
  /* Stopping twice must not throw: `closeRelays` calls it, and so does the
     caller, and neither knows about the other. */
  await osc.stop();
});

/* ============================================================== settings == */

test('a settings file a person has edited is coerced, not rejected', () => {
  const s = normalise({ consoleLanguage: 'klingon', awjTransport: 'carrier pigeon' });
  assert.deepEqual(s, DEFAULT_SETTINGS);
  assert.deepEqual(normaliseOsc({ oscPort: 'yes', oscEnabled: 'please' }), OSC_DEFAULTS);
});

/* The OSC input plugin's settings — `plugins/osc-input/server.js` reads them
   through these, and lifts them from the top level where an older file has them. */
test('the OSC port must be one that needs no privilege', () => {
  assert.equal(normaliseOsc({ oscPort: 80 }).oscPort, OSC_DEFAULTS.oscPort);
  assert.equal(normaliseOsc({ oscPort: 70000 }).oscPort, OSC_DEFAULTS.oscPort);
  assert.equal(normaliseOsc({ oscPort: 9000 }).oscPort, 9000);
});

test('the bind address is a closed list, because one option opens a port to the network', () => {
  assert.equal(normaliseOsc({ oscBind: '192.168.1.5' }).oscBind, '127.0.0.1');
  assert.equal(normaliseOsc({ oscBind: '0.0.0.0' }).oscBind, '0.0.0.0');
});

test('only the OSC fields ask for a rebind', () => {
  const base = { ...OSC_DEFAULTS, consoleLanguage: 'all' };
  assert.equal(oscChanged(base, { ...base, consoleLanguage: 'osc' }), false);
  assert.equal(oscChanged(base, { ...base, oscPort: 9000 }), true);
  assert.equal(oscChanged(base, { ...base, oscEnabled: true }), true);
  assert.equal(oscChanged(base, { ...base, oscBind: '0.0.0.0' }), true);
});

/* ============================================================ the document */

test('docs/OSC.md is what the generator produces', async () => {
  /* The document is a promise to somebody building a TouchOSC layout, and they
     have no way to check it short of trying every address at a switcher. This
     is what stops it describing an address the resolver does not answer. */
  const onDisk = await readFile(join(here, '..', 'docs', 'OSC.md'), 'utf8');
  assert.equal(onDisk, generate(), 'run `npm run gen:osc-docs`');
});

test('every documented address is one the resolver answers', () => {
  const fill = (address) => address
    .replace('{n}', '1')
    .replace('{out}', '1')
    .replace('{slot}', '1')
    .replace('{l}', '1')
    .replace('{preview|program|a|b|c}', 'a')
    .replace('{preview|program}', 'preview');

  for (const entry of oscDictionary(PARAMS)) {
    const line = `${fill(entry.address)} ${sampleArg(entry.args)}`.trim();
    const r = run(line, { language: 'osc', osc: { params: PARAMS } });
    assert.ok(r.ok, `${entry.address}: ${r.ok ? '' : r.errors[0].message}`);
  }
  /* And the Midra tables, resolved as a Midra. */
  for (const entry of oscDictionary(paramsFor(MIDRA), MIDRA)) {
    const line = `${fill(entry.address).replace('{preview|program|up|down}', 'up')} ${sampleArg(entry.args)}`.trim();
    const r = run(line, { language: 'osc', platform: MIDRA, osc: { params: paramsFor(MIDRA) } });
    assert.ok(r.ok, `Midra ${entry.address}: ${r.ok ? '' : r.errors[0].message}`);
  }
});

test('the document says which device its parameter ranges came from', () => {
  assert.ok(PROVENANCE.device, 'the catalogue records no device');
  assert.ok(PROVENANCE.layerCount > 50, `only ${PROVENANCE.layerCount} layer parameters`);
});

function sampleArg(args) {
  if (args.startsWith('none')) return '';
  if (args === 'string') return '"x"';
  if (args.startsWith('float')) return '0.5';
  if (args.startsWith('value name')) return '0';
  if (args === 'structured value') return '1';
  const m = /(-?\d+)–(-?\d+)/.exec(args);
  return m ? m[1] : '0';
}

/*
 * A plugin's address subtree — an `oscAddress` contribution — is answered
 * before the switcher is consulted, and needs no switcher at all. A
 * contribution may decline an address, which then falls through to the
 * switcher's own grammar as if it had never been asked.
 */
test('a contributed address subtree is answered over UDP, and a declined address falls through', async () => {
  const entries = [];
  let wake = null;
  const osc = createOscServer({
    port: 0,
    address: '127.0.0.1',
    deviceHost: () => null,
    addresses: () => [{
      prefix: '/hello/',
      owner: 'hello',
      handle: (address, args) => (address === '/hello/greet'
        ? { ok: true, summary: `greeted ${args[0]}`, count: 1 }
        : null)
    }],
    onActivity: (e) => { entries.push(e); if (wake) wake(); }
  });
  await osc.start();
  const send = (buf) => new Promise((r) => {
    const client = dgram.createSocket('udp4');
    client.send(buf, osc.state.port, '127.0.0.1', () => { client.close(); r(); });
  });
  const next = () => new Promise((r, rej) => { wake = r; setTimeout(() => rej(new Error('nothing heard')), 3000); });
  try {
    let heard = next();
    await send(omsg('/hello/greet', 's', ostr('the room')));
    await heard;
    assert.equal(entries[0].summary, 'greeted the room');
    assert.equal(entries[0].error, undefined);
    assert.equal(osc.state.sent, 1);

    heard = next();
    await send(omsg('/hello/unknown', 'i', oint(1)));
    await heard;
    /* Declined: it went on to the switcher's grammar, which has no switcher. */
    assert.ok(entries[1].error, 'refused by the switcher half, not answered by the plugin');
    assert.notEqual(entries[1].summary, 'greeted 1');
  } finally {
    await osc.stop();
  }
});

/* ------------------------------------------- the plugins' own addresses */

/* A published address the handler would refuse is the failure the generated
   dictionary exists to prevent, so each plugin entry is run through the same
   parser its handler uses, with its placeholders filled in. */

test('every matrix address in the dictionary is one the resolver answers', () => {
  const patch = [
    { side: 'input', key: 'IN_5', matrix: 'hub', port: 7 },
    { side: 'output', key: '2', matrix: 'hub', port: 1 },
  ];
  const fill = { n: { input: '5', output: '2' }, router: 'hub', out: '3' };
  for (const e of MATRIX_OSC) {
    const side = e.address.includes('/input/') ? 'input' : 'output';
    const address = e.address
      .replace('{n}', fill.n[side]).replace('{router}', fill.router).replace('{out}', fill.out);
    const args = e.address.endsWith('/destinations') ? ['1-4'] : [9];
    const r = resolveMatrixOsc(address, args, patch);
    assert.ok(r && r.ok, `${e.address} → ${r && r.error}`);
  }
});

test('every HyperDeck command has a dictionary entry the parser accepts', () => {
  assert.deepEqual(HYPERDECK_OSC.map((e) => e.command).sort(), [...COMMAND_NAMES].sort(),
    'a command in protocol.js with no dictionary entry, or an entry for no command');
  for (const e of HYPERDECK_OSC) {
    const r = parseDeckOsc(e.address.replace('{deck}', 'all'), e.command === 'clip' ? [3] : []);
    assert.equal(r.error, undefined, e.address);
    assert.equal(r.step.command, e.command);
  }
});

/*
 * docs/OSC.md rule 2 holds for the plugins' subtrees too: a surface sends 1 on
 * press and 0 on release, and one press of `next` must not skip two clips.
 */
test('a HyperDeck trigger ignores its release; a value argument is still a value', () => {
  for (const e of HYPERDECK_OSC.filter((x) => x.command !== 'clip')) {
    const address = e.address.replace('{deck}', 'all');
    assert.equal(parseDeckOsc(address, [0]).released, true, `${e.address} 0`);
    assert.equal(parseDeckOsc(address, [false]).released, true, `${e.address} false`);
    assert.equal(parseDeckOsc(address, []).released, undefined, `${e.address} with no argument fires`);
  }
  assert.equal(parseDeckOsc('/hyperdeck/1/next', ['0']).released, true, 'mynah reads "0" as a release');
  assert.equal(parseDeckOsc('/hyperdeck/1/next', [1]).released, undefined);
  assert.equal(parseDeckOsc('/hyperdeck/1/play', [1]).step.loop, true, '1 still loops');
  assert.equal(parseDeckOsc('/hyperdeck/1/clip', [0]).released, undefined, 'a clip number is a value');
  assert.equal(parseDeckOsc('/hyperdeck/1/record', ['0']).step.name, '0', 'a record name "0" is a name');
});

test('plugin entries are in the dictionary shape, under their own prefix', () => {
  for (const { prefix, entries } of PLUGIN_OSC) {
    assert.ok(entries.length > 0, prefix);
    for (const e of entries) {
      assert.deepEqual(Object.keys(e).sort(), ['address', 'args', 'group', 'summary'], e.address);
      assert.ok(e.address.startsWith(prefix), `${e.address} is outside ${prefix}`);
    }
  }
});
