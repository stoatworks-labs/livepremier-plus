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
 *     GET  /d4/<kind>        the same for Avolites Titan, a .d4 personality
 *     GET  /titan.zip        all three .d4 files
 *     GET  /ma2/<kind>/<mode>  the same for grandMA2, a fixture type per mode
 *     GET  /ma2.zip          every grandMA2 fixture type, all modes
 *     GET  /patch.csv        the patch, for Titan's import or a printout
 *     GET  /patch.mvr        the patch with its GDTF files, for MA3, MagicQ, Vectorworks
 *
 * With "Be a media server for the desk" on as well (`deskCitp`), the switcher is also a
 * CITP media server on the network (`citp.js`), for as long as it listens.
 *
 * With "Send pictures to the desk over NDI" on (`deskNdi`), each patched screen's
 * program and the layers go out as NDI feeds (`ndi.js`), through the media host
 * (`server/media-host.js`): the desktop app only, as NDI's licence has it.
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists; "Listen for a lighting
 * desk" (`deskEnabled`) says whether it opens the ports. That starts off: it
 * listens on the network, which nothing else in this app does by default, and
 * it writes to a switcher.
 */

import { DeskSupervisor } from './supervisor.js';
import { normaliseDesk, deskChanged, allowed, NDI_SIZES } from './core.js';
import { CitpPeer } from './citp.js';
import { mediaModel, elementSource, SWATCHES } from './media.js';
import { picture, cardFor, decodeSnapshot } from './pictures.js';
import { feedsFor, imageKey, screenScene, layersScene, layerScene } from './ndi.js';
import { fitWidth } from '../../server/image/resize.js';
import { patchCsv, sourceValue } from '../../src/core/dmx-personality.js';
import { gdtfFile, gdtfName, FIXTURE_KINDS } from '../../src/core/desk-gdtf.js';
import { mvrFile, stableUuid } from '../../src/core/desk-mvr.js';
import { d4Xml, d4Name, d4Zip } from '../../src/core/desk-d4.js';
import { ma2Xml, ma2Name, ma2Zip } from '../../src/core/desk-ma2.js';
import { FIXTURES } from '../../src/core/dmx-personality.js';

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
/* How often an NDI feed someone is watching is drawn again: CITP's preview rate. */
const NDI_EVERY_MS = 1000;
/* A snapshot is never drawn larger than this on a desk's video window; the media host need not be sent more. */
const NDI_IMAGE_WIDTH = 640;

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

  /* ------------------------------------------------- the NDI face */

  const media = () => ctx.use('media')?.client('desk-control') || null;
  let ndiFeeds = [];
  let ndiTimer = null;
  let ndiBusy = false;
  const ndiCounts = { drawn: 0, sent: 0 };
  let ndiError = null;

  /** Ask the media host for the feeds the settings and the patch make, or for none. */
  function followNdi() {
    const s = ctx.settings.get();
    const want = !!(s.deskEnabled && s.deskNdi);
    ndiFeeds = want ? feedsFor(desk.patch.fixtures, { perLayer: s.deskNdiPerLayer }) : [];
    media()?.setFeeds(ndiFeeds.map(({ id, name }) => ({ id, name })));
    if (want && !ndiTimer) {
      ndiTimer = setInterval(() => { void ndiTick(); }, NDI_EVERY_MS);
      ndiTimer.unref?.();
    } else if (!want && ndiTimer) {
      clearInterval(ndiTimer);
      ndiTimer = null;
      ndiError = null;
    }
  }

  /** `LIVE_3` → the `{kind, number}` `snapshot` takes. A Midra's `INPUT_3` is a live input. */
  const sourceOf = (key) => {
    const m = /^([A-Z]+)_(\d+)$/.exec(key);
    return m ? { kind: m[1] === 'INPUT' ? 'LIVE' : m[1], number: Number(m[2]) } : null;
  };

  /**
   * One round: what is on program read off the switcher, snapshots of what
   * it shows, and a picture for each feed somebody is receiving. A feed
   * nobody receives is not drawn, and with none received the switcher is
   * not asked anything.
   */
  async function ndiTick() {
    const client = media();
    if (ndiBusy || !client || !client.available) return;
    const states = new Map(client.feeds().map((f) => [f.id, f]));
    const watched = ndiFeeds.filter((f) => (states.get(f.id)?.connections || 0) > 0);
    if (!watched.length) return;
    ndiBusy = true;
    try {
      const { looks } = await desk.readProgram({ look: true });
      const keys = new Set();
      for (const look of looks.values()) for (const l of look.layers) { const k = imageKey(l.source); if (k) keys.add(k); }
      const images = {};
      await Promise.all([...keys].map(async (k) => {
        const source = sourceOf(k);
        const img = source ? await snapshot(source) : null;
        if (img) images[k] = fitWidth(img, NDI_IMAGE_WIDTH);
      }));
      const s = ctx.settings.get();
      const size = NDI_SIZES.find((z) => z.id === s.deskNdiSize) || NDI_SIZES[0];
      const fixtures = desk.patch.fixtures;
      for (const f of watched) {
        const scene = f.kind === 'screen' ? screenScene(f.destination, looks.get(f.destination), { size, facts: desk.facts, images })
          : f.kind === 'layers' ? layersScene(fixtures, looks, { size, facts: desk.facts, images })
            : layerScene(fixtures.find((x) => x.kind === 'layer' && x.destination === f.destination && x.layer === f.layer) || { destination: f.destination, layer: f.layer }, looks, { facts: desk.facts, images });
        /* Only the pictures this scene draws cross to the media host. */
        const used = Object.fromEntries(scene.ops.filter((o) => o.op === 'image' && images[o.image]).map((o) => [o.image, images[o.image]]));
        ndiCounts.drawn++;
        if (client.frame(f.id, scene, used)) ndiCounts.sent++;
      }
      if (ndiError) { ndiError = null; changed(); }
    } catch (err) {
      if (ndiError !== err.message) { ndiError = err.message; changed(); }
    } finally {
      ndiBusy = false;
    }
  }

  function describeNdi() {
    const s = ctx.settings.get();
    if (!s.deskEnabled || !s.deskNdi) return null;
    const service = ctx.use('media');
    const status = service ? service.status() : null;
    const client = media();
    return {
      available: !!(client && client.available),
      reason: client ? client.reason : 'This app has no media host.',
      runtime: status ? status.runtime : null,
      feeds: client ? client.feeds() : [],
      counts: { ...ndiCounts },
      error: ndiError,
    };
  }
  const offMedia = ctx.use('media')?.onStatus?.(() => changed()) || null;

  const describe = () => ({ ...desk.describe(), citp: peer ? peer.describe() : null, ndi: describeNdi() });

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

  /* A fixture file, as a download. */
  const file = (res, name, data) => {
    const buf = Buffer.from(data);
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': buf.length,
      'cache-control': 'no-store',
    });
    res.end(buf);
  };
  const version = { version: GDTF_VERSION };
  for (const kind of FIXTURE_KINDS) {
    ctx.route('GET', `/gdtf/${kind}`, (req, res) => file(res, gdtfName(kind, GDTF_VERSION), gdtfFile(kind, version)));
    ctx.route('GET', `/d4/${kind}`, (req, res) => file(res, d4Name(kind), d4Xml(kind, version)));
    for (const mode of Object.keys(FIXTURES[kind].modes)) {
      ctx.route('GET', `/ma2/${kind}/${mode}`, (req, res) => file(res, ma2Name(kind, mode), ma2Xml(kind, mode, version)));
    }
  }
  ctx.route('GET', '/titan.zip', (req, res) => file(res, 'livepremier-plus-titan.zip', d4Zip(version)));
  ctx.route('GET', '/ma2.zip', (req, res) => file(res, 'livepremier-plus-grandma2.zip', ma2Zip(version)));

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

  ctx.settings.onChange((next) => { void desk.apply(next).then(() => { followCitp(); followNdi(); }); });
  ctx.onDispose(() => {
    clearTimeout(pending);
    clearInterval(ndiTimer);
    offMedia?.();
    media()?.setFeeds([]);
    peer?.stop();
    desk.stop();
  });

  await desk.apply(ctx.settings.get());
  followCitp();
  followNdi();
}
