/*
 * LivePremier Plus — the reverse proxy that puts our panels inside the
 * vendor's own Web RCS.
 *
 * This replaces a Chrome extension, and it is worth being precise about why
 * it can. An MV3 content script at `document_start` races the vendor bundle:
 * it usually wins, but nothing in the platform promises it. Here we own the
 * HTML, and every vendor script tag is `defer` — so a plain inline script
 * written into <head> is ordered by the parser to run strictly before
 * boot.js and app.js. That is a guarantee rather than a race, and it is the
 * one thing the hook absolutely requires.
 *
 * Four things this has to get right:
 *
 *  1. Do not rewrite URLs. Every asset the Web RCS references is
 *     root-absolute (`/styles/app.<hash>.css`, `/app.<hash>.js`), so a
 *     path-preserving proxy needs no rewriting at all. Resist adding any —
 *     the vendor's hashes change every firmware and a rewriter would be one
 *     more thing to keep in step.
 *  2. Stream everything except the document. `GET /api/stores/device` is over
 *     100 MB; buffering it to inject into it would be absurd, and it is not
 *     HTML anyway. Only `text/html` is ever collected into memory.
 *  3. Relay the WebSocket at the byte level. The vendor computes
 *     `ws://${location.host}`, which is us, so nothing in the page needs
 *     patching — and because we hold exactly one upstream connection, the
 *     device's client count still reads true.
 *  4. Never let our own failure take the vendor UI down. A broken panel
 *     should look like a missing panel, not a dead console.
 */

import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

import {
  normalise as normaliseSettings, DEFAULT_SETTINGS, oscChanged, pixelhueChanged,
} from '../src/core/settings.js';
import { companionChanged } from '../src/core/companion.js';
import {
  CompanionLink, MOUNT as COMPANION_MOUNT, proxyToCompanion, relayUpgradeToCompanion,
} from './companion.js';
import { exchange as awjExchange } from './awj.js';
import { importMemories, exportMemories } from './memory-import.js';
import { createOscServer } from './osc.js';
import { loopbackRedirect } from './local-client.js';
import { MatrixSupervisor } from './matrix/index.js';
import { PixelhueSupervisor } from './pixelhue/index.js';
import {
  buildConfig, applyConfig, summarise as summariseConfig,
  validate as validateConfig, DEFAULT_IMPORT,
} from './config-file.js';
import {
  normaliseMatrices, normalisePatch, validate as validatePatch,
  feed as patchFeed, send as patchSend, groupCrosspoints, toPortList,
  resolveMatrixOsc,
} from '../src/core/patch.js';

/** Where our own routes live. Namespaced so it cannot collide with a vendor path. */
export const NS = '/__lpp';

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

/** Plain host or IP only, before anything reaches net.connect. */
export function validHost(h) {
  return typeof h === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(h);
}

/**
 * Split "host" or "host:port" into parts, defaulting to the Web RCS port.
 *
 * A real device serves the UI on 80; the simulator uses 3000. Both are just
 * "the HTTP port the app is on" as far as this is concerned.
 */
export function splitDevice(device, fallbackPort = 80) {
  const m = String(device).match(/^([^:]+)(?::(\d+))?$/);
  if (!m || !validHost(m[1])) return null;
  const port = m[2] ? Number(m[2]) : fallbackPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

/**
 * Build the fragment injected into <head>.
 *
 * The hook goes in as an inline classic script rather than a src= tag: a
 * classic script with a src is *also* deferred relative to nothing, but an
 * inline one is guaranteed to execute at the point the parser reaches it,
 * which is before any deferred vendor script. The panels follow as a module,
 * which is deferred by definition and lands after the vendor bundle — exactly
 * where we want it, since it needs the app's DOM.
 */
export function buildInjection(hookSource, extraModules = []) {
  const extra = extraModules
    .map((src) => `\n<script type="module" src="${src}" data-lpp="extra"></script>`)
    .join('');
  return (
    `\n<script data-lpp="hook">\n${hookSource}\n</script>` +
    `\n<script type="module" src="${NS}/src/main.js" data-lpp="panels"></script>` +
    /* After the panels, so anything extra can rely on window.__WRU existing —
       modules execute in document order. Used by the demo environment to fold
       a recorded capture into a live store; empty in normal use. */
    `${extra}\n`
  );
}

/** Decompress an upstream body according to its Content-Encoding. */
function decode(buf, encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case 'gzip': return zlib.gunzipSync(buf);
    case 'deflate': return zlib.inflateSync(buf);
    case 'br': return zlib.brotliDecompressSync(buf);
    default: return buf;
  }
}

/**
 * Create the proxy server.
 *
 * @param {object} opts
 * @param {string} opts.device        host or host:port of the Web RCS
 * @param {number} [opts.devicePort]  default port when `device` carries none
 * @param {string} opts.root          repo root, where src/ is served from
 * @param {object} [opts.storage]     {load(), save(data)} for cue stacks
 * @param {string[]} [opts.extraModules]  extra module URLs to inject after the panels
 * @param {Record<string,string>} [opts.extraFiles]  NS-relative path -> file on disk
 * @param {(msg:string)=>void} [opts.log]
 */
export async function createProxy({
  device = null, devicePort = 80, root, storage = null,
  extraModules = [], extraFiles = {}, log = () => {},
  /* Recorded in an exported configuration file, so a document says which
     build wrote it. Cosmetic; an empty string is fine. */
  appVersion = '',
  /* The port a loopback listener answers on, when this server is also bound
     to a LAN address — see local-client.js. Null means never redirect. */
  loopbackPort = null
}) {
  /*
   * The switcher is chosen at runtime, not baked in at startup.
   *
   * Every other launcher in the fleet picks an interface and a port and is
   * done; this one also has to be pointed at a device, and a show operator
   * changes that more often than they restart anything. Keeping it here —
   * rather than as a startup flag the launcher would need a new field for —
   * means the desktop shell needs no special case at all, and re-pointing at
   * the backup frame costs a form submission instead of a restart.
   */
  let target = null;
  if (device) {
    target = splitDevice(device, devicePort);
    if (!target) throw new Error(`invalid device address: ${device}`);
  }

  /* Read the hook off disk once, at startup. Keeping it as a real file rather
     than a string in here means the tests and any future front-end load the
     same bytes the browser gets. */
  const hookSource = await readFile(join(root, 'src/hook/ws-hook.js'), 'utf8');
  const injection = buildInjection(hookSource, extraModules);

  /* Shown until a switcher is chosen. Self-contained on purpose: at this
     point there is no device to borrow a stylesheet from. */
  const setupPage = await readFile(join(root, 'server/setup.html'), 'utf8');

  /* The popped-out console. A document of ours rather than a proxied one, so
     it is served from here and not fetched from the switcher — but it must be
     on this origin, because it drives the Web RCS tab's own session through
     `window.opener` and that only works same-origin. */
  const consolePage = await readFile(join(root, 'server/console.html'), 'utf8');
  /* And the timeline editor, the memory banks and the layer properties, all on
     the same terms. Each is one route and one document; what makes them worth
     having separately is that an operator puts different ones on different
     monitors. */
  const popoutPages = {
    '/timeline': await readFile(join(root, 'server/timeline.html'), 'utf8'),
    '/memories': await readFile(join(root, 'server/memories.html'), 'utf8'),
    '/properties': await readFile(join(root, 'server/properties.html'), 'utf8')
  };

  /*
   * Our own version, read off the manifest rather than duplicated in a
   * constant — the settings page prints it, and a number that has to be kept
   * in step by hand is a number that will eventually be wrong. A build that
   * cannot read it says so instead of inventing one.
   */
  let version = null;
  try { version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version || null; }
  catch { version = null; }

  const state = { device: target ? `${target.host}:${target.port}` : null, clients: 0, upstreamError: null, version };

  /*
   * Settings, and the UDP socket one of them opens.
   *
   * Loaded once at startup and held in memory: the panels read them on every
   * repaint, and hitting the disk for that would be silly. `src/core/settings.js`
   * owns what is allowed — a stored file that a person has edited is coerced
   * rather than rejected, because refusing to start over one bad field would
   * take the app down for a typo.
   */
  let settings = normaliseSettings(storage && storage.loadSettings ? await storage.loadSettings() : {});

  /* Ring buffer of what the OSC listener has heard, so a console opened after
     a message arrived can still show it. Small on purpose — this is a tail for
     debugging a sender, not a log. */
  const OSC_HISTORY = 100;
  const oscHistory = [];
  const oscListeners = new Set();
  let osc = null;

  function noteOsc(entry) {
    oscHistory.unshift(entry);
    if (oscHistory.length > OSC_HISTORY) oscHistory.length = OSC_HISTORY;
    const line = `event: osc\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const listener of oscListeners) {
      try { listener.write(line); } catch { oscListeners.delete(listener); }
    }
  }

  /**
   * Bring the OSC listener into line with the settings.
   *
   * Always stops first, even when only the port changed: rebinding a UDP
   * socket that is still open fails with EADDRINUSE against *itself*, which
   * reads as somebody else holding the port and sends whoever is debugging it
   * a long way in the wrong direction.
   */
  async function applyOsc() {
    if (osc) { await osc.stop(); osc = null; }
    if (!settings.oscEnabled) return;
    osc = createOscServer({
      port: settings.oscPort,
      address: settings.oscBind,
      /* Read per message, not captured — re-pointing at a backup frame must
         re-point the OSC input too, and an input still driving the old box
         would be the worst possible version of that feature. */
      deviceHost: () => (target ? target.host : null),
      /* Read per message for the same reason `deviceHost` is: both the patch
         and the routers can change under a listener that is already bound. */
      matrix: {
        patch: () => patch,
        route: (groups) => matrices.route(groups),
      },
      onActivity: noteOsc,
      log,
    });
    await osc.start();
  }
  /*
   * The external routers, and the cable schedule to them.
   *
   * Two different lifetimes, deliberately. The **matrix list** is part of the
   * installation and is loaded once: a router in the rack does not move when
   * the app is re-pointed at a backup frame, and dropping its connection
   * because somebody failed over would be the opposite of helpful. The
   * **patch** is this frame's own cabling, so it is keyed by device and
   * re-read whenever `state.device` changes.
   *
   * `server/matrix/index.js` argues at the top why this holds sockets open
   * when `server/awj.js` refuses to. The short version: there is no store
   * mirror for a Videohub to contradict, and its crosspoints move without us.
   */
  const matrices = new MatrixSupervisor({ log });
  const matrixListeners = new Set();
  matrices.on('change', () => {
    const line = `event: matrix\ndata: ${JSON.stringify(matrices.describe())}\n\n`;
    for (const listener of matrixListeners) {
      try { listener.write(line); } catch { matrixListeners.delete(listener); }
    }
  });

  let matrixConfig = normaliseMatrices(
    storage && storage.loadMatrices ? await storage.loadMatrices() : []);
  matrices.apply(matrixConfig);

  /*
   * The link to a Companion.
   *
   * Installation-level, like the OSC listener and the matrices: a control
   * surface in the rack does not move when you fail over to a backup frame,
   * so re-pointing the switcher must not disturb it. `server/companion.js`
   * carries the argument for why this one holds a socket open, and it is the
   * matrix argument rather than the AWJ one.
   */
  const companion = new CompanionLink(log);
  companion.apply(settings);

  let patch = normalisePatch(
    storage && storage.loadPatch ? await storage.loadPatch(state.device) : []);

  /** Re-read the patch for whatever device we are now pointed at. */
  async function reloadPatch() {
    patch = normalisePatch(
      storage && storage.loadPatch ? await storage.loadPatch(state.device) : []);
  }

  /** Everything a panel needs in one object, so it repaints from one fetch. */
  const matrixSnapshot = () => ({
    matrices: matrices.describe(),
    patch,
    problems: validatePatch(patch, { matrices: matrixConfig, state: matrices.sizes() }),
    routing: matrices.routing(),
  });

  /**
   * Take a patch-derived action and report what reached the wire.
   *
   * The resolution is `core/patch.js`'s and the sending is the supervisor's;
   * this only joins them. A refusal from either is a 409 with the reason in
   * it, because "it did nothing and said OK" is the failure mode that costs
   * somebody a show.
   */
  function runPatchAction(resolved) {
    if (!resolved.ok) return { status: 409, body: { error: resolved.error } };
    const results = matrices.route(groupCrosspoints(resolved.crosspoints));
    const failed = results.filter((r) => !r.ok);
    return {
      status: failed.length ? 409 : 200,
      body: {
        ok: failed.length === 0,
        crosspoints: resolved.crosspoints,
        results,
        ...(failed.length ? { error: failed.map((f) => f.error).join('; ') } : {}),
      },
    };
  }

  await applyOsc();

  /*
   * A Pixelhue console, driven as a peer rather than as a keyboard.  ** PREVIEW **
   *
   * `server/pixelhue/index.js` argues at the top why it may hold a socket to
   * the console while holding nothing open on the switcher. It is installation
   * state like the OSC listener and the matrices — a panel on the desk does
   * not move when the app is re-pointed at a backup frame — so it is applied
   * from settings and survives a device change.
   */
  const pixelhue = new PixelhueSupervisor({
    deviceHost: () => (state.device ? String(state.device).split(':')[0] : null),
    log,
  });
  const pixelhueListeners = new Set();
  pixelhue.on('activity', () => {
    const line = `event: pixelhue\ndata: ${JSON.stringify(pixelhue.describe())}\n\n`;
    for (const listener of pixelhueListeners) {
      try { listener.write(line); } catch { pixelhueListeners.delete(listener); }
    }
  });
  await pixelhue.apply(settings);

  /*
   * Timecode pushed in from outside.
   *
   * The browser can read MTC over Web MIDI and LTC off an audio input all by
   * itself, and does. This is the third way in: a generator on another
   * machine, a lighting desk, a script — anything that can make an HTTP
   * request — POSTs a timecode here and every open page hears it.
   *
   * Held in memory and never written down. Timecode is a *now* value; a
   * position restored from disk at startup would be a lie about the present.
   */
  const timecodeListeners = new Set();
  let lastTimecode = null;

  /*
   * Every socket pair we have relayed.
   *
   * An upgraded connection is detached from the HTTP server's own bookkeeping,
   * so `server.close()` neither counts it nor closes it — it simply waits, and
   * a Web RCS tab holds its socket open indefinitely. The launcher supervises
   * this process and its Stop button has to actually stop it, so shutdown has
   * to hang up the relays itself.
   */
  const relays = new Set();

  async function serveOwn(req, res, url) {
    const rest = url.pathname.slice(NS.length) || '/';

    /*
     * Companion, mounted whole under our own origin.
     *
     * Checked before anything else because it is a *prefix* and every other
     * route here is an exact path — and because what is below it is not ours
     * to interpret. The query string has to be carried across by hand:
     * `url.pathname` has already dropped it, and the emulator identifies
     * itself with one.
     *
     * The mount point is stripped here rather than at the far end. Companion
     * matches its own routes on the unprefixed path and is *told* about the
     * prefix by a header instead — see `server/companion.js`.
     */
    if (rest === COMPANION_MOUNT || rest.startsWith(COMPANION_MOUNT + '/')) {
      const below = rest.slice(COMPANION_MOUNT.length) || '/';
      return proxyToCompanion(req, res, below + (url.search || ''), companion.target, log);
    }

    if (rest === '/timecode') {
      if (req.method === 'GET') return sendJson(res, 200, { timecode: lastTimecode });
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 4096);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const tc = normaliseTimecode(parsed);
        if (!tc) return sendJson(res, 400, { error: 'expected {hours,minutes,seconds,frames} or "hh:mm:ss:ff"' });
        lastTimecode = tc;
        const line = `event: timecode\ndata: ${JSON.stringify(tc)}\n\n`;
        for (const listener of timecodeListeners) {
          /* A page that has gone away without closing cleanly must not stop
             the others being told the time. */
          try { listener.write(line); } catch { timecodeListeners.delete(listener); }
        }
        return sendJson(res, 200, { ok: true, timecode: tc, listeners: timecodeListeners.size });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (rest === '/timecode/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        /* Nginx and friends buffer event streams into uselessness. */
        'x-accel-buffering': 'no'
      });
      res.write(': timecode stream open\n\n');
      if (lastTimecode) res.write(`event: timecode\ndata: ${JSON.stringify(lastTimecode)}\n\n`);
      timecodeListeners.add(res);
      req.on('close', () => timecodeListeners.delete(res));
      return undefined;   /* held open deliberately */
    }

    /*
     * Settings.
     *
     * Server-side rather than in the page because two of them are not the
     * page's business: the OSC listener is a UDP socket in this process, and
     * the console exists in two windows at once — a per-page setting would
     * have the tab and the popout disagreeing about which language the
     * operator chose. See `src/core/settings.js`.
     */
    if (rest === '/settings') {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          settings, osc: osc ? osc.state : null, pixelhue: pixelhue.describe(),
          companion: companion.state,
        });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 16 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

        /* Merged onto what is already held, so a panel may send one field
           without having to restate the rest and without racing another
           surface that is changing a different one. */
        const next = normaliseSettings({ ...settings, ...(parsed.settings ?? parsed) });
        const needsRebind = oscChanged(settings, next);
        /* Diffed for the same reason the matrices are: settings are saved as
           a whole, so a change to the console language must not hang up a
           Companion link — or a Pixelhue panel — that nobody touched. */
        const needsPanel = pixelhueChanged(settings, next);
        const needsRedial = companionChanged(settings, next);
        settings = next;
        if (storage && storage.saveSettings) await storage.saveSettings(settings);
        if (needsRebind) await applyOsc();
        if (needsPanel) await pixelhue.apply(settings);
        if (needsRedial) companion.apply(settings);

        return sendJson(res, 200, {
          ok: true, settings, osc: osc ? osc.state : null, pixelhue: pixelhue.describe(),
          companion: companion.state,
        });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * A real AWJ exchange, on behalf of the page.
     *
     * The browser cannot open TCP 10606; this process can. Note what this is
     * NOT: it never reads into the store mirror, holds no connection and
     * subscribes to nothing. `awj.js` sets out why that keeps the
     * single-source-of-truth rule intact — read it before extending this.
     */
    if (rest === '/awj') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      if (!target) return sendJson(res, 409, { error: 'no switcher configured' });

      const body = await collect(req, 256 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      if (messages.length === 0) return sendJson(res, 400, { error: 'no messages' });

      /* The op set is closed, and it is checked here rather than trusted from
         the page: this is the one route in the app that puts bytes on a socket
         chosen by whatever posted to it. */
      for (const m of messages) {
        if (m.op !== 'replace' && m.op !== 'get') {
          return sendJson(res, 400, { error: 'op must be "replace" or "get" — AWJ has no others' });
        }
        if (typeof m.path !== 'string' || !m.path) {
          return sendJson(res, 400, { error: 'every message needs a path' });
        }
      }

      try {
        const replies = await awjExchange({ host: target.host, messages });
        return sendJson(res, 200, { ok: true, replies });
      } catch (err) {
        /* 502, not 500: the failure is upstream, and saying so is what tells
           an operator to go and check the device's own AWJ setting. */
        return sendJson(res, 502, { error: err.message });
      }
    }

    /*
     * A memory, written into the bank without a bus.
     *
     * The one thing the Edit page asks of the device. It is here and not in
     * the page for two reasons: the browser cannot open TCP 10606, and the
     * file has to be written to a disk. `memory-import.js` has the three-step
     * conversation and the warning about whose filesystem that path is on.
     *
     * A GET reads slots back out, which is how a real memory is loaded into
     * the programmer — a slot's contents are not in the store mirror and never
     * have been.
     */
    if (rest === '/memory') {
      if (!target) return sendJson(res, 409, { error: 'no switcher configured' });
      const dir = settings.memoryImportDir || undefined;

      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await collect(req, 8 * 1024 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

        const memories = Array.isArray(parsed.memories) ? parsed.memories : null;
        if (!memories) return sendJson(res, 400, { error: 'no memories' });

        try {
          const result = await importMemories({ host: target.host, memories, dir });
          log(`memory import: ${result.ok ? 'ok' : 'failed'} ${result.slots.join(', ') || ''}`
            + (result.error ? ' — ' + result.error : ''));
          return sendJson(res, result.ok ? 200 : 502, result);
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }

      if (req.method === 'GET') {
        const slots = (url.searchParams.get('slots') || '')
          .split(',').map((s) => Number(s.trim())).filter(Boolean);
        if (!slots.length) return sendJson(res, 400, { error: 'name at least one slot' });
        try {
          const out = await exportMemories({ host: target.host, slots, dir });
          if (!out.ok) return sendJson(res, 502, out);
          const file = await readFile(out.path, 'utf8');
          return sendJson(res, 200, { ok: true, memories: JSON.parse(file) });
        } catch (err) {
          return sendJson(res, 502, { error: err.message });
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /* What the OSC listener has heard. The tail first, then a live stream, so
       a console opened after a message arrived still shows it. */
    if (rest === '/osc/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(': osc stream open\n\n');
      for (const entry of [...oscHistory].reverse()) {
        res.write(`event: osc\ndata: ${JSON.stringify(entry)}\n\n`);
      }
      oscListeners.add(res);
      req.on('close', () => oscListeners.delete(res));
      return undefined;   /* held open deliberately */
    }

    if (rest === '/console' || popoutPages[rest]) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(rest === '/console' ? consolePage : popoutPages[rest]);
    }

    if (rest === '/status') {
      return sendJson(res, 200, {
        ...state, ok: true, configured: !!target,
        settings, osc: osc ? osc.state : null,
        matrices: matrices.describe()
      });
    }

    if (rest === '/device') {
      if (req.method === 'GET') return sendJson(res, 200, { device: state.device });
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 4096);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        const next = splitDevice(String(parsed.device || ''), devicePort);
        if (!next) return sendJson(res, 400, { error: 'not a valid host or host:port' });

        /* Re-pointing means every relay is now attached to the wrong box.
           Hang them up so the page reconnects to the new one rather than
           quietly driving the old one. */
        server.closeRelays();
        target = next;
        state.device = `${next.host}:${next.port}`;
        state.upstreamError = null;
        if (storage && storage.saveDevice) await storage.saveDevice(state.device);
        /* A patch describes one frame's sockets, so it moves with the frame.
           The matrices deliberately do not — see where they are loaded. */
        await reloadPatch();
        log(`pointed at ${state.device}`);
        return sendJson(res, 200, { ok: true, device: state.device });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * The external matrices.
     *
     * `GET` is the whole picture — routers, their state, the patch and
     * anything wrong with it — because a panel that had to make four requests
     * to draw one grid would draw it inconsistently.
     */
    if (rest === '/matrix') {
      if (req.method === 'GET') return sendJson(res, 200, matrixSnapshot());
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 64 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

        matrixConfig = normaliseMatrices(parsed.matrices ?? parsed);
        if (storage && storage.saveMatrices) await storage.saveMatrices(matrixConfig);
        /* Diff-based: a router whose address did not change keeps its socket
           and its grid. See `MatrixSupervisor.apply`. */
        matrices.apply(matrixConfig);
        return sendJson(res, 200, { ok: true, ...matrixSnapshot() });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    if (rest === '/matrix/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write(': matrix stream open\n\n');
      res.write(`event: matrix\ndata: ${JSON.stringify(matrices.describe())}\n\n`);
      matrixListeners.add(res);
      req.on('close', () => matrixListeners.delete(res));
      return undefined;   /* held open deliberately */
    }

    /* The cable schedule. Per device — see `storage.savePatch`. */
    if (rest === '/matrix/patch') {
      if (req.method === 'GET') {
        return sendJson(res, 200, { patch, problems: matrixSnapshot().problems });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 256 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

        patch = normalisePatch(parsed.patch ?? parsed.entries ?? parsed);
        if (storage && storage.savePatch) await storage.savePatch(state.device, patch);
        return sendJson(res, 200, { ok: true, ...matrixSnapshot() });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * Route.
     *
     * Two verbs and not one, because feeding an input and sending an output
     * are genuinely different operations — see the header of
     * `src/core/patch.js`. One takes a source and yields one crosspoint; the
     * other takes a list of destinations and yields one crosspoint each.
     */
    if (rest === '/matrix/feed' || rest === '/matrix/send') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await collect(req, 16 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

      const connector = String(parsed.connector ?? '');
      const resolved = rest === '/matrix/feed'
        ? patchFeed(patch, connector, Number(parsed.source))
        : patchSend(patch, connector, toPortList(parsed.destinations ?? parsed.destination));

      const { status, body: payload } = runPatchAction(resolved);
      return sendJson(res, status, payload);
    }

    /*
     * One OSC matrix address, resolved and routed.
     *
     * The Console posts here rather than resolving in the page, so that a
     * `/lp/matrix/…` line typed at the keyboard and the same address arriving
     * over UDP take **the same code path** — `resolveMatrixOsc` then the
     * supervisor. Two implementations of one address space is how they drift,
     * and the drift would show up as a command that works from QLab and not
     * from the Console, which is a miserable thing to debug on a show.
     */
    if (rest === '/matrix/osc') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await collect(req, 16 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

      const resolved = resolveMatrixOsc(
        String(parsed.address ?? ''), parsed.args ?? [], patch);
      if (!resolved) return sendJson(res, 404, { error: 'not a matrix address' });
      const { status, body: payload } = runPatchAction(resolved);
      return sendJson(res, status, { ...payload, summary: resolved.summary });
    }

    /*
     * A raw crosspoint, naming the router's own ports.
     *
     * The patch is the point of this feature, but a patch panel needs a way
     * to route a port that is not patched to anything — to prove a cable, or
     * to drive the half of the router the switcher is not on. It takes router
     * numbers directly and consults no patch.
     */
    if (rest === '/matrix/route') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
      const body = await collect(req, 16 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }

      const matrix = String(parsed.matrix ?? '');
      const output = Number(parsed.output);
      const input = Number(parsed.input);
      if (!Number.isInteger(output) || output < 1 || !Number.isInteger(input) || input < 1) {
        return sendJson(res, 400, { error: 'output and input are 1-based port numbers' });
      }
      const { status, body: payload } = runPatchAction({
        ok: true, crosspoints: [{ matrix, output, input }],
      });
      return sendJson(res, status, payload);
    }

    if (rest === '/stack') {
      if (!storage) return sendJson(res, 501, { error: 'no storage configured' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { data: await storage.load(state.device) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 4 * 1024 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        await storage.save(state.device, parsed && parsed.data !== undefined ? parsed.data : parsed);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * Layer groups, on the cue stack's terms.
     *
     * Same shape, same device key, same reason: a group names this box's
     * screens and layer slots and means nothing pointed at another one.
     * Smaller ceiling than the stack's because a group list is a few dozen
     * short rows — a megabyte is already far more than any show could need.
     */
    if (rest === '/groups') {
      if (!storage || !storage.loadGroups) return sendJson(res, 501, { error: 'no storage configured' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { data: await storage.loadGroups(state.device) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 1024 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        await storage.saveGroups(state.device, parsed && parsed.data !== undefined ? parsed.data : parsed);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * Layer names.
     *
     * ⚠️ This route is the **only** way anything outside this browser tab can
     * see a layer name, because the switcher has no field for one — see
     * `src/core/layer-names.js`. A Companion module, a second operator's
     * dashboard or a script reads it from here or not at all, and everything
     * that does gains a dependency on this app being up. That is a real cost
     * and it was chosen deliberately over the alternative, which was for the
     * names not to exist.
     *
     * GET is deliberately unauthenticated like every other route here; the
     * proxy is loopback by default and the note in `server/index.js` about
     * binding it wider applies to this as much as to the rest.
     */
    if (rest === '/layer-names') {
      if (!storage || !storage.loadNames) return sendJson(res, 501, { error: 'no storage configured' });
      if (req.method === 'GET') {
        return sendJson(res, 200, { data: await storage.loadNames(state.device) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 256 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        await storage.saveNames(state.device, parsed && parsed.data !== undefined ? parsed.data : parsed);
        return sendJson(res, 200, { ok: true });
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /*
     * The portable configuration file — everything this app holds, in one
     * document. See `server/config-file.js` for what is in it and why it is
     * split three ways.
     *
     * GET  ?download=1  sets a filename so a browser saves rather than shows it.
     * POST body `{ doc, sections?, device? }` applies one. `sections` defaults
     *      to DEFAULT_IMPORT, which deliberately leaves `settings` out — see
     *      the note in config-file.js about the OSC port.
     */
    if (rest === '/config') {
      if (!storage) return sendJson(res, 501, { error: 'no storage configured' });
      if (req.method === 'GET') {
        const doc = await buildConfig({
          storage,
          deviceKey: state.device,
          appVersion,
          deviceInfo: { platform: state.platform || '' }
        });
        if (url.searchParams.get('download')) {
          const buf = Buffer.from(JSON.stringify(doc, null, 2));
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': 'attachment; filename="livepremier-plus.json"',
            'content-length': buf.length,
            'cache-control': 'no-store'
          });
          return res.end(buf);
        }
        return sendJson(res, 200, { doc, summary: summariseConfig(doc) });
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const body = await collect(req, 8 * 1024 * 1024);
        let parsed;
        try { parsed = JSON.parse(body.toString('utf8')); }
        catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
        /* Accept the document either bare or wrapped, because a file dropped
           on the page and a call from our own UI arrive in different shapes. */
        const doc = parsed && parsed.doc !== undefined ? parsed.doc : parsed;
        try {
          const report = await applyConfig({
            storage,
            deviceKey: (parsed && parsed.device) || state.device,
            doc,
            sections: parsed && parsed.sections
          });
          return sendJson(res, 200, { ok: true, ...report });
        } catch (err) {
          return sendJson(res, 400, { error: err.message });
        }
      }
      return sendJson(res, 405, { error: 'method not allowed' });
    }

    /* What an import would do, without doing it. */
    if (rest === '/config/inspect' && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await collect(req, 8 * 1024 * 1024);
      let parsed;
      try { parsed = JSON.parse(body.toString('utf8')); }
      catch { return sendJson(res, 400, { error: 'invalid JSON' }); }
      const doc = parsed && parsed.doc !== undefined ? parsed.doc : parsed;
      const problem = validateConfig(doc);
      if (problem) return sendJson(res, 400, { error: problem });
      return sendJson(res, 200, {
        summary: summariseConfig(doc),
        defaultSections: DEFAULT_IMPORT,
        device: state.device
      });
    }

    /* Anything a caller registered explicitly, by exact path. Nothing here is
       derived from the request, so there is no traversal surface — the demo
       environment uses it to serve a capture and its seed script. */
    if (Object.prototype.hasOwnProperty.call(extraFiles, rest)) {
      try {
        const body = await readFile(extraFiles[rest]);
        res.writeHead(200, {
          'content-type': TYPES[extname(extraFiles[rest])] || 'application/octet-stream',
          'cache-control': 'no-store'
        });
        return res.end(body);
      } catch (err) {
        log(`extra file ${rest}: ${err.message}`);
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
    }

    /* Our own module tree. Path traversal is stripped before it touches the
       filesystem; only src/ is reachable regardless. */
    const clean = normalize(decodeURIComponent(rest)).replace(/^(\.\.[/\\])+/, '');
    if (!clean.startsWith('/src/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    try {
      const body = await readFile(join(root, clean));
      res.writeHead(200, {
        'content-type': TYPES[extname(clean)] || 'application/octet-stream',
        'cache-control': 'no-store'
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  }

  function proxyHttp(req, res, url) {
    const headers = { ...req.headers, host: state.device };
    /* We are one hop, not a cache. Leave the rest of the request alone —
       the Web RCS API is unauthenticated but the vendor may add headers we
       know nothing about, and forwarding blind is the safe default. */
    delete headers['accept-encoding-original'];

    const upstream = http.request(
      { host: target.host, port: target.port, path: req.url, method: req.method, headers },
      (ur) => {
        const out = { ...ur.headers };
        /* A CSP from the device would forbid our inline hook. None is served
           today, on either the simulator or a real Aquilon — this is here so
           a future firmware that adds one does not silently break the panels. */
        delete out['content-security-policy'];
        delete out['content-security-policy-report-only'];

        const isHtml = String(ur.headers['content-type'] || '').includes('text/html');
        if (!isHtml) {
          res.writeHead(ur.statusCode, out);
          ur.pipe(res);
          return;
        }

        /* Documents only: collect, inject, re-send. These are ~600 bytes. */
        const chunks = [];
        ur.on('data', (c) => chunks.push(c));
        ur.on('end', () => {
          let body;
          try {
            body = decode(Buffer.concat(chunks), ur.headers['content-encoding']).toString('utf8');
          } catch (err) {
            log(`could not decode document: ${err.message}`);
            res.writeHead(ur.statusCode, out);
            res.end(Buffer.concat(chunks));
            return;
          }
          const injected = injectInto(body, injection);
          const buf = Buffer.from(injected, 'utf8');
          /* We are re-sending a body of our own length, in one piece. Both of
             the upstream's framing headers have to go: keeping
             transfer-encoding alongside a content-length is illegal and is
             rejected outright by strict clients. The device serves documents
             chunked, so this is the normal path, not an edge case. */
          delete out['content-encoding'];
          delete out['transfer-encoding'];
          out['content-length'] = String(buf.length);
          out['cache-control'] = 'no-store';
          res.writeHead(ur.statusCode, out);
          res.end(buf);
        });
      }
    );

    upstream.on('error', (err) => {
      state.upstreamError = err.message;
      log(`upstream ${state.device}: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`LivePremier Plus: cannot reach ${state.device} — ${err.message}`);
    });

    req.pipe(upstream);
  }

  const onRequest = (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); }
    catch { res.writeHead(400); return res.end('bad request'); }

    /* A browser on this machine looking at us through the LAN address is one
       redirect away from a secure context, and Web MIDI with it. */
    const better = loopbackRedirect(
      { method: req.method, url: req.url, headers: req.headers,
        remoteAddress: req.socket?.remoteAddress, localAddress: req.socket?.localAddress },
      { port: loopbackPort });
    if (better) {
      res.writeHead(302, { location: better, 'cache-control': 'no-store' });
      return res.end(`Opening LivePremier Plus at ${better} — a secure context, so Web MIDI works there.`);
    }

    if (url.pathname === NS || url.pathname.startsWith(NS + '/')) {
      serveOwn(req, res, url).catch((err) => {
        log(`own route failed: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
      return;
    }

    /* Nothing to proxy to yet. Serving the setup page for any path (rather
       than only for /) means a bookmarked deep link into the Web RCS also
       lands somewhere useful instead of on a 502. */
    if (!target) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(setupPage);
      return;
    }

    proxyHttp(req, res, url);
  };
  const server = http.createServer(onRequest);

  /*
   * The socket.
   *
   * Relayed byte-for-byte, which means this process never has to understand
   * WebSocket framing, continuation frames, or the ping/pong pair. It also
   * means exactly one connection reaches the device per browser tab, so the
   * client count in the Web RCS header stays honest.
   */
  const onUpgrade = (req, socket, head) => {
    /*
     * An upgrade under the Companion mount goes to Companion, not the
     * switcher.
     *
     * The embedded web UI computes its own socket address from the prefix it
     * was served with, so it dials `/__lpp/companion/trpc` — and Companion
     * matches that upgrade on the pathname `/trpc` and nothing else. Passing
     * the mounted path through verbatim gets a socket that opens and then
     * says nothing, with no error at either end.
     */
    let upgradePath = null;
    try { upgradePath = new URL(req.url, 'http://localhost').pathname; }
    catch { socket.destroy(); return; }

    const mounted = NS + COMPANION_MOUNT;
    if (upgradePath === mounted || upgradePath.startsWith(mounted + '/')) {
      const below = req.url.slice(mounted.length) || '/';
      const pair = relayUpgradeToCompanion(req, socket, head, below, companion.target, log);
      if (pair) {
        /* Tracked with the vendor relays so that a launcher Stop hangs this
           up too — an upgraded socket is invisible to `server.close()`
           whichever box is on the other end of it. */
        relays.add(pair);
        const drop = () => relays.delete(pair);
        pair.socket.on('close', drop);
        pair.upstream.on('close', drop);
      }
      return;
    }

    if (!target) { socket.destroy(); return; }
    const here = target;
    const upstream = net.connect(here.port, here.host, () => {
      const headers = { ...req.headers, host: state.device };
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}: ${x}`).join('\r\n') : `${k}: ${v}`))
          .join('\r\n') +
        '\r\n\r\n'
      );
      if (head && head.length) upstream.write(head);
      state.clients++;
      socket.pipe(upstream);
      upstream.pipe(socket);
      log(`socket relayed to ${state.device} (${state.clients} open)`);
    });

    const pair = { socket, upstream };
    relays.add(pair);

    const done = () => {
      if (!relays.delete(pair)) return;
      state.clients = Math.max(0, state.clients - 1);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', (err) => { log(`socket upstream: ${err.message}`); done(); });
    socket.on('error', done);
    upstream.on('close', done);
    socket.on('close', done);
  };
  server.on('upgrade', onUpgrade);

  server.lppState = state;

  /**
   * Serve the same thing on a second listener.
   *
   * The launcher can bind this server to a LAN interface so other machines
   * can reach it; index.js then opens a loopback listener beside it, because
   * loopback is the one plain-http origin a browser treats as a secure
   * context. Both listeners share every handler and every piece of state —
   * the relays, the client count, the OSC listener — so the switcher still
   * sees one connection per tab whichever door the tab came in by.
   */
  server.mirrorTo = (other) => {
    other.on('request', onRequest);
    other.on('upgrade', onUpgrade);
    return other;
  };

  /**
   * Stop, for real.
   *
   * `closeAllConnections()` covers ordinary requests; the relayed sockets are
   * ours to hang up. Without this a launcher Stop, or a test's teardown, waits
   * on a Web RCS tab that has no reason to ever disconnect.
   */
  server.closeRelays = () => {
    for (const { socket, upstream } of [...relays]) {
      upstream.destroy();
      socket.destroy();
    }
    relays.clear();
    state.clients = 0;

    /* The UDP socket is invisible to `server.close()` for the same reason an
       upgraded socket is — it was never the HTTP server's to begin with. A
       bound datagram socket keeps the event loop alive, so leaving it open
       here would hang the launcher's Stop button exactly as an un-hung-up
       relay does. Fire-and-forget: teardown must not wait on it. */
    if (osc) { const closing = osc; osc = null; void closing.stop(); }
    for (const listener of oscListeners) { try { listener.end(); } catch { /* gone */ } }
    oscListeners.clear();

    /* Every matrix socket is invisible to `server.close()` for exactly the
       same reason, and each one holds a reconnect timer that would go on
       re-dialling a router after the app was told to stop. */
    matrices.stop();
    for (const listener of matrixListeners) { try { listener.end(); } catch { /* gone */ } }
    matrixListeners.clear();

    /* And the console, which holds an upgraded socket of its own plus a
       reconnect timer. Same failure if it is left: a Stop button that does
       nothing while something goes on dialling a panel. */
    void pixelhue.stop();
    for (const listener of pixelhueListeners) { try { listener.end(); } catch { /* gone */ } }
    pixelhueListeners.clear();
    /* And the Companion link, which holds both a socket and a redial timer
       for exactly the reasons the matrices do. */
    companion.stop();
  };

  return server;
}

/**
 * Put the fragment in front of the vendor's scripts.
 *
 * `</head>` is the normal case. The fallbacks matter because a firmware could
 * serve a document without an explicit head close — and landing before the
 * first <script> is still early enough, since what we need is only to precede
 * the deferred vendor bundle.
 */
export function injectInto(html, fragment) {
  if (html.includes('</head>')) return html.replace('</head>', `${fragment}</head>`);
  if (html.includes('<script')) return html.replace('<script', `${fragment}<script`);
  if (html.includes('<body')) return html.replace('<body', `${fragment}<body`);
  return fragment + html;
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store'
  });
  res.end(buf);
}

function collect(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Accept a timecode in either of the two shapes a caller will reach for.
 *
 * `"01:02:03:04"` because that is what a person types and what most tools
 * print, with `;` before the frames meaning drop-frame as the industry spells
 * it; or the object form for anything generating it programmatically.
 *
 * Out-of-range fields are refused rather than clamped. A frame number of 40 is
 * a bug in whatever sent it, and a clamped 29 would hide it behind a plausible
 * value that a cue stack would then act on.
 */
export function normaliseTimecode(input) {
  let parts = input;
  if (typeof input === 'string' || typeof input?.timecode === 'string') {
    const text = typeof input === 'string' ? input : input.timecode;
    const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})([:;.])(\d{1,2})$/.exec(text.trim());
    if (!m) return null;
    parts = {
      hours: +m[1], minutes: +m[2], seconds: +m[3], frames: +m[5],
      dropFrame: m[4] === ';',
      rate: typeof input === 'object' ? input.rate : undefined
    };
  }
  if (!parts || typeof parts !== 'object') return null;

  const int = (v) => (Number.isInteger(v) ? v : null);
  const hours = int(parts.hours);
  const minutes = int(parts.minutes);
  const seconds = int(parts.seconds);
  const frames = int(parts.frames);
  if (hours === null || minutes === null || seconds === null || frames === null) return null;
  if (hours > 23 || minutes > 59 || seconds > 59 || frames > 59) return null;
  if (hours < 0 || minutes < 0 || seconds < 0 || frames < 0) return null;

  const rate = int(parts.rate);
  return {
    hours, minutes, seconds, frames,
    /* A rate the sender did not give is left null for the page to fill in from
       its own setting — the same thing LTC does, and for the same reason. */
    rate: rate && rate > 0 && rate <= 120 ? rate : null,
    dropFrame: parts.dropFrame === true
  };
}
