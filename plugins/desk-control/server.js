/*
 * Desk control — the plugin's server half.  ** PREVIEW **
 *
 * A lighting desk driving the switcher over Art-Net or sACN, with no browser
 * open. `supervisor.js` does it and argues how; this puts it on the app.
 *
 * Routes, under `/__lpp/desk-control`:
 *
 *     GET  /state            the patch, the sockets, who is in control, recent events
 *     GET  /stream           server-sent `desk` events as they happen
 *     GET  /gdtf/<kind>      the fixture file for master, screen or layer
 *     GET  /patch.csv        the patch, for Titan's import or a printout
 *     GET  /patch.mvr        the patch with its GDTF files, for MA3, MagicQ, Vectorworks
 *
 * With "Be a media server for the desk" on as well (`deskCitp`), the switcher is also a
 * CITP media server on the network (`citp.js`), for as long as it listens.
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; "Listen for a lighting
 * desk" (`deskEnabled`) says whether it opens the ports. That starts off: it
 * listens on the network, which nothing else in this app does by default, and
 * it writes to a switcher.
 */

import { DeskSupervisor } from './supervisor.js';
import { normaliseDesk, deskChanged, allowed } from './core.js';
import { CitpPeer } from './citp.js';
import { mediaModel, elementSource, SWATCHES } from './media.js';
import { picture, cardFor, decodeSnapshot } from './pictures.js';
import { patchCsv, sourceValue } from '../../src/core/dmx-personality.js';
import { gdtfFile, gdtfName, FIXTURE_KINDS } from '../../src/core/desk-gdtf.js';
import { mvrFile, stableUuid } from '../../src/core/desk-mvr.js';

export const settings = {
  normalise: normaliseDesk,
  changed: deskChanged,
};

/* The fixture files' revision. Bumped whenever a channel moves, so a desk's
   library keeps both and an old show file still finds its own. */
export const GDTF_VERSION = '2';

const SNAPSHOT_TIMEOUT_MS = 3000;
/* A desk asking for 40 thumbnails and then the libraries' own asks for the same pictures twice. */
const SNAPSHOT_KEEP_MS = 2000;

export default async function activate(ctx) {
  const desk = new DeskSupervisor({
    deviceHost: () => {
      const device = ctx.device();
      return device ? String(device).split(':')[0] : null;
    },
    timecode: () => ctx.use('timecode'),
    triggers: () => ctx.use('triggers'),
    log: ctx.log,
  });

  /* ------------------------------------------------- the CITP face */

  let peer = null;
  const sizes = new Map();
  const snapshots = new Map();
  const model = () => mediaModel({
    fixtures: desk.patch.fixtures, facts: desk.facts, sources: desk.layerSources, protocol: ctx.settings.get().deskProtocol, sizes,
  });

  /** A source's snapshot from the switcher, decoded, or null where it has none. */
  async function snapshot(source) {
    const device = ctx.device();
    const dialect = desk.switcher.dialect;
    const value = dialect && source ? sourceValue(dialect.id, source) : null;
    const path = value && dialect.snapshotUrl ? dialect.snapshotUrl(value) : null;
    if (!device || !path) return null;
    const kept = snapshots.get(path);
    if (kept && Date.now() - kept.at < SNAPSHOT_KEEP_MS) return kept.img;
    let img = null;
    try {
      const res = await fetch(`http://${device}${path}`, { signal: AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) });
      if (res.ok) img = decodeSnapshot(new Uint8Array(await res.arrayBuffer()));
    } catch { /* no picture, then: a card */ }
    if (img && source.kind === 'LIVE') sizes.set(source.number, { width: img.width, height: img.height });
    snapshots.set(path, { at: Date.now(), img });
    return img;
  }

  async function thumbnail({ library, element, format, width, height, bgr }) {
    const lib = model().libraries[library];
    const source = elementSource(lib, element);
    const img = (source && source.number ? await snapshot(source) : null) || cardFor(SWATCHES[lib?.kind] || [0, 0, 0], width, height);
    return picture(img, { format, width, height, bgr });
  }

  async function frame({ source, format, width, height, bgr, limit }) {
    const img = await snapshot({ kind: 'LIVE', number: source });
    return img ? picture(img, { format, width, height, bgr, ...(limit ? { limit } : {}) }) : null;
  }

  /** Run the CITP face while listening with it on; a new switcher is a new server UUID. */
  function followCitp() {
    const s = ctx.settings.get();
    const want = !!(s.deskEnabled && s.deskCitp);
    const host = desk.deviceHost() || '';
    if (peer && (!want || peer.host !== host)) {
      peer.stop();
      peer = null;
      snapshots.clear();
    }
    if (!want || peer) return;
    const version = String(ctx.use('app')?.version || '0.0.0').split('.').map((n) => Number.parseInt(n, 10) || 0);
    peer = new CitpPeer({
      name: `LivePremier Plus${host ? ` - ${host}` : ''}`,
      uuid: stableUuid('citp', host),
      productVersion: version,
      model,
      refresh: () => desk.readLayerSources(),
      thumbnail,
      frame,
      ifaces: () => desk.interfaceAddresses(),
      allow: (ip) => allowed(normaliseDesk(ctx.settings.get()), ip),
      log: ctx.log,
    });
    peer.host = host;
    peer.on('activity', changed);
    void peer.start().then(changed);
  }

  const describe = () => ({ ...desk.describe(), citp: peer ? peer.describe() : null });

  const live = ctx.stream('/stream', { onOpen: (first) => first.send('desk', describe()) });
  /* A desk sends 44 frames a second; the card does not need to hear of each. */
  let pending = null;
  function changed() {
    if (pending) return;
    pending = setTimeout(() => { pending = null; live.send('desk', describe()); }, 200);
    pending.unref?.();
  }
  desk.on('activity', changed);

  ctx.route('GET', '/state', (req, res, h) => h.json(200, describe()));

  for (const kind of FIXTURE_KINDS) {
    ctx.route('GET', `/gdtf/${kind}`, (req, res) => {
      const buf = Buffer.from(gdtfFile(kind, { version: GDTF_VERSION }));
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${gdtfName(kind, GDTF_VERSION)}"`,
        'content-length': buf.length,
        'cache-control': 'no-store',
      });
      res.end(buf);
    });
  }

  ctx.route('GET', '/patch.csv', (req, res) => {
    const buf = Buffer.from(patchCsv(desk.patch.fixtures), 'utf8');
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="livepremier-plus-patch.csv"',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  });

  ctx.route('GET', '/patch.mvr', (req, res) => {
    const buf = Buffer.from(mvrFile(desk.patch.fixtures, {
      version: GDTF_VERSION,
      host: desk.deviceHost() || '',
      providerVersion: ctx.use('app')?.version || '',
      protocol: ctx.settings.get().deskProtocol,
    }));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': 'attachment; filename="livepremier-plus-patch.mvr"',
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  });

  ctx.settings.onChange((next) => { void desk.apply(next).then(followCitp); });
  ctx.onDispose(() => {
    clearTimeout(pending);
    peer?.stop();
    desk.stop();
  });

  await desk.apply(ctx.settings.get());
  followCitp();
}
