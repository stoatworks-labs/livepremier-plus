/*
 * Dante — the plugin's server half: finding devices, reading them, writing
 * subscriptions, Dante Controller presets, snapshots, and the routes, stream,
 * OSC addresses and setup-file section that reach all of it.  ** PREVIEW **
 *
 * ## What this is, and is not
 *
 * Dante Controller has no remote-control interface, so this is two honest
 * halves rather than one pretend one:
 *
 * 1. **Our own Dante routing control**, speaking the control protocol netaudio
 *    reverse-engineered (`protocol.js` says where each table came from):
 *    discovery, the devices' channels and subscriptions, and adding and
 *    removing subscriptions.
 * 2. **Interoperability with Dante Controller through its preset files**
 *    (`preset.js`): export what this app reads as a preset Dante Controller
 *    can load, and read a preset Dante Controller saved, show what applying
 *    it would change, and apply that on confirmation.
 *
 * It has never spoken to a real Dante device. Every exchange here has been
 * with `tools/dante-sim.mjs`, which is built from the same tables and so
 * proves only that the pieces fit; the codec itself is held to packets Dante
 * Controller sent, in `test/dante.test.js`. Off by default, preview on the
 * settings page, and `docs/DANTE.md` has the first real-device test to run.
 *
 * ## The Dante network is the installation's, not the switcher's
 *
 * Re-pointing the app at a backup frame does not move a single Dante
 * subscription, so nothing here is keyed by switcher: the device list, the
 * readers and the snapshots all survive a re-point, like Matrix Routing's
 * routers. Which Dante device *is* the switcher's own card is a question the
 * page answers, because the page has the store (`switcher.js`).
 *
 * ## Every write is a plan, sent, and read back
 *
 * The grid, a cue, an OSC address, a snapshot recall and a preset all become
 * routes; `core.js`'s `plan()` keeps only what differs from what the devices
 * last said; the supervisor sends that in each device's own encoding and
 * reads its receive channels again; and `confirm()` reports, per channel,
 * what the device says now. A route that was asked for and is not there is
 * named — `unconfirmed`, `refused`, `missing` — never reported as done.
 */

import { createHash } from 'node:crypto';
import { Discovery, localInterfaces } from './discovery.js';
import { DanteSupervisor } from './supervisor.js';
import {
  normaliseSettings, settingsChanged, parseAddress, plan, changesByDevice, confirm, summarise, failed,
  normaliseSnapshots, snapshotOf, snapshotRoutes, findDevice, formatLocal, OSC_PREFIX, DANTE_OSC, parseDanteOsc
} from './core.js';
import { readPreset, assignRoles, presetRoutes, writePreset, presetFileName, MAX_PRESET_BYTES } from './preset.js';
import { channelReferenceProblem, deviceNameProblem } from './protocol.js';

export const settings = { normalise: normaliseSettings, changed: settingsChanged };

/** Names Dante will take on the wire — `protocol.rs`'s rules, checked before anything is sent. */
const validate = (tx) => channelReferenceProblem(tx.channel) || (tx.device === '.' ? null : deviceNameProblem(tx.device));

/** A plan's fingerprint: what the page was shown must still be what is applied. */
const digestOf = (planned) => createHash('sha256')
  .update(JSON.stringify(planned.filter((p) => p.outcome === 'change').map((p) => [p.rx.device, p.rx.channel, p.tx])))
  .digest('hex').slice(0, 16);

export default async function activate(ctx) {
  let current = ctx.settings.get();
  const supervisor = new DanteSupervisor({ pollMs: current.pollSeconds * 1000, log: ctx.log });
  let discovery = null;
  let snapshots = [];

  const manualList = () => current.manualDevices.map(parseAddress).filter(Boolean);

  const snapshot = () => ({
    devices: supervisor.describe(),
    discovery: discovery ? discovery.describe() : { running: false, multicast: false, asking: [], lastBrowse: null, error: null },
    interfaces: localInterfaces(),
    snapshots: snapshots.map((s) => ({
      name: s.name, savedAt: s.savedAt, devices: s.devices.map((d) => d.name),
      routes: s.devices.reduce((n, d) => n + d.rx.filter((c) => c.sub).length, 0)
    }))
  });

  /* ------------------------------------------------------------ live */

  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('dante', snapshot()) });
  let pending = null;
  const announce = () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; stream.send('dante', snapshot()); }, 120);
    pending.unref?.();
  };
  supervisor.on('change', announce);

  async function startDiscovery() {
    if (discovery) { discovery.stop(); discovery = null; }
    const target = parseAddress(current.discoveryTarget);
    const manual = manualList();
    if (!current.discovery && !manual.length) { supervisor.apply([], []); announce(); return; }
    discovery = new Discovery({
      multicast: current.discovery,
      interfaceAddress: current.interface,
      target: target ? { address: target.address, port: target.port ?? 5353 } : null,
      manual,
      browseMs: current.browseSeconds * 1000,
      log: ctx.log
    });
    discovery.on('change', (list) => supervisor.apply(list, manualList()));
    supervisor.apply([], manual);
    await discovery.start();
    announce();
  }

  ctx.onDispose(() => {
    if (pending) clearTimeout(pending);
    if (discovery) discovery.stop();
    supervisor.stop();
  });

  const stored = ctx.storage ? await ctx.storage.load('dante-snapshots') : null;
  snapshots = normaliseSnapshots(stored);
  await startDiscovery();

  ctx.settings.onChange(async (next) => {
    current = normaliseSettings(next);
    supervisor.setPoll(current.pollSeconds * 1000);
    await startDiscovery();
  });

  /* ----------------------------------------------------------- writes */

  /**
   * Plan routes against the devices as last read, send the changes, read the
   * receivers back and say what they report. `dryRun` stops after the plan.
   */
  async function apply(routes, { dryRun = false } = {}) {
    const planned = plan(supervisor.describe(), routes, { validate });
    if (dryRun) return { ok: true, dryRun: true, results: planned, summary: summarise(planned), digest: digestOf(planned) };
    const byDevice = changesByDevice(planned);
    if (!byDevice.size) return { ok: failed(planned).length === 0, results: planned, summary: summarise(planned) };
    const failures = await supervisor.write(byDevice);
    const results = confirm(planned, supervisor.describe(), failures);
    const bad = failed(results);
    return { ok: bad.length === 0, results, summary: summarise(results), ...(bad.length ? { error: bad.map((r) => r.error).filter(Boolean).slice(0, 3).join('; ') } : {}) };
  }

  async function saveSnapshots() {
    if (ctx.storage) await ctx.storage.save('dante-snapshots', { snapshots });
    announce();
  }

  const findSnapshot = (name) => snapshots.find((s) => s.name.toLowerCase() === String(name ?? '').trim().toLowerCase()) || null;

  async function recall(name, { dryRun = false } = {}) {
    const snap = findSnapshot(name);
    if (!snap) return { ok: false, error: `no Dante snapshot called “${name}”` };
    return apply(snapshotRoutes(snap), { dryRun });
  }

  /* ------------------------------------------------------------ routes */

  ctx.route('GET', '/', (req, res, h) => h.json(200, snapshot()));

  ctx.route('POST', '/refresh', async (req, res, h) => {
    const body = await h.readJson(4 * 1024).catch(() => ({}));
    await supervisor.refresh(body && body.device ? String(body.device) : null);
    h.json(200, snapshot());
  });

  ctx.route('POST', '/apply', async (req, res, h) => {
    const body = await h.readJson(256 * 1024);
    const routes = Array.isArray(body.routes) ? body.routes : [];
    if (!routes.length) throw new ctx.HttpError(400, 'no routes to apply');
    if (routes.length > 4096) throw new ctx.HttpError(400, 'too many routes in one request');
    const result = await apply(routes, { dryRun: Boolean(body.dryRun) });
    h.json(result.ok ? 200 : 409, result);
  });

  /* Dante Controller presets. */
  ctx.route('GET', '/preset', (req, res, h) => {
    const names = (h.url.searchParams.get('devices') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const all = supervisor.describe().filter((d) => d.status === 'ok');
    const devices = names.length ? names.map((n) => findDevice(all, n)).filter(Boolean) : all;
    if (!devices.length) throw new ctx.HttpError(409, 'no Dante device has been read yet');
    const name = (h.url.searchParams.get('name') || '').trim() || `LivePremier Plus ${formatLocal(Date.now())}`;
    const xml = writePreset({ name, devices });
    res.writeHead(200, {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': `attachment; filename="${presetFileName(name)}"`,
      'cache-control': 'no-store'
    });
    res.end(xml);
  });

  function presetPlan(body) {
    let preset;
    try { preset = readPreset(String(body.xml ?? '')); } catch (err) { throw new ctx.HttpError(400, err.message); }
    const devices = supervisor.describe();
    const assignments = assignRoles(preset, devices, body.assign && typeof body.assign === 'object' ? body.assign : {});
    const routes = presetRoutes(preset, devices, assignments);
    const planned = plan(devices, routes, { validate });
    /* Keep which role asked, and whether the preset said it or Dante Controller's rule implies it. */
    const meta = new Map(routes.map((r) => [`${r.rx.device.toLowerCase()}\u0000${r.rx.channel}`, r]));
    for (const p of planned) {
      const m = meta.get(`${String(p.rx.device).toLowerCase()}\u0000${p.rx.channel}`);
      if (m) { p.role = m.role; if (m.implied) p.implied = true; }
    }
    return {
      preset: { name: preset.name, version: preset.version, roles: preset.roles.map((r) => ({ name: r.name, rx: r.rx.length, tx: r.tx.length, model: r.model, manufacturer: r.manufacturer })) },
      assignments,
      planned
    };
  }

  ctx.route('POST', '/preset/diff', async (req, res, h) => {
    const body = await h.readJson(MAX_PRESET_BYTES + 64 * 1024);
    const { preset, assignments, planned } = presetPlan(body);
    h.json(200, { ok: true, preset, assignments, results: planned, summary: summarise(planned), digest: digestOf(planned) });
  });

  ctx.route('POST', '/preset/apply', async (req, res, h) => {
    const body = await h.readJson(MAX_PRESET_BYTES + 64 * 1024);
    const { planned } = presetPlan(body);
    if (!body.digest || body.digest !== digestOf(planned)) {
      throw new ctx.HttpError(409, 'the routing changed since the difference was shown — look at it again before applying');
    }
    const routes = planned.filter((p) => p.outcome === 'change').map((p) => ({ rx: p.rx, tx: p.tx }));
    const result = routes.length ? await apply(routes) : { ok: true, results: [], summary: 'nothing to do' };
    h.json(result.ok ? 200 : 409, result);
  });

  /* Snapshots. */
  ctx.route('GET', '/snapshots', (req, res, h) => h.json(200, { snapshots }));

  ctx.route('POST', '/snapshots', async (req, res, h) => {
    const body = await h.readJson(64 * 1024);
    const name = String(body.name ?? '').trim();
    if (!name) throw new ctx.HttpError(400, 'a snapshot needs a name');
    const devices = supervisor.describe().filter((d) => d.status === 'ok');
    const snap = snapshotOf(devices, name, Array.isArray(body.devices) ? body.devices.map(String) : [], new Date().toISOString());
    if (!snap || !snap.devices.length) throw new ctx.HttpError(409, 'there is no receiving device to save');
    snapshots = normaliseSnapshots([...snapshots.filter((s) => s.name.toLowerCase() !== name.toLowerCase()), snap]);
    await saveSnapshots();
    h.json(200, { ok: true, snapshot: snap, ...snapshot() });
  });

  ctx.route('POST', '/snapshots/delete', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const snap = findSnapshot(body.name);
    if (!snap) throw new ctx.HttpError(404, 'no such snapshot');
    snapshots = snapshots.filter((s) => s !== snap);
    await saveSnapshots();
    h.json(200, { ok: true, ...snapshot() });
  });

  ctx.route('POST', '/snapshots/recall', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const result = await recall(body.name, { dryRun: Boolean(body.dryRun) });
    h.json(result.ok ? 200 : 409, result);
  });

  /* ------------------------------------------------ contribution points */

  /* The snapshots travel in the setup file. The Dante network belongs to the
     installation, not to one switcher, so the section does too. */
  ctx.contribute('configSection', {
    key: 'danteSnapshots',
    group: 'installation',
    label: 'Dante routing snapshots',
    export: () => (snapshots.length ? snapshots : undefined),
    async import(data) {
      snapshots = normaliseSnapshots(data);
      await saveSnapshots();
    }
  });

  ctx.contribute('oscAddress', {
    prefix: OSC_PREFIX,
    describe: 'Dante subscriptions and routing snapshots — docs/DANTE.md',
    entries: DANTE_OSC,
    async handle(address, args) {
      const parsed = parseDanteOsc(address, args);
      if (!parsed) return null;
      if (parsed.error) return { ok: false, error: parsed.error };
      if (parsed.released) return { ok: true, summary: `${address} — released, nothing sent`, count: 0 };
      const result = parsed.snapshot
        ? await recall(findSnapshot(parsed.snapshotExact) ? parsed.snapshotExact : parsed.snapshot)
        : await apply([parsed.route]);
      const sent = (result.results || []).filter((r) => r.outcome === 'confirmed').length;
      return result.ok
        ? { ok: true, summary: `Dante: ${result.summary}`, count: sent }
        : { ok: false, summary: `Dante: ${result.summary || ''}`, error: result.error || result.summary || 'not applied' };
    }
  });
}
