/*
 * Matrix Routing — the plugin's server half: the routers in the rack, the
 * cable schedule to them, and routing through both.
 *
 * Two lifetimes, deliberately. The **router list** belongs to the
 * installation and is loaded once: a router in the rack does not move when the
 * app is re-pointed at a backup frame, and dropping its connection because
 * somebody failed over would be the opposite of helpful. The **patch** is one
 * frame's own cabling, so it is kept per switcher, and read again the moment
 * the app points somewhere else. Both are in the files the app always wrote —
 * `matrices.json`, and `patch-<switcher>.json` — which the setup file reads.
 *
 * `routers/index.js` argues at the top why this holds sockets open when
 * `server/awj.js` refuses to. The short version: there is no store mirror for a
 * Videohub to contradict, and its crosspoints move without us. The supervisor
 * is the plugin's, so switching Matrix Routing off hangs every router up.
 *
 * Everything is at `/__lpp/matrix` (`routeBase`), where it always was. The
 * `/lp/matrix/…` OSC addresses are contributed like any plugin's; a line typed
 * in the Console and a packet from QLab both arrive at `handle` below.
 */

import { MatrixSupervisor } from './routers/index.js';
import {
  normaliseMatrices, normalisePatch, validate as validatePatch,
  feed as patchFeed, send as patchSend, groupCrosspoints, toPortList,
  resolveMatrixOsc
} from '../../src/core/patch.js';

export default async function activate(ctx) {
  const supervisor = new MatrixSupervisor({ log: ctx.log });
  const stream = ctx.stream('/stream', {
    onOpen: (first) => first.send('matrix', supervisor.describe())
  });
  supervisor.on('change', () => stream.send('matrix', supervisor.describe()));
  /* Every router socket is invisible to `server.close()`, and each holds a
     redial timer that would go on dialling a router after the app stopped. */
  ctx.onDispose(() => supervisor.stop());

  const stored = async (name, perDevice = false, device = undefined) =>
    (ctx.storage ? ctx.storage.load(name, { perDevice, device }) : null);

  const raw = await stored('matrices');
  let config = normaliseMatrices(Array.isArray(raw) ? raw : (raw && raw.matrices) || []);
  supervisor.apply(config);

  /* The patch for the switcher the app points at now — read again whenever
     that changes, because it describes one frame's sockets. */
  let patch = [];
  let patchFor;
  async function currentPatch() {
    const device = ctx.device();
    if (device !== patchFor) {
      const saved = await stored('patch', true);
      patch = normalisePatch(Array.isArray(saved) ? saved : (saved && saved.entries) || []);
      patchFor = device;
    }
    return patch;
  }

  /** Everything a panel needs in one object, so it repaints from one fetch. */
  const snapshot = async () => {
    const p = await currentPatch();
    return {
      matrices: supervisor.describe(),
      patch: p,
      problems: validatePatch(p, { matrices: config, state: supervisor.sizes() }),
      routing: supervisor.routing()
    };
  };

  /**
   * Take a patch-derived action and report what reached the wire.
   *
   * The resolution is `core/patch.js`'s and the sending is the supervisor's;
   * this only joins them. A refusal from either is a 409 with the reason in
   * it, because "it did nothing and said OK" is the failure mode that costs
   * somebody a show.
   */
  function run(resolved) {
    if (!resolved.ok) return { status: 409, body: { error: resolved.error } };
    const results = supervisor.route(groupCrosspoints(resolved.crosspoints));
    const failed = results.filter((r) => !r.ok);
    return {
      status: failed.length ? 409 : 200,
      body: {
        ok: failed.length === 0,
        crosspoints: resolved.crosspoints,
        results,
        ...(failed.length ? { error: failed.map((f) => f.error).join('; ') } : {})
      }
    };
  }

  /* `GET` is the whole picture — routers, their state, the patch and anything
     wrong with it — because a panel that made four requests to draw one grid
     would draw it inconsistently. */
  ctx.route('GET', '/', async (req, res, h) => h.json(200, await snapshot()));
  const saveRouters = async (req, res, h) => {
    const parsed = await h.readJson(64 * 1024);
    config = normaliseMatrices(parsed.matrices ?? parsed);
    if (ctx.storage) await ctx.storage.save('matrices', { matrices: config });
    /* Diff-based: a router whose address did not change keeps its socket and
       its grid. See `MatrixSupervisor.apply`. */
    supervisor.apply(config);
    h.json(200, { ok: true, ...(await snapshot()) });
  };
  ctx.route('PUT', '/', saveRouters);
  ctx.route('POST', '/', saveRouters);

  /* The cable schedule, per switcher. */
  ctx.route('GET', '/patch', async (req, res, h) => {
    const s = await snapshot();
    h.json(200, { patch: s.patch, problems: s.problems });
  });
  const savePatch = async (req, res, h) => {
    const parsed = await h.readJson(256 * 1024);
    patch = normalisePatch(parsed.patch ?? parsed.entries ?? parsed);
    patchFor = ctx.device();
    if (ctx.storage) await ctx.storage.save('patch', { entries: patch }, { perDevice: true });
    h.json(200, { ok: true, ...(await snapshot()) });
  };
  ctx.route('PUT', '/patch', savePatch);
  ctx.route('POST', '/patch', savePatch);

  /*
   * Route. Two verbs and not one, because feeding an input and sending an
   * output are genuinely different operations — see the head of
   * `src/core/patch.js`. One takes a source and yields one crosspoint; the
   * other takes a list of destinations and yields one crosspoint each.
   */
  ctx.route('POST', '/feed', async (req, res, h) => {
    const parsed = await h.readJson(16 * 1024);
    const { status, body } = run(patchFeed(await currentPatch(), String(parsed.connector ?? ''), Number(parsed.source)));
    h.json(status, body);
  });
  ctx.route('POST', '/send', async (req, res, h) => {
    const parsed = await h.readJson(16 * 1024);
    const ports = toPortList(parsed.destinations ?? parsed.destination);
    const { status, body } = run(patchSend(await currentPatch(), String(parsed.connector ?? ''), ports));
    h.json(status, body);
  });

  /*
   * A raw crosspoint, naming the router's own ports. The patch is the point
   * of this feature, but a patch panel needs a way to route a port that is not
   * patched to anything — to prove a cable, or to drive the half of the router
   * the switcher is not on. It takes router numbers and consults no patch.
   */
  ctx.route('POST', '/route', async (req, res, h) => {
    const parsed = await h.readJson(16 * 1024);
    const matrix = String(parsed.matrix ?? '');
    const output = Number(parsed.output);
    const input = Number(parsed.input);
    if (!Number.isInteger(output) || output < 1 || !Number.isInteger(input) || input < 1) {
      throw new ctx.HttpError(400, 'output and input are 1-based port numbers');
    }
    const { status, body } = run({ ok: true, crosspoints: [{ matrix, output, input }] });
    h.json(status, body);
  });

  /*
   * Two sections of the one-file setup. The routers belong to the
   * installation and the patch to one frame's rig — see the head of this file.
   * A restore goes into the running supervisor as well as the file, so the
   * routers it names are dialled at once, and a patch restored onto the frame
   * the app points at is the one the next route uses.
   */
  ctx.contribute('configSection', {
    key: 'matrices',
    group: 'installation',
    label: 'External routers',
    export: async () => (config.length ? config : undefined),
    async import(data) {
      config = normaliseMatrices(data);
      if (ctx.storage) await ctx.storage.save('matrices', { matrices: config });
      supervisor.apply(config);
    }
  });
  ctx.contribute('configSection', {
    key: 'patch',
    group: 'rig',
    label: 'Patch',
    perDevice: true,
    async export(device) {
      if (device === ctx.device()) { const p = await currentPatch(); return p.length ? p : undefined; }
      const saved = await stored('patch', true, device);
      const p = normalisePatch(Array.isArray(saved) ? saved : (saved && saved.entries) || []);
      return p.length ? p : undefined;
    },
    async import(data, device) {
      const p = normalisePatch(data);
      if (ctx.storage) await ctx.storage.save('patch', { entries: p }, { perDevice: true, device });
      if (device === ctx.device()) { patch = p; patchFor = device; }
    }
  });

  /* `/lp/matrix/…`: this app's own addresses, not mynah's — `resolveMatrixOsc`
     in `core/patch.js` says why, and docs/OSC.md lists them. */
  ctx.contribute('oscAddress', {
    prefix: '/lp/matrix/',
    describe: 'Route through the external routers — docs/OSC.md',
    async handle(address, args) {
      const routed = resolveMatrixOsc(address, args, await currentPatch());
      if (!routed) return null;
      if (!routed.ok) return { ok: false, error: routed.error };
      const { body } = run(routed);
      return body.ok
        ? { ok: true, summary: routed.summary, count: routed.crosspoints.length }
        : { ok: false, summary: routed.summary, error: body.error };
    }
  });
}
