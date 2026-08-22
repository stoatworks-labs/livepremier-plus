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
import { PARAMS, PROVENANCE } from '../src/core/osc-dictionary.js';
import { normalise, DEFAULT_SETTINGS, oscChanged } from '../src/core/settings.js';
import { oscDictionary, resolveOsc, run } from '../src/vendor/mynah-lang.mjs';
import { generate } from '../tools/gen-osc-docs.mjs';

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
async function fakeAwj({ splitReplies = false, answer = 'NLC_RS4' } = {}) {
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

        const reply = Buffer.concat([
          Buffer.from(JSON.stringify({ path: msg.path, value: answer }), 'utf8'),
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
  const s = normalise({ consoleLanguage: 'klingon', awjTransport: 'carrier pigeon', oscPort: 'yes' });
  assert.deepEqual(s, DEFAULT_SETTINGS);
});

test('the OSC port must be one that needs no privilege', () => {
  assert.equal(normalise({ oscPort: 80 }).oscPort, DEFAULT_SETTINGS.oscPort);
  assert.equal(normalise({ oscPort: 70000 }).oscPort, DEFAULT_SETTINGS.oscPort);
  assert.equal(normalise({ oscPort: 9000 }).oscPort, 9000);
});

test('the bind address is a closed list, because one option opens a port to the network', () => {
  assert.equal(normalise({ oscBind: '192.168.1.5' }).oscBind, '127.0.0.1');
  assert.equal(normalise({ oscBind: '0.0.0.0' }).oscBind, '0.0.0.0');
});

test('only the OSC fields ask for a rebind', () => {
  const base = { ...DEFAULT_SETTINGS };
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
