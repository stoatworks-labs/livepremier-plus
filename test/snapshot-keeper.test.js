/*
 * The snapshot keeper: source thumbnails answered in time when the switcher
 * is a slow link away, the bookkeeping on its own and through the proxy.
 *
 * The slow switcher here is a pretend one that holds its answer back; the
 * real case it stands in for is an Aquilon C mini over a 400 KB/s link, where
 * the vendor's one-second swap cut off every load (docs/NOTES.md, 2026-10-31).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKeeper, keyOf, fetchFrame, KEPT_SNAPSHOT, DEFAULTS } from '../server/snapshot-keeper.js';
import { createRelay } from '../plugins/snapshot-relay/relay.js';
import { createProxy } from '../server/proxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A frame as the keeper sees one: a picture, numbered so tests can tell them apart. */
const picture = (n) => ({ status: 200, type: 'image/png', lastModified: `frame ${n}`, body: Buffer.from(`png:${n}`) });

/** A switcher whose answers the test releases by hand. */
function gated() {
  const waiting = [];
  let n = 0;
  return {
    calls: () => n,
    fetch: () => { n++; return new Promise((resolve, reject) => waiting.push({ resolve, reject })); },
    answer(r) { waiting.shift().resolve(r); },
    fail(err) { waiting.shift().reject(err); },
    pending: () => waiting.length
  };
}

test('only the thumbnails the vendor polls are kept — never a still or a library image', () => {
  for (const p of ['inputs/1', 'outputs/12', 'multiviewers/2', 'timers/4']) {
    assert.ok(KEPT_SNAPSHOT.test(`/api/device/snapshots/${p}`), p);
  }
  for (const p of ['images/3', 'images_library/7', 'inputs', 'inputs/1/2', 'inputs/x']) {
    assert.ok(!KEPT_SNAPSHOT.test(`/api/device/snapshots/${p}`), p);
  }
});

test('a quick switcher is asked every time, and a second page inside shareMs rides on the first', async () => {
  let t = 1000;
  let n = 0;
  const keeper = createKeeper({ now: () => t });
  const fetch = async () => picture(++n);

  const a = await keeper.get('k', fetch);
  assert.equal(a.via, 'fresh');
  assert.equal(a.body.toString(), 'png:1');
  assert.equal(a.at, undefined, 'the bookkeeping stays in here');

  t += DEFAULTS.shareMs - 100;
  const b = await keeper.get('k', fetch);
  assert.equal(b.via, 'shared');
  assert.equal(n, 1);

  t += 1000;
  const c = await keeper.get('k', fetch);
  assert.equal(c.via, 'fresh');
  assert.equal(c.body.toString(), 'png:2');
});

test('a slow switcher is not waited on past waitMs when there is a frame to give', async () => {
  let t = 1000;
  const sw = gated();
  const keeper = createKeeper({ now: () => t, waitMs: 50 });

  /* The first picture has nothing to stand in for it: that ask waits, however long. */
  const first = keeper.get('k', sw.fetch);
  await sleep(120);
  sw.answer(picture(1));
  assert.equal((await first).via, 'fresh');

  /* A second later the switcher is slow: the page gets frame 1 in time. */
  t += 1000;
  const second = await keeper.get('k', sw.fetch);
  assert.equal(second.via, 'kept');
  assert.equal(second.body.toString(), 'png:1');
  assert.equal(sw.pending(), 1, 'answered while the switcher still has it: the fetch carries on');

  /* Pages that ask while it is on its way join it rather than start another. */
  t += 1000;
  assert.equal((await keeper.get('k', sw.fetch)).via, 'kept');
  assert.equal(sw.calls(), 2);

  /* It lands, and the next page has it without asking the switcher again. */
  sw.answer(picture(2));
  await sleep(0);
  t += 100;
  const third = await keeper.get('k', sw.fetch);
  assert.equal(third.via, 'shared');
  assert.equal(third.body.toString(), 'png:2');
  assert.equal(sw.calls(), 2);
});

test('the switcher answering in time beats the kept frame', async () => {
  let t = 1000;
  let n = 0;
  const keeper = createKeeper({ now: () => t, waitMs: 200 });
  const slowish = async () => { await sleep(20); return picture(++n); };
  await keeper.get('k', slowish);
  t += 1000;
  const r = await keeper.get('k', slowish);
  assert.equal(r.via, 'fresh');
  assert.equal(r.body.toString(), 'png:2');
});

test('a failed fetch, an answer that is not a picture, or an old frame is never offered', async () => {
  let t = 1000;
  const sw = gated();
  const keeper = createKeeper({ now: () => t, waitMs: 30, staleMs: 10_000 });

  const first = keeper.get('k', sw.fetch);
  sw.answer(picture(1));
  await first;

  /* The switcher stops answering: the kept frame covers the wait, then the
     fetch fails, and the next page waits on the switcher instead. */
  t += 1000;
  assert.equal((await keeper.get('k', sw.fetch)).via, 'kept');
  sw.fail(new Error('ECONNRESET'));
  await sleep(0);
  t += 1000;
  const after = keeper.get('k', sw.fetch);
  sw.fail(new Error('ECONNREFUSED'));
  await assert.rejects(after, /ECONNREFUSED/);

  /* A 404 — an input taken out in Preconfig — goes to the page as it came,
     and leaves nothing to stand in for the source. */
  t += 1000;
  const fine = keeper.get('k', sw.fetch);
  sw.answer(picture(2));
  await fine;
  t += 1000;
  const gone = keeper.get('k', sw.fetch);
  await sleep(60);
  assert.equal(sw.pending(), 1, 'frame 2 covered the wait');
  sw.answer({ status: 404, type: 'text/plain', body: Buffer.from('nope') });
  assert.equal((await gone).via, 'kept');
  await sleep(0);
  t += 1000;
  const next = keeper.get('k', sw.fetch);
  sw.answer({ status: 404, type: 'text/plain', body: Buffer.from('nope') });
  const r = await next;
  assert.equal(r.status, 404);
  assert.equal(r.body.toString(), 'nope');

  /* A frame past staleMs is not offered, however slow the switcher. */
  t += 1000;
  const back = keeper.get('k', sw.fetch);
  sw.answer(picture(3));
  await back;
  t += 20_000;
  const late = keeper.get('k', sw.fetch);
  await sleep(60);
  sw.answer(picture(4));
  assert.equal((await late).body.toString(), 'png:4', 'waited for the switcher');
});

test('one browser’s frames are not another’s: the key carries the session', () => {
  const a = keyOf('10.0.0.5:80', '/api/device/snapshots/inputs/1', { cookie: 'sid=a' });
  const b = keyOf('10.0.0.5:80', '/api/device/snapshots/inputs/1', { cookie: 'sid=b' });
  const other = keyOf('10.0.0.6:80', '/api/device/snapshots/inputs/1', { cookie: 'sid=a' });
  assert.notEqual(a, b);
  assert.notEqual(a, other);
  assert.equal(a, keyOf('10.0.0.5:80', '/api/device/snapshots/inputs/1', { cookie: 'sid=a', 'user-agent': 'x' }));
});

test('the relay holds its last frame for a slow switcher too, and drops it when the switcher fails', async () => {
  let t = 1000;
  const sw = gated();
  const fetch = () => sw.fetch().then((r) => ({ status: r.status, headers: { 'content-type': r.type }, body: r.body }));
  const relay = createRelay({ fetch, transcode: async () => null, settings: () => ({ maxAgeMs: 300 }), now: () => t, waitMs: 30 });
  /* The relay only keeps what it can tell is a PNG. */
  const png = (n) => ({ ...picture(n), body: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`${n}`)]) });

  const first = relay.get('/api/device/snapshots/inputs/1');
  sw.answer(png(1));
  assert.equal((await first).via, 'fresh');

  t += 1000;
  const slow = await relay.get('/api/device/snapshots/inputs/1');
  assert.equal(slow.via, 'kept');
  assert.equal(relay.stats().kept, 1);
  sw.fail(new Error('ETIMEDOUT'));
  await sleep(0);

  t += 1000;
  const after = relay.get('/api/device/snapshots/inputs/1');
  sw.fail(new Error('ECONNREFUSED'));
  await assert.rejects(after, /ECONNREFUSED/);
  assert.equal(relay.stats().errors, 2);
});

/* ------------------------------------------------------------ the proxy */

/** A switcher that answers its first thumbnail at once and every later one after `slowMs`. */
function slowSwitcher(slowMs) {
  const seen = [];
  const sent = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    if (/^\/api\/device\/snapshots\/(inputs|images)\/1(\?|$)/.test(req.url)) {
      const k = ++n;
      const body = Buffer.from(`png:${k}`);
      const send = () => {
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'last-modified': `frame ${k}` });
        res.end(body);
        sent.push(k);
      };
      return k === 1 ? send() : setTimeout(send, slowMs);
    }
    res.writeHead(404, { 'content-type': 'text/plain' }).end('nope');
  });
  return { server, seen, sent };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const close = (s) => new Promise((r) => { s.closeAllConnections?.(); s.close(r); });

test('a kept-alive socket the switcher hangs up on is tried once more on a fresh one; a fresh one is not', async () => {
  /* Hangs up on the second request of every connection without answering:
     what a socket closed at the switcher's keep-alive timeout looks like from
     this end, once a slow link has let the next request overtake the close. */
  let sockets = 0;
  let hangUpAll = false;
  const server = http.createServer((req, res) => {
    const s = req.socket;
    s.asked = (s.asked || 0) + 1;
    if (hangUpAll || s.asked > 1) return s.destroy();
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': 5 }).end('png:1');
  });
  server.on('connection', () => sockets++);
  const port = await listen(server);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const ask = () => fetchFrame({
    target: { host: '127.0.0.1', port }, hostHeader: `127.0.0.1:${port}`,
    path: '/api/device/snapshots/inputs/1', headers: {}, agent
  });
  try {
    assert.equal((await ask()).body.toString(), 'png:1');
    assert.equal((await ask()).body.toString(), 'png:1', 'the reset on the reused socket was not passed on');
    assert.equal(sockets, 2, 'the second try had a socket of its own');

    agent.destroy();
    hangUpAll = true;
    await assert.rejects(ask(), (err) => err.code === 'ECONNRESET');
    assert.equal(sockets, 3, 'a reset on a fresh socket is the link, and not tried again');
  } finally {
    agent.destroy();
    await close(server);
  }
});

test('through the proxy: a slow switcher’s thumbnail arrives inside the vendor’s second', async () => {
  const sw = slowSwitcher(1500);
  const devicePort = await listen(sw.server);
  const storage = { loadSettings: async () => ({}), saveSettings: async () => {} };
  const proxy = await createProxy({ device: `127.0.0.1:${devicePort}`, root: ROOT, storage, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  try {
    let res = await fetch(`${base}/api/device/snapshots/inputs/1?1`);
    assert.equal(res.headers.get('x-lpp-snapshot'), 'fresh');
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('last-modified'), 'frame 1');
    assert.equal(await res.text(), 'png:1');

    /* The vendor's next ask: the switcher now takes 1.5 s, and the page has
       its answer while the switcher is still sitting on frame 2. Order, not a
       stopwatch: a test process the OS runs in the background can be woken a
       second late. */
    await sleep(DEFAULTS.shareMs + 50);
    res = await fetch(`${base}/api/device/snapshots/inputs/1?2`);
    assert.deepEqual(sw.sent, [1], 'answered before the switcher was');
    assert.equal(res.headers.get('x-lpp-snapshot'), 'kept');
    assert.equal(await res.text(), 'png:1');

    /* The fetch it started lands, and a page after has the new frame —
       shared if it asks inside shareMs of the landing, kept if the OS woke
       this process late enough for the ask to start a third. */
    while (sw.sent.length < 2) await sleep(50);
    let body = null;
    let via = null;
    for (let k = 3; k < 13 && body !== 'png:2'; k++) {
      await sleep(20);
      res = await fetch(`${base}/api/device/snapshots/inputs/1?${k}`);
      via = res.headers.get('x-lpp-snapshot');
      body = await res.text();
    }
    assert.equal(body, 'png:2');
    assert.ok(via === 'shared' || via === 'kept', via);

    /* A still is drawn once per version: straight to the switcher, as before. */
    res = await fetch(`${base}/api/device/snapshots/images/1?v=abc`);
    assert.equal(res.headers.get('x-lpp-snapshot'), null);
    await res.text();
    /* And a missing source stays missing. */
    res = await fetch(`${base}/api/device/snapshots/inputs/9?1`);
    assert.equal(res.status, 404);
    assert.equal(await res.text(), 'nope');
  } finally {
    await close(proxy);
    await close(sw.server);
  }
});

test('through the proxy: pointed at another switcher, nothing of the first is served', async () => {
  const a = slowSwitcher(5000);
  const b = slowSwitcher(0);
  const portA = await listen(a.server);
  const portB = await listen(b.server);
  const storage = { loadSettings: async () => ({}), saveSettings: async () => {}, saveDevice: async () => {} };
  const proxy = await createProxy({ device: `127.0.0.1:${portA}`, root: ROOT, storage, log: () => {} });
  const port = await listen(proxy);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await (await fetch(`${base}/api/device/snapshots/inputs/1?1`)).text(), 'png:1');
    const moved = await fetch(`${base}/__lpp/device`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: `127.0.0.1:${portB}` })
    });
    assert.equal(moved.status, 200);
    await sleep(DEFAULTS.shareMs + 50);
    const res = await fetch(`${base}/api/device/snapshots/inputs/1?2`);
    assert.equal(res.headers.get('x-lpp-snapshot'), 'fresh');
    assert.equal(await res.text(), 'png:1', 'the second switcher’s own first frame');
    assert.equal(b.seen.length, 1);
  } finally {
    await close(proxy);
    await close(a.server);
    await close(b.server);
  }
});
