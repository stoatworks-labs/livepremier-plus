/*
 * Control API: the action table, the lease, and the relay from a request to
 * the page holding the lease and back. The page half itself needs a store and
 * a DOM; it is driven end to end against the rack simulator (docs/CONTROL.md
 * says how), not here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { checkRequest, createLease, findCue, onOff, parseTarget, resolveSource, ACTIONS } from '../plugins/control/core.js';
import activate from '../plugins/control/server.js';

/* ------------------------------------------------------------------ core */

test('a request names a known action and its arguments are checked', () => {
  assert.deepEqual(checkRequest({ action: 'timeline.go' }), { ok: true, action: 'timeline.go', plugin: 'timeline', args: {} });
  assert.equal(checkRequest({ action: 'timeline.goto', args: { cue: ' 12 ' } }).args.cue, '12');
  assert.match(checkRequest({ action: 'timeline.goto' }).error, /cue number/);
  assert.match(checkRequest({ action: 'nope' }).error, /no action “nope”/);
  assert.match(checkRequest({}).error, /no action named/);
  assert.equal(checkRequest({ action: 'groups.send', args: { source: 3, target: 'S1/2' } }).args.mode, 'PREVIEW');
  assert.match(checkRequest({ action: 'groups.send', args: { source: 3, target: 'S1/2', mode: 'air' } }).error, /preview or program/);
  assert.equal(checkRequest({ action: 'variables.set', args: { name: '@gap', value: '40' } }).args.name, 'gap');
  assert.match(checkRequest({ action: 'variables.set', args: { name: '1x', value: '40' } }).error, /not a variable name/);
  assert.equal(checkRequest({ action: 'locks.set', args: { target: 'S1/2' } }).args.on, 'toggle');
});

test('every action belongs to a plugin that exists', async () => {
  const { BUILTINS } = await import('../src/core/plugins.js');
  const ids = new Set(BUILTINS.map((p) => p.id));
  for (const [name, def] of Object.entries(ACTIONS)) assert.ok(ids.has(def.plugin), `${name} needs ${def.plugin}`);
});

test('on, off and toggle are read generously and refused otherwise', () => {
  assert.equal(onOff(true), 'on');
  assert.equal(onOff('Unlock'), 'off');
  assert.equal(onOff(undefined), 'toggle');
  assert.equal(onOff('maybe'), null);
});

test('a cue is found by its number the way an operator writes it', () => {
  const cues = [{ id: 'a', number: '1' }, { id: 'b', number: '2.5' }, { id: 'c', number: '' }, { id: 'd', number: '12a' }];
  assert.equal(findCue(cues, '1.0').id, 'a');
  assert.equal(findCue(cues, '01').id, 'a');
  assert.equal(findCue(cues, '2.5').id, 'b');
  assert.equal(findCue(cues, '2'), null);
  assert.equal(findCue(cues, '3').id, 'c', 'an unnumbered cue answers to its place in the list');
  assert.equal(findCue(cues, '12A').id, 'd');
});

test('a target is a layer or a group by name', () => {
  const groups = [{ name: 'Side screens', members: [{ id: 'S1', layer: '2' }, { id: 'S2', layer: 1 }] }];
  assert.deepEqual(parseTarget('S1/2').members, [{ id: 'S1', layer: '2' }]);
  assert.deepEqual(parseTarget('s3 l4').members, [{ id: 'S3', layer: '4' }]);
  assert.deepEqual(parseTarget('A1/native').members, [{ id: 'A1', layer: 'NATIVE' }]);
  const g = parseTarget('side SCREENS', groups);
  assert.equal(g.kind, 'group');
  assert.deepEqual(g.members, [{ id: 'S1', layer: '2' }, { id: 'S2', layer: '1' }]);
  assert.equal(parseTarget('Nobody', groups), null);
});

test('a source is read against what the switcher offers', () => {
  const nlc = [{ value: 'NONE', kind: 'none' }, { value: 'LIVE_3', kind: 'input' }, { value: 'STILL_2', kind: 'still' }];
  const label = (v) => ({ LIVE_3: 'IN3', STILL_2: 'IMG2', NONE: '' }[v] ?? v);
  assert.equal(resolveSource('3', nlc, label), 'LIVE_3');
  assert.equal(resolveSource('in 3', nlc, label), 'LIVE_3');
  assert.equal(resolveSource('IMG2', nlc, label), 'STILL_2');
  assert.equal(resolveSource('live_3', nlc, label), 'LIVE_3');
  assert.equal(resolveSource('none', nlc, label), 'NONE');
  assert.equal(resolveSource('9', nlc, label), null);
  const midra = [{ value: 'INPUT_3', kind: 'input' }];
  assert.equal(resolveSource('IN3', midra), 'INPUT_3');
});

test('one page holds the lease until it lets go or goes quiet', () => {
  let t = 0;
  const lease = createLease({ ms: 1000, now: () => t });
  assert.equal(lease.claim('a'), 'a');
  assert.equal(lease.claim('b'), 'a');
  t = 900;
  assert.equal(lease.claim('a'), 'a');
  t = 1800;
  assert.equal(lease.claim('b'), 'a', 'renewed at 900, so still held at 1800');
  t = 2000;
  assert.equal(lease.claim('b'), 'b');
  assert.equal(lease.claim('b', true), null);
});

test('a page whose stream is open keeps the lease however late its beat', () => {
  let t = 0;
  const open = new Set(['a']);
  const lease = createLease({ ms: 1000, now: () => t, alive: (id) => open.has(id) });
  assert.equal(lease.claim('a'), 'a');
  t = 60000;
  assert.equal(lease.claim('b'), 'a', 'a hidden tab beats once a minute, and its stream is still open');
  open.delete('a');
  assert.equal(lease.claim('b'), 'b');
});

/* ---------------------------------------------------------------- server */

/* `/do` reads its body before it sends, so the command is out a turn later. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/* A page's open `/stream`: the frames it has been sent, and a way to close it. */
function pageStream(route, id) {
  const req = new EventEmitter();
  const frames = [];
  let status = 200;
  const res = {
    writeHead: (s) => { status = s; },
    write: (text) => {
      for (const block of String(text).split('\n\n')) {
        const event = /^event: (.*)$/m.exec(block);
        const data = /^data: (.*)$/m.exec(block);
        if (event && data) frames.push({ event: event[1], data: JSON.parse(data[1]) });
      }
    },
    end: () => req.emit('close'),
  };
  const url = new URL(`http://lpp/__lpp/control/stream${id == null ? '' : `?page=${id}`}`);
  route(req, res, { url, json: (s) => { status = s; } });
  return { frames, get status() { return status; }, close: () => req.emit('close'), commands: () => frames.filter((f) => f.event === 'command') };
}

function hostFor() {
  const routes = new Map();
  const streams = new Map();
  const disposers = [];
  const ctx = {
    route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
    stream: (path) => {
      const s = { sent: [], send(event, data) { this.sent.push({ event, data }); } };
      streams.set(path, s);
      return s;
    },
    onDispose: (fn) => disposers.push(fn),
  };
  const call = async (method, path, body) => {
    let status = 0;
    let payload = null;
    await routes.get(`${method} ${path}`)({}, {}, {
      readJson: async () => body ?? {},
      json: (s, b) => { status = s; payload = b; },
    });
    return { status, body: payload };
  };
  activate(ctx);
  const open = (id) => pageStream(routes.get('GET /stream'), id);
  return { call, open, streams, stop: () => disposers.reverse().forEach((fn) => fn()) };
}

test('with no page open an action is refused, saying why', async (t) => {
  const host = hostFor();
  t.after(host.stop);
  const r = await host.call('POST', '/do', { action: 'timeline.go' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no LivePremier Plus page is open/);
  assert.equal((await host.call('POST', '/do', { action: 'nope' })).status, 400);
});

test('an action goes to the lease holder and its answer comes back', async (t) => {
  const host = hostFor();
  t.after(host.stop);
  const a = host.open('page-a');
  const b = host.open('page-b');
  await host.call('POST', '/runner', { id: 'page-b' });

  const pending = host.call('POST', '/do', { action: 'timeline.goto', args: { cue: 4 } });
  await tick();
  const command = a.commands().at(-1);
  assert.deepEqual(b.commands().at(-1), command, 'every page hears it; the one named acts');
  assert.equal(command.event, 'command');
  assert.equal(command.data.runner, 'page-a', 'the first claim holds');
  assert.deepEqual(command.data.args, { cue: '4' });

  assert.equal((await host.call('POST', '/result', { id: command.data.id, ok: true, result: { x: 1 } })).status, 200);
  const r = await pending;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: true, action: 'timeline.goto', result: { x: 1 }, error: null });

  const refused = host.call('POST', '/do', { action: 'timeline.fire', args: { cue: 99 } });
  await tick();
  const second = a.commands().at(-1);
  await host.call('POST', '/result', { id: second.data.id, ok: false, error: 'there is no cue 99' });
  const rr = await refused;
  assert.equal(rr.status, 409);
  assert.equal(rr.body.error, 'there is no cue 99');

  assert.equal((await host.call('POST', '/result', { id: 'gone', ok: true })).status, 404);
});

test('only the lease holder reports the show, and the report is streamed', async (t) => {
  const host = hostFor();
  t.after(host.stop);
  assert.equal((await host.call('POST', '/report', { page: 'x', state: { a: 1 } })).status, 409);
  await host.call('POST', '/runner', { id: 'page-a' });
  assert.equal((await host.call('POST', '/report', { page: 'page-b', state: { a: 1 } })).status, 409);
  assert.equal((await host.call('POST', '/report', { page: 'page-a', state: { timeline: { count: 3 } } })).status, 200);

  const state = (await host.call('GET', '/state')).body;
  assert.equal(state.page, true);
  assert.deepEqual(state.state, { timeline: { count: 3 } });
  assert.ok(state.actions.some((a) => a.name === 'timeline.go'));
  const last = host.streams.get('/events').sent.at(-1);
  assert.equal(last.event, 'state');
  assert.deepEqual(last.data.state, { timeline: { count: 3 } });

  await host.call('POST', '/runner', { id: 'page-a', release: true });
  const after = (await host.call('GET', '/state')).body;
  assert.equal(after.page, false);
  assert.equal(after.state, null, 'a page that let go no longer speaks for the show');
});

test('a closed stream hands the lease to the next page at once', async (t) => {
  const host = hostFor();
  t.after(host.stop);
  assert.equal(host.open().status, 400, 'a stream says which page it is');
  const a = host.open('page-a');
  const b = host.open('page-b');
  assert.deepEqual(a.frames[0], { event: 'lease', data: { runner: 'page-a' } });
  assert.deepEqual(b.frames[0], { event: 'lease', data: { runner: 'page-a' } }, 'the second page is told who holds it');
  assert.equal((await host.call('POST', '/runner', { id: 'page-b' })).body.runner, 'page-a');

  a.close();
  assert.deepEqual(b.frames.at(-1), { event: 'lease', data: { runner: 'page-b' } });
  assert.equal((await host.call('GET', '/state')).body.page, true);
  assert.equal(host.streams.get('/events').sent.at(-1).data.page, true);

  /* Letting go on the way out hands over too, before the stream has closed. */
  const c = host.open('page-c');
  await host.call('POST', '/runner', { id: 'page-b', release: true });
  assert.deepEqual(c.frames.at(-1), { event: 'lease', data: { runner: 'page-c' } });

  c.close();
  b.close();
  assert.equal((await host.call('GET', '/state')).body.page, false);
  assert.equal(host.streams.get('/events').sent.at(-1).data.page, false, 'Companion hears the last page go');
});

test('switching the plugin off answers whatever was waiting', async () => {
  const host = hostFor();
  await host.call('POST', '/runner', { id: 'page-a' });
  const pending = host.call('POST', '/do', { action: 'timeline.go' });
  await tick();
  host.stop();
  const r = await pending;
  assert.equal(r.status, 409);
  assert.match(r.body.error, /switched off/);
});
