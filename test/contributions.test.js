/*
 * Contribution points and services: what a plugin may add, what collides, and
 * that a plugin switched off takes its additions with it.
 *
 * The rules pinned here are the ones a plugin written elsewhere depends on,
 * and each refusal is one that stops a plugin quietly taking something over —
 * a built-in cue kind, the switcher's own OSC addresses, part of another
 * plugin's address space.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POINTS, createContributions, createServices, oscAddressFor, describeContributed
} from '../src/core/contributions.js';
import { CueStack, ACTION_KINDS } from '../src/core/cuestack.js';

const cueAction = (kind, over = {}) => ({ kind, label: `Do ${kind}`, run: () => {}, ...over });
const oscAddress = (prefix, over = {}) => ({ prefix, handle: () => ({ ok: true }), ...over });

test('each point says which half of a plugin may add to it', () => {
  assert.equal(POINTS.cueAction.side, 'page');
  assert.equal(POINTS.oscAddress.side, 'server');
});

test('a malformed contribution is refused, saying why', () => {
  const c = createContributions();
  assert.throws(() => c.add('nonsense', {}, 'p'), /no contribution point called "nonsense"/);
  assert.throws(() => c.add('cueAction', { kind: 'x', label: 'X' }, 'p'), /run\(action/);
  assert.throws(() => c.add('cueAction', cueAction('has space'), 'p'), /must be a name/);
  assert.throws(() => c.add('cueAction', cueAction('ok', { label: '' }), 'p'), /needs a label/);
  assert.throws(() => c.add('oscAddress', oscAddress('/no-slash'), 'p'), /ends in "\/"/);
  assert.throws(() => c.add('oscAddress', { prefix: '/x/' }, 'p'), /handle\(address/);
});

test('nothing may claim a kind the cue engine does itself', () => {
  const c = createContributions();
  for (const kind of Object.values(ACTION_KINDS)) {
    assert.throws(() => c.add('cueAction', cueAction(kind), 'p'), /does itself/, kind);
  }
});

test('the switcher’s own addresses are a built-in’s to answer, never a user plugin’s', () => {
  const c = createContributions();
  assert.throws(() => c.add('oscAddress', oscAddress('/lp/screen/'), 'theirs', { builtIn: false }), /switcher’s own/);
  c.add('oscAddress', oscAddress('/lp/matrix/'), 'matrix-routing', { builtIn: true });
  c.add('oscAddress', oscAddress('/hello/'), 'theirs', { builtIn: false });
  assert.deepEqual(c.list('oscAddress').map((x) => x.prefix), ['/lp/matrix/', '/hello/']);
});

test('two plugins may not share a kind, or overlap an address space', () => {
  const c = createContributions();
  c.add('cueAction', cueAction('a:go'), 'a');
  assert.throws(() => c.add('cueAction', cueAction('a:go'), 'b'), /collides with a's "a:go"/);
  c.add('oscAddress', oscAddress('/tree/'), 'a');
  assert.throws(() => c.add('oscAddress', oscAddress('/tree/branch/'), 'b'), /collides/);
  assert.throws(() => c.add('oscAddress', oscAddress('/'.concat('tree/')), 'a'), /collides/, 'not even twice by one plugin');
  /* …but one plugin may answer a branch of its own tree differently. */
  c.add('oscAddress', oscAddress('/tree/branch/'), 'a');
});

test('the longest prefix answers, and a bare subtree address is its own', () => {
  const list = [oscAddress('/a/', { owner: 'x' }), oscAddress('/a/b/', { owner: 'y' })];
  assert.equal(oscAddressFor(list, '/a/b/c').prefix, '/a/b/');
  assert.equal(oscAddressFor(list, '/a/z').prefix, '/a/');
  assert.equal(oscAddressFor(list, '/a').prefix, '/a/');
  assert.equal(oscAddressFor(list, '/ab'), null, 'a whole segment at a time');
  assert.equal(oscAddressFor([], '/lp/screen/1/take'), null);
});

test('a plugin that is off contributes nothing, and one switched off loses what it added', () => {
  const c = createContributions();
  c.add('cueAction', cueAction('a:one'), 'a');
  c.add('cueAction', cueAction('b:one'), 'b');
  assert.deepEqual(c.list('cueAction', (owner) => owner !== 'b').map((x) => x.kind), ['a:one']);
  c.removeOwner('a');
  assert.deepEqual(c.list('cueAction').map((x) => x.kind), ['b:one']);
  assert.equal(c.list('cueAction')[0].owner, 'b', 'each says whose it is');
});

test('a contributed kind is described in its own words, or at worst named', () => {
  const list = [
    { kind: 'a:route', label: 'Route', describe: (x) => `route ${x.to}` },
    { kind: 'a:plain', label: 'Plain' },
    { kind: 'a:broken', label: 'Broken', describe: () => { throw new Error('no'); } }
  ];
  assert.equal(describeContributed({ kind: 'a:route', to: 'IN1' }, list), 'route IN1');
  assert.equal(describeContributed({ kind: 'a:plain' }, list), 'Plain');
  assert.equal(describeContributed({ kind: 'a:broken' }, list), 'Broken');
  assert.equal(describeContributed({ kind: 'gone:away' }, list), 'gone:away', 'a switched-off plugin’s action is still shown');
});

test('a service has one provider, found by name while its provider is on', () => {
  const s = createServices();
  const api = { go() {} };
  s.provide('stack', api, 'timeline');
  assert.equal(s.use('stack'), api);
  assert.throws(() => s.provide('stack', {}, 'other'), /already provided by timeline/);
  assert.equal(s.use('stack', (owner) => owner !== 'timeline'), null, 'its provider is off');
  assert.equal(s.use('nobody'), null);
  s.removeOwner('timeline');
  assert.equal(s.use('stack'), null);
  assert.throws(() => s.provide('empty', null, 'x'), /is empty/);
});

/* ------------------------------------------------------------ in the engine */

function stackWith(actions) {
  const sent = [];
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    now: () => 0
  };
  const stack = new CueStack({ send: (cmd) => { sent.push(cmd); return true; }, clock, actions });
  const warnings = [];
  stack.addEventListener('warning', (ev) => warnings.push(ev.detail.message));
  return { stack, sent, timers, warnings };
}

test('a contributed action runs as its cue fires, ahead of the take in the same cue', () => {
  const order = [];
  const route = { kind: 'matrixFeed', label: 'Route', run: (a) => { order.push(`route ${a.source}`); } };
  const timers = [];
  const clock = {
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    now: () => 0
  };
  const stack = new CueStack({
    send: (cmd) => { order.push(cmd.path.includes('xTake') ? 'take' : 'write'); return true; },
    clock,
    actions: (kind) => (kind === 'matrixFeed' ? route : null)
  });
  stack.add({
    actions: [
      { kind: ACTION_KINDS.TAKE, targets: ['S1'] },            /* listed first… */
      { kind: 'matrixFeed', connector: 'IN_1', source: 3 }
    ]
  });
  stack.go();
  for (const t of timers) t.fn();
  /* …but the take is deferred until the cue's actions have all run, so a
     signal is on the input before anything switches to it. */
  assert.equal(order.indexOf('route 3') < order.indexOf('take'), true, order.join(', '));
  assert.ok(order.includes('take'));
});

test('a kind nobody handles, a run that throws and a run that rejects each become a warning', async () => {
  const bad = {
    kind: 'x:throws', label: 'Thrower', run: () => { throw new Error('bang'); }
  };
  const late = {
    kind: 'x:rejects', label: 'Rejecter', run: () => Promise.reject(new Error('later'))
  };
  const { stack, warnings } = stackWith((kind) => ({ 'x:throws': bad, 'x:rejects': late })[kind] || null);
  stack.add({ actions: [{ kind: 'x:missing' }, { kind: 'x:throws' }, { kind: 'x:rejects' }] });
  stack.go();
  await new Promise((r) => setImmediate(r));
  assert.match(warnings[0], /Nothing handles “x:missing” — the plugin that adds it may be switched off/);
  assert.match(warnings[1], /Thrower failed: bang/);
  assert.match(warnings[2], /Rejecter failed: later/);
});
