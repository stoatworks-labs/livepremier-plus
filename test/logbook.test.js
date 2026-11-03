/*
 * The app's log (`server/logbook.js`) and its routes in the proxy.
 *
 * What it promises a user who is asked for their logs: the lines are on disk
 * when written, the files stay small and few, nothing secret is in them, a
 * flood is counted rather than written, and a disk that cannot be written
 * costs the file, never the app.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { Logbook, scrub, redact, formatEntry, localTime } from '../server/logbook.js';
import { createProxy, buildInjection } from '../server/proxy.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const quiet = () => {};

async function scratch() {
  return mkdtemp(join(tmpdir(), 'lpp-logbook-'));
}

test('a line is on disk when write returns, debug only when asked for', async () => {
  const dir = await scratch();
  try {
    const book = new Logbook({ dir, echo: quiet });
    book.write('info', 'server', 'listening', { port: 8535 });
    book.write('debug', 'pixelhue', 'grid ping');
    const text = await readFile(join(dir, 'lpp.log'), 'utf8');
    assert.match(text, /INFO  server {2}listening \{"port":8535\}\n$/);
    assert.doesNotMatch(text, /grid ping/, 'debug stays in memory at info');
    assert.equal(book.recent().length, 2, 'but the page still sees it');

    book.setLevel('debug');
    book.write('debug', 'pixelhue', 'grid pong', { ms: 3 });
    assert.match(await readFile(join(dir, 'lpp.log'), 'utf8'), /DEBUG pixelhue {2}grid pong \{"ms":3\}/);
    assert.match(await readFile(join(dir, 'lpp.log'), 'utf8'), /logbook {2}log level debug/, 'the change of level is itself a line');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a level given on the command line is not overruled by the settings page', () => {
  const book = new Logbook({ level: 'debug', fixed: true, echo: quiet });
  book.setLevel('info');
  assert.equal(book.level, 'debug');
  const free = new Logbook({ echo: quiet });
  free.setLevel('nonsense');
  assert.equal(free.level, 'info');
});

test('the files roll at their size and only so many are kept', async () => {
  const dir = await scratch();
  try {
    const book = new Logbook({ dir, maxBytes: 400, keep: 3, echo: quiet, perSecond: 10_000 });
    for (let i = 0; i < 60; i++) book.write('info', 'server', `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`);
    const names = (await readdir(dir)).sort();
    assert.deepEqual(names, ['lpp.1.log', 'lpp.2.log', 'lpp.log']);
    const files = book.files();
    assert.deepEqual(files.map((f) => f.path.split(/[\\/]/).pop()), ['lpp.2.log', 'lpp.1.log', 'lpp.log'], 'oldest first');
    assert.match(await readFile(join(dir, 'lpp.log'), 'utf8'), /line 059/, 'the newest line is in the live file');
    assert.doesNotMatch(await readFile(join(dir, 'lpp.2.log'), 'utf8'), /line 000 /, 'the oldest have gone');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('memory keeps the newest, and recent() filters by seq, level, source and count', () => {
  const book = new Logbook({ ring: 5, echo: quiet });
  for (let i = 1; i <= 8; i++) book.write(i % 2 ? 'info' : 'warn', i < 5 ? 'server' : 'pixelhue', `n${i}`);
  assert.deepEqual(book.recent().map((e) => e.msg), ['n4', 'n5', 'n6', 'n7', 'n8']);
  assert.deepEqual(book.recent({ level: 'warn' }).map((e) => e.msg), ['n4', 'n6', 'n8']);
  assert.deepEqual(book.recent({ source: 'pixel' }).map((e) => e.msg), ['n5', 'n6', 'n7', 'n8']);
  assert.deepEqual(book.recent({ since: 6 }).map((e) => e.msg), ['n7', 'n8']);
  assert.deepEqual(book.recent({ limit: 2 }).map((e) => e.msg), ['n7', 'n8']);
  assert.equal(book.seq, 8);
  assert.deepEqual(book.counts, { debug: 0, info: 4, warn: 4, error: 0 });
});

test('for(source) is log(msg) as before, with levels beside it', () => {
  const book = new Logbook({ echo: quiet });
  const log = book.for('media');
  log('started');
  log.warn('slow');
  log.error(new Error('gone'));
  log.debug('detail');
  assert.deepEqual(book.recent().map((e) => [e.level, e.source, e.msg]), [
    ['info', 'media', 'started'], ['warn', 'media', 'slow'], ['error', 'media', 'gone'], ['debug', 'media', 'detail'],
  ]);
});

test('secrets never reach a line, and settings are exported with secret fields replaced', () => {
  assert.equal(scrub('joined with tskey-auth-kAbC123-XyZ'), 'joined with tskey-[redacted]');
  assert.equal(scrub('password=hunter2 next'), 'password=[redacted] next');
  assert.equal(scrub('{"authKey":"abc"}'), '{"authKey":"[redacted]"}');
  const book = new Logbook({ echo: quiet });
  const e = book.write('info', 'remote', 'login', { token: 'tskey-api-123', note: 'api_key: s3cret' });
  assert.equal(e.data.token, '[redacted]');
  assert.equal(e.data.note, 'api_key: [redacted]');
  assert.deepEqual(redact({
    awjTransport: 'store',
    plugins: { remote: { enabled: true, settings: { authKey: 'k', hostname: 'lpp', password: '' } } },
    list: [{ apiToken: 'x' }],
  }), {
    awjTransport: 'store',
    plugins: { remote: { enabled: true, settings: { authKey: '[redacted]', hostname: 'lpp', password: '' } } },
    list: [{ apiToken: '[redacted]' }],
  });
});

test('a flood is counted, not written, and the count is written when it calms', async () => {
  const dir = await scratch();
  let t = 1_700_000_000_000;
  try {
    const book = new Logbook({ dir, perSecond: 5, echo: quiet, now: () => t });
    for (let i = 0; i < 12; i++) book.write('warn', 'page', `burst ${i}`);
    t += 1000;
    book.write('info', 'server', 'calm');
    const lines = (await readFile(join(dir, 'lpp.log'), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 7);
    assert.match(lines[5], /WARN {2}logbook {2}7 lines in the second before were not written to disk \(more than 5 a second\)/);
    assert.match(lines[6], /calm$/);
    assert.equal(book.recent().length, 13, 'memory has every one');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a log folder that cannot be written costs the file, never the app', async () => {
  const dir = await scratch();
  try {
    const blocker = join(dir, 'not-a-folder');
    await writeFile(blocker, 'x');
    const said = [];
    const book = new Logbook({ dir: join(blocker, 'logs'), echo: (line) => said.push(line) });
    const e = book.write('error', 'server', 'still here');
    assert.equal(e.msg, 'still here');
    assert.ok(book.diskError, 'says why');
    assert.equal(book.recent().length, 1);
    assert.match(book.exportText(), /----- in memory\n.*still here/s, 'and the export still has it');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the export is the header and then every file, oldest first', async () => {
  const dir = await scratch();
  try {
    const book = new Logbook({ dir, maxBytes: 200, keep: 4, echo: quiet });
    for (let i = 0; i < 12; i++) book.write('info', 'server', `entry ${i} ${'y'.repeat(30)}`);
    const text = book.exportText({ 'LivePremier Plus': '0.0.0-test', plugins: { pixelhue: 'on' } });
    assert.match(text, /^LivePremier Plus log export\nexported \d{4}-\d\d-\d\dT/);
    assert.match(text, /\nLivePremier Plus: 0\.0\.0-test\nplugins: \{"pixelhue":"on"\}\n/);
    assert.match(text, /counts since start: \{"debug":0,"info":12,"warn":0,"error":0\}/);
    const order = [...text.matchAll(/entry (\d+) /g)].map((m) => Number(m[1]));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'in the order they were written');
    assert.equal(order.at(-1), 11);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a line reads as local time, level, source, message, data', () => {
  const t = Date.UTC(2026, 10, 3, 14, 5, 1, 123);
  const line = formatEntry({ t, level: 'warn', source: 'pixelhue', msg: 'grid dropped', data: { pongs: 2 } });
  assert.equal(line, `${localTime(new Date(t))} WARN  pixelhue  grid dropped {"pongs":2}`);
  assert.match(localTime(new Date(t)), /^2026-11-0\dT\d\d:\d\d:01\.123[+-]\d\d:\d\d$/);
});

/* ------------------------------------------------------------------ routes */

async function served(options = {}) {
  const dir = await scratch();
  const logbook = new Logbook({ dir, echo: quiet });
  const proxy = await createProxy({ device: '127.0.0.1:9', root: ROOT, log: logbook.for('server'), logbook, ...options });
  const port = await new Promise((resolve) => proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port)));
  const base = `http://127.0.0.1:${port}/__lpp`;
  return {
    logbook, base,
    async close() {
      proxy.closeRelays?.();
      proxy.closeAllConnections?.();
      await new Promise((r) => proxy.close(r));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('GET /__lpp/logs lists the newest lines, by level, after a seq', async () => {
  const s = await served();
  try {
    s.logbook.write('warn', 'pixelhue', 'grid dropped');
    s.logbook.write('debug', 'pixelhue', 'grid ping');
    const all = await (await fetch(`${s.base}/logs`)).json();
    assert.ok(all.entries.some((e) => e.msg === 'grid ping'));
    assert.equal(all.level, 'info');
    assert.equal(all.fixed, false);
    assert.equal(typeof all.dir, 'string');
    const warn = await (await fetch(`${s.base}/logs?level=warn`)).json();
    assert.deepEqual(warn.entries.map((e) => e.msg), ['grid dropped']);
    const none = await (await fetch(`${s.base}/logs?since=${all.seq}`)).json();
    assert.deepEqual(none.entries, []);
  } finally {
    await s.close();
  }
});

test('GET /__lpp/logs/export is one text file to save, with the app and machine at the top', async () => {
  const s = await served();
  try {
    s.logbook.write('error', 'server', 'something broke');
    const res = await fetch(`${s.base}/logs/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="livepremier-plus-log-\d{8}-\d{6}\.txt"$/);
    const text = await res.text();
    assert.match(text, /^LivePremier Plus log export\n/);
    assert.match(text, /\nLivePremier Plus: \d+\.\d+\.\d+/);
    assert.match(text, /\nswitcher: 127\.0\.0\.1:9\n/);
    assert.match(text, /\nos: .+\nnode: v\d+/);
    assert.match(text, /\nsettings: \{.*"awjTransport"/);
    assert.match(text, /ERROR server {2}something broke/);
  } finally {
    await s.close();
  }
});

test('POST /__lpp/logs/page writes the page\'s error, and only so many a minute', async () => {
  const s = await served();
  try {
    const post = (body) => fetch(`${s.base}/logs/page`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const res = await post({ level: 'error', msg: 'could not load /__lpp/src/main.js', where: 'a <script> on the page', url: '/' });
    assert.equal(res.status, 200);
    const e = s.logbook.recent({ source: 'page' })[0];
    assert.equal(e.level, 'error');
    assert.equal(e.msg, 'could not load /__lpp/src/main.js');
    assert.equal(e.data.where, 'a <script> on the page');
    assert.equal((await post({ level: 'shout', msg: 'x' }).then(() => s.logbook.recent({ source: 'page' })[1])).level, 'warn',
      'an unknown level is a warning');
    let last;
    for (let i = 0; i < 60; i++) last = await post({ msg: `again ${i}` });
    assert.equal(last.status, 429);
    assert.equal((await fetch(`${s.base}/logs`, { method: 'DELETE' })).status, 405);
  } finally {
    await s.close();
  }
});

test('a missing file of our own is logged, not only 404ed', async () => {
  const s = await served();
  try {
    assert.equal((await fetch(`${s.base}/src/no-such-module.js`)).status, 404);
    assert.equal((await fetch(`${s.base}/src/..%5C..%5Cpackage.json`)).status, 404);
    const warned = s.logbook.recent({ level: 'warn', source: 'server' }).map((e) => e.msg);
    assert.ok(warned.some((m) => /^\/__lpp\/src\/no-such-module\.js not served: ENOENT$/.test(m)), warned.join('\n'));
    assert.ok(warned.some((m) => /not served: outside src\/$/.test(m)));
  } finally {
    await s.close();
  }
});

test('Settings → Logs → Detail moves the level, and it is saved with the settings', async () => {
  const s = await served();
  try {
    const put = await fetch(`${s.base}/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logLevel: 'debug' }),
    });
    assert.equal((await put.json()).settings.logLevel, 'debug');
    assert.equal(s.logbook.level, 'debug');
    await fetch(`${s.base}/settings`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ logLevel: 'loud' }),
    });
    assert.equal(s.logbook.level, 'info', 'an unknown level falls back to normal');
  } finally {
    await s.close();
  }
});

test('the page\'s error reporter is injected before the hook and the panels', () => {
  const out = buildInjection('/*H*/', [], '/*R*/');
  assert.ok(out.indexOf('data-lpp="report"') < out.indexOf('data-lpp="hook"'));
  assert.ok(out.indexOf('data-lpp="hook"') < out.indexOf('data-lpp="panels"'));
  assert.ok(out.includes('/*R*/'));
  assert.ok(!buildInjection('/*H*/').includes('data-lpp="report"'), 'and left out when there is none');
});

test('the page reports a module of ours that would not load, once, and leaves the vendor\'s errors alone', () => {
  const listeners = {};
  const beacons = [];
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
  };
  const context = vm.createContext({
    window,
    location: { origin: 'http://127.0.0.1:8535', pathname: '/', hash: '#/live' },
    navigator: { sendBeacon: (to, blob) => { beacons.push({ to, blob }); return true; } },
    Blob: class { constructor(parts, o) { this.text = parts.join(''); this.type = o.type; } },
    fetch: () => { throw new Error('beacon first'); },
    JSON, String, Set,
  });
  vm.runInContext(readFileSync(join(ROOT, 'src/hook/report.js'), 'utf8'), context);
  const script = { tagName: 'SCRIPT', src: 'http://127.0.0.1:8535/__lpp/src/main.js' };
  listeners.error({ target: script });
  listeners.error({ target: script });
  listeners.error({ target: window, message: 'x is undefined', filename: 'http://127.0.0.1:8535/app.js', error: { stack: 'at app.js:1' } });
  listeners.error({ target: window, message: 'boom', filename: '', error: { stack: 'Error: boom\n at http://127.0.0.1:8535/__lpp/src/ui/shell.js:4:2' } });
  listeners.unhandledrejection({ reason: { message: 'nope', stack: 'at /__lpp/src/core/live.js:9' } });
  const sent = beacons.map((b) => JSON.parse(b.blob.text));
  assert.ok(beacons.every((b) => b.to === '/__lpp/logs/page' && b.blob.type === 'application/json'));
  assert.deepEqual(sent.map((m) => [m.level, m.msg]), [
    ['error', 'could not load /__lpp/src/main.js'],
    ['error', 'boom'],
    ['warn', 'unhandled rejection: nope'],
  ]);
  assert.equal(sent[0].url, '/#/live');
});
