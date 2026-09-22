/*
 * The Companion link: the tRPC frame codec, the settings block and the plan
 * this app makes about somebody else's show.
 *
 * ## What these tests can and cannot prove
 *
 * The frame shapes below are **read off `@trpc/server`'s own `adapters/ws.ts`
 * as shipped inside Companion 5.0.5** — the source map in the app bundle
 * carries the original TypeScript, so these are the server's own definitions
 * rather than a guess from tRPC's published documentation, which describes
 * whichever version wrote it. That is a genuine check against the thing we
 * talk to.
 *
 * It is **not** a check against a running Companion. No frame here has been
 * on a socket. If Companion changes its internal API — which it is entitled
 * to, `/trpc` is not a published interface — every one of these still passes
 * while nothing works. The symptom to look for is Companion's own wording,
 * "Invalid or malformed input provided for …", which is its `tidyZodMiddleware`
 * saying this app sent a shape the procedure did not want.
 *
 * `planConnections` is the part worth most here, and it is fully ours: it
 * decides what this app does to a show it did not create, and the rule it
 * encodes — adopt, never rewrite — is the one that would be expensive to get
 * wrong on a show day.
 *
 * Run: node --test test/companion.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PORT,
  MODULES,
  addInput,
  companionChanged,
  locationKey,
  moduleKey,
  normaliseCompanion,
  normaliseHost,
  originAllowed,
  pageGrid,
  parseFrames,
  pickVersion,
  planConnections,
  request,
  stopRequest,
} from '../plugins/companion/core.js';

/* ------------------------------------------------------------- the settings */

test('a host that is not a host is refused rather than passed to net.connect', () => {
  /* Each of these would fail later and less usefully: a URL resolves to a DNS
     error naming the whole string, and a host:port pair silently looks up a
     name with a colon in it. */
  for (const bad of ['http://companion', 'companion:8000', '10.0.0.1/api', '', '  ', 'a'.repeat(300)]) {
    assert.equal(normaliseCompanion({ companionHost: bad }).companionHost, '', `should refuse ${bad}`);
  }
  for (const good of ['companion', 'companion.local', '192.168.2.69', 'my-mac_2']) {
    assert.equal(normaliseCompanion({ companionHost: good }).companionHost, good);
  }
});

test('a bad port falls back to Companion’s own default rather than rejecting the file', () => {
  assert.equal(normaliseCompanion({ companionPort: 0 }).companionPort, DEFAULT_PORT);
  assert.equal(normaliseCompanion({ companionPort: 70000 }).companionPort, DEFAULT_PORT);
  assert.equal(normaliseCompanion({ companionPort: '8000' }).companionPort, 8000);
  assert.equal(normaliseCompanion({ companionPort: 8000.5 }).companionPort, DEFAULT_PORT);
  /* Unlike the OSC listener this one may sit below 1024: we are dialling out,
     so nothing here ever needs privilege to bind. */
  assert.equal(normaliseCompanion({ companionPort: 80 }).companionPort, 80);
});

test('enabled is true only for a real true', () => {
  assert.equal(normaliseCompanion({ companionEnabled: 'yes' }).companionEnabled, false);
  assert.equal(normaliseCompanion({ companionEnabled: 1 }).companionEnabled, false);
  assert.equal(normaliseCompanion({ companionEnabled: true }).companionEnabled, true);
  assert.equal(normaliseCompanion(null).companionEnabled, false);
});

test('companionChanged fires on the three fields that mean a new socket', () => {
  const base = normaliseCompanion({ companionEnabled: true, companionHost: 'a', companionPort: 8000 });
  assert.equal(companionChanged(base, { ...base }), false);
  assert.equal(companionChanged(base, { ...base, companionHost: 'b' }), true);
  assert.equal(companionChanged(base, { ...base, companionPort: 8001 }), true);
  assert.equal(companionChanged(base, { ...base, companionEnabled: false }), true);
});

/* ------------------------------------------------------------- the tRPC wire */

test('a request carries an id, because a frame without one is answered with a parse error', () => {
  const frame = request(7, 'mutation', 'instances.connections.add', { label: 'AWJ' });
  assert.equal(frame.id, 7);
  assert.equal(frame.method, 'mutation');
  assert.equal(frame.params.path, 'instances.connections.add');
  assert.deepEqual(frame.params.input, { label: 'AWJ' });
});

test('no input means no input key at all', () => {
  /* A procedure with no `.input()` schema rejects a null it did not ask for,
     so the key has to be absent rather than present and empty. */
  const frame = request(1, 'query', 'appInfo.version');
  assert.equal('input' in frame.params, false);
  /* A null *inside* an input object is still sent, though — the rule is
     about the input as a whole being absent, not about its fields. (Do not
     read this as licence to send `versionId: null` to `connections.add`: that
     particular field is `z.string()` and refuses one. See `pickVersion`.) */
  const withNull = request(2, 'mutation', 'x', { versionId: null });
  assert.deepEqual(withNull.params.input, { versionId: null });
});

test('stopping a subscription is its own method and carries no params', () => {
  const frame = stopRequest(4);
  assert.equal(frame.method, 'subscription.stop');
  assert.equal(frame.id, 4);
  assert.equal('params' in frame, false);
});

test('the four reply shapes are each recognised', () => {
  assert.deepEqual(parseFrames(JSON.stringify({ id: 1, result: { type: 'data', data: { ok: 1 } } })), [
    { id: 1, kind: 'data', data: { ok: 1 } },
  ]);
  assert.deepEqual(parseFrames(JSON.stringify({ id: 2, result: { type: 'started' } })), [
    { id: 2, kind: 'started' },
  ]);
  assert.deepEqual(parseFrames(JSON.stringify({ id: 3, result: { type: 'stopped' } })), [
    { id: 3, kind: 'stopped' },
  ]);
  assert.deepEqual(parseFrames(JSON.stringify({ id: 4, error: { message: 'nope' } })), [
    { id: 4, kind: 'error', error: 'nope' },
  ]);
});

test('a batched reply is unpacked, and rubbish never throws', () => {
  const batch = JSON.stringify([
    { id: 1, result: { type: 'data', data: 'a' } },
    { id: 2, result: { type: 'data', data: 'b' } },
  ]);
  assert.equal(parseFrames(batch).length, 2);

  /* Each of these arrives on a socket we do not control. None of them is a
     reason to tear it down: the calls we made are still going to answer. */
  for (const junk of ['', 'not json', '{}', '[]', 'null', JSON.stringify({ id: 'x' }), JSON.stringify({ result: {} })]) {
    assert.deepEqual(parseFrames(junk), [], `should ignore ${junk}`);
  }
  /* A message type this app has never heard of is ignored, not reported. */
  assert.deepEqual(parseFrames(JSON.stringify({ id: 9, result: { type: 'invented-later' } })), []);
});

/* ------------------------------------------------------------------ the plan */

const CONN = (moduleId, id, label) => ({ id, label, moduleId, enabled: true, sortOrder: 0 });
const planned = (existing, want) => planConnections(existing, want);

test('an empty show gets both connections added', () => {
  const plan = planned([]);
  assert.deepEqual(plan.add.map((a) => a.spec.moduleId), ['analogway-awj', 'livepremier-plus']);
  assert.equal(plan.adopt.length, 0);
  assert.equal(plan.ambiguous.length, 0);
});

test('a connection that is already there is adopted, never added twice', () => {
  const plan = planned([CONN('analogway-awj', 'abc', 'Aquilon')]);
  assert.deepEqual(plan.add.map((a) => a.spec.moduleId), ['livepremier-plus']);
  assert.equal(plan.adopt.length, 1);
  assert.equal(plan.adopt[0].connection.id, 'abc');
  /* Adopted by module, not by label. An operator who called it "Aquilon"
     rather than "AWJ" has still got an AWJ connection, and adding a second
     one beside it would be this app not looking before it wrote. */
  assert.equal(plan.adopt[0].connection.label, 'Aquilon');
});

test('two of the same module is ambiguous, and nothing is chosen for the operator', () => {
  const plan = planned([
    CONN('analogway-awj', 'a', 'Main frame'),
    CONN('analogway-awj', 'b', 'Backup frame'),
  ]);
  assert.equal(plan.ambiguous.length, 1);
  assert.equal(plan.ambiguous[0].connections.length, 2);
  /* The important half: it is not in `add`. A show with a main and a backup
     frame is a correct show, and giving it a third AWJ connection because
     neither matched a label would be actively wrong. */
  assert.deepEqual(plan.add.map((a) => a.spec.moduleId), ['livepremier-plus']);
  assert.equal(plan.adopt.length, 0);
});

test('a disabled connection still counts as present', () => {
  /* Somebody turned it off on purpose. Adding a second one beside it is the
     one response that is certainly wrong. */
  const plan = planned([{ ...CONN('livepremier-plus', 'x', 'LPP'), enabled: false }]);
  assert.deepEqual(plan.add.map((a) => a.spec.moduleId), ['analogway-awj']);
  assert.equal(plan.adopt.length, 1);
});

test('other people’s connections are invisible to the plan', () => {
  const plan = planned([CONN('obs-websocket', 'o', 'OBS'), CONN('generic-osc', 'g', 'OSC')]);
  assert.equal(plan.add.length, 2);
  assert.equal(plan.adopt.length, 0);
});

test('a junk connection list does not take the plan down', () => {
  for (const bad of [null, undefined, 'nope', 42, [null, undefined, {}]]) {
    const plan = planned(bad);
    assert.equal(plan.add.length, 2, 'everything is missing, so everything is addable');
  }
});

test('planning for one module only leaves the other alone', () => {
  const plan = planned([], ['awj']);
  assert.deepEqual(plan.add.map((a) => a.spec.moduleId), ['analogway-awj']);
});

/* --------------------------------------------------- the cross-origin check */

test('an upgrade from the page we served is allowed', () => {
  assert.equal(originAllowed('http://127.0.0.1:8599', '127.0.0.1:8599'), true);
  assert.equal(originAllowed('http://lpp.local', 'lpp.local'), true);
  /* A default port is present on one side and absent on the other as a matter
     of course — `new URL().host` drops it, a Host header often carries it. */
  assert.equal(originAllowed('http://lpp.local', 'lpp.local:80'), true);
  assert.equal(originAllowed('https://lpp.local', 'lpp.local:443'), true);
  /* Host names are case-insensitive and browsers do not always agree on the
     case they send. */
  assert.equal(originAllowed('http://LPP.Local:8599', 'lpp.local:8599'), true);
});

test('an upgrade from anywhere else is refused', () => {
  /* This is the whole security property. Companion refuses a cross-origin
     WebSocket because there is no CORS preflight to stop one, and mounting it
     under our origin moves that decision to us — so getting this wrong turns
     this app into a laundering service for any page the operator has open.
     Verified live against the running mount: 403 for each of these, 101 for
     the cases above. */
  assert.equal(originAllowed('https://evil.example', '127.0.0.1:8599'), false);
  assert.equal(originAllowed('http://127.0.0.1:9999', '127.0.0.1:8599'), false);
  assert.equal(originAllowed('http://127.0.0.2:8599', '127.0.0.1:8599'), false);
  /* A sandboxed iframe and a file:// page both send this, and neither is our
     UI. Companion refuses it too. */
  assert.equal(originAllowed('null', '127.0.0.1:8599'), false);
  assert.equal(originAllowed('not a url', '127.0.0.1:8599'), false);
  assert.equal(originAllowed('', '127.0.0.1:8599'), false);
  /* No Host to compare against is not a pass. */
  assert.equal(originAllowed('http://127.0.0.1:8599', ''), false);
  assert.equal(originAllowed('http://127.0.0.1:8599', undefined), false);
});

test('no Origin at all is allowed, because CSWSH is a browser attack', () => {
  /* Same rule Companion itself applies: a request with no Origin did not come
     from a browser, so there is no ambient authority to hijack. Our own
     server-side link relies on this. */
  assert.equal(originAllowed(undefined, '127.0.0.1:8599'), true);
  assert.equal(originAllowed(null, '127.0.0.1:8599'), true);
});

test('a scheme mismatch does not let a default port paper over a difference', () => {
  /* http://x and https://x are different origins, and stripping the wrong
     default port is how they would come to look the same. */
  assert.equal(originAllowed('https://lpp.local', 'lpp.local:80'), false);
  assert.equal(originAllowed('http://lpp.local', 'lpp.local:443'), false);
});

test('normaliseHost drops only the default port for the scheme', () => {
  assert.equal(normaliseHost('Example.COM:80'), 'example.com');
  assert.equal(normaliseHost('example.com:8080'), 'example.com:8080');
  assert.equal(normaliseHost('example.com:443', 'https'), 'example.com');
  assert.equal(normaliseHost('example.com:443', 'http'), 'example.com:443');
  assert.equal(normaliseHost(''), '');
  assert.equal(normaliseHost(undefined), '');
});

/* --------------------------------------------------------- the module table */

test('each module points where it belongs, and they do not overlap', () => {
  const facts = { device: '192.168.2.140', selfHost: '192.168.2.10', selfPort: 8090 };

  /* AWJ is pointed at the box. Note the `http://` — the module's field is a
     URL string, and a bare host in it is a connection that never comes up. */
  assert.deepEqual(MODULES.awj.configure(facts), { deviceaddr: 'http://192.168.2.140' });

  /* Ours is pointed at us, not at the box. */
  assert.deepEqual(MODULES.lpp.configure(facts), { host: '192.168.2.10', port: 8090 });

  assert.notEqual(MODULES.awj.moduleId, MODULES.lpp.moduleId);
});

test('a device carrying a port keeps it through the AWJ url', () => {
  /* The simulator is on 3000 and the proxy stores "host:3000" as one string;
     dropping the port here would point the module at a device that is not
     listening on 80. */
  assert.deepEqual(MODULES.awj.configure({ device: 'localhost:3000' }), {
    deviceaddr: 'http://localhost:3000',
  });
});

test('addInput carries a real version, because null is refused by the schema', () => {
  /* ⚠️ The expensive one. `addConnectionWithLabel` treats a null versionId as
     "the latest installed version", which reads like an invitation to send
     one — but the tRPC procedure in front of it declares `z.string()`, not
     nullable, so a null never gets that far. It comes back as Companion's
     generic "Invalid or malformed input provided for
     instances.connections.add/mutation", which names the procedure and not
     the field. Found against a live Companion 5.0.5, not by reading. */
  assert.deepEqual(addInput(MODULES.awj, '2.5.1-customfix-jt'), {
    module: { type: 'analogway-awj', product: 'LivePremier' },
    label: 'AWJ',
    versionId: '2.5.1-customfix-jt',
  });
});

test('a module is looked up under its namespaced key', () => {
  /* Surfaces share the map, so the bare id finds nothing — and "not found"
     is indistinguishable from "not installed" at the call site. */
  assert.equal(moduleKey('analogway-awj'), 'connection:analogway-awj');
  assert.equal(moduleKey('elgato-stream-deck', 'surface'), 'surface:elgato-stream-deck');
});

test('pickVersion prefers what Companion itself calls stable', () => {
  /* Shape taken verbatim from a live `instances.modules.watch`. */
  const entry = {
    devVersion: { versionId: 'dev' },
    builtinVersion: null,
    stableVersion: { versionId: '2.5.1-customfix-jt' },
    betaVersion: { versionId: '2.6.0-beta' },
    installedVersions: [{ versionId: '2.5.0' }, { versionId: '2.5.1-customfix-jt' }],
  };
  assert.equal(pickVersion(entry), '2.5.1-customfix-jt');
});

test('pickVersion falls back in a fixed order, with dev last', () => {
  const beta = { stableVersion: null, betaVersion: { versionId: '3.0.0-beta' } };
  assert.equal(pickVersion(beta), '3.0.0-beta');

  /* Last of the installed list, not the first: Companion emits them in
     ascending order and there is no semver comparison here to do better. */
  const installed = { installedVersions: [{ versionId: '1.0.0' }, { versionId: '1.2.0' }] };
  assert.equal(pickVersion(installed), '1.2.0');

  /* A developer with a working copy almost certainly also has it installed,
     and binding a show to a working copy is not this app's call to make. */
  const dev = { devVersion: { versionId: 'dev' }, installedVersions: [{ versionId: '1.0.0' }] };
  assert.equal(pickVersion(dev), '1.0.0');
  assert.equal(pickVersion({ devVersion: { versionId: 'dev' } }), 'dev');
  assert.equal(pickVersion({ builtinVersion: { versionId: 'builtin' } }), 'builtin');
});

test('pickVersion says null for a module that is not installed', () => {
  /* Which is the *expected* answer for our own module until somebody installs
     it, and has to be distinguishable from "no version" so the caller can say
     so in words instead of letting the add fail on a schema error. */
  assert.equal(pickVersion(undefined), null);
  assert.equal(pickVersion(null), null);
  assert.equal(pickVersion({}), null);
  assert.equal(pickVersion({ stableVersion: {}, installedVersions: [] }), null);
  assert.equal(pickVersion({ stableVersion: { versionId: '' } }), null);
  assert.equal(pickVersion('nonsense'), null);
});

/* ---------------------------------------------------------------- the surface */

test('a page is walked in reading order, and a location prints stably', () => {
  const grid = pageGrid(1, { rows: 2, columns: 3 });
  assert.equal(grid.length, 6);
  assert.deepEqual(grid[0], { pageNumber: 1, row: 0, column: 0 });
  assert.deepEqual(grid[3], { pageNumber: 1, row: 1, column: 0 });
  assert.deepEqual(grid.map(locationKey), ['1/0/0', '1/0/1', '1/0/2', '1/1/0', '1/1/1', '1/1/2']);
});

test('the location field is pageNumber, which is what Companion’s schema demands', () => {
  /* Verified on a live Companion 5.0.5: `{pageNumber,row,column}` returns a
     PNG from preview.graphics.location, and anything else is refused with a
     message that names the procedure but not the field — so this is the
     spelling that has to be right by construction rather than by debugging.
     Pages count from 1 (`z.number().min(1)`), rows and columns from 0. */
  const [first] = pageGrid(1);
  assert.deepEqual(Object.keys(first).sort(), ['column', 'pageNumber', 'row']);
  assert.equal(first.pageNumber, 1);
  assert.equal(first.row, 0);
  assert.equal(first.column, 0);
});

test('the default grid is Companion’s own default page size', () => {
  assert.equal(pageGrid(1).length, 32);
});
