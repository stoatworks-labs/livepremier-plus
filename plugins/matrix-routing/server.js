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
  resolveMatrixOsc, normalisePlan, planCrosspoints
} from '../../src/core/patch.js';

export default async function activate(ctx) {
  const supervisor = new MatrixSupervisor({ log: ctx.log });
  /* A router's link, as the driver reports it, plus what it was planned as —
     which is configuration, not something any router said. */
  let config = [];
  const describe = () => supervisor.describe().map((d) => {
    const m = config.find((c) => c.id === d.id);
    if (!m) return d;
    const planning = {};
    for (const key of ['model', 'modelLabel', 'inputs', 'outputs', 'plan']) {
      if (key in m) planning[key] = m[key];
    }
    return { ...d, planning };
  });
  const stream = ctx.stream('/stream', {
    onOpen: (first) => first.send('matrix', describe())
  });
  supervisor.on('change', () => stream.send('matrix', describe()));
  /* Every router socket is invisible to `server.close()`, and each holds a
     redial timer that would go on dialling a router after the app stopped. */
  ctx.onDispose(() => supervisor.stop());

  const stored = async (name, perDevice = false, device = undefined) =>
    (ctx.storage ? ctx.storage.load(name, { perDevice, device }) : null);

  const raw = await stored('matrices');
  config = normaliseMatrices(Array.isArray(raw) ? raw : (raw && raw.matrices) || []);
  supervisor.apply(config);

  /*
   * A placeholder's routing is the show's plan, so it is saved into the
   * router's own configuration whenever it moves: it survives a restart,
   * travels in the setup file, and is still there when the router goes live.
   * Debounced, because a send to 1-40 is forty changes in one breath.
   */
  let planTimer = null;
  const savePlans = (persist = true) => {
    let dirty = false;
    config = config.map((m) => {
      if (m.kind !== 'placeholder') return m;
      const driver = supervisor.get(m.id);
      if (!driver?.planned) return m;
      const plan = normalisePlan(driver.planned);
      if (JSON.stringify(plan) === JSON.stringify(m.plan ?? null)) return m;
      dirty = true;
      return plan ? { ...m, plan } : (({ plan: _, ...rest }) => rest)(m);
    });
    if (dirty && persist && ctx.storage) {
      ctx.storage.save('matrices', { matrices: config })
        .catch((err) => ctx.log(`matrix: could not save the plan: ${err.message}`));
    }
  };
  supervisor.on('change', () => {
    if (planTimer) clearTimeout(planTimer);
    planTimer = setTimeout(() => { planTimer = null; savePlans(); }, 250);
    planTimer.unref?.();
  });
  ctx.onDispose(() => { if (planTimer) { clearTimeout(planTimer); savePlans(); } });

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
      matrices: describe(),
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
    const parsed = await h.readJson(256 * 1024);
    /* Fold in any routing still inside the debounce first: going live must
       carry the plan as it was on the last click, not 250 ms before it. The
       save just below writes it, so this one only folds. */
    savePlans(false);
    config = normaliseMatrices(keepPlanning(parsed.matrices ?? parsed, config));
    if (ctx.storage) await ctx.storage.save('matrices', { matrices: config });
    /* Diff-based: a router whose address did not change keeps its socket and
       its grid. See `MatrixSupervisor.apply`. */
    supervisor.apply(config);
    h.json(200, { ok: true, ...(await snapshot()) });
  };
  ctx.route('PUT', '/', saveRouters);
  /* A panel rebuilds the list from what `describe()` told it, which is a
     router's link, not its planning — so a save that names a router by id and
     leaves its size, model or plan out keeps the ones already held. Saying
     `plan: null` is how a plan is dropped on purpose. */
  function keepPlanning(incoming, previous) {
    if (!Array.isArray(incoming)) return incoming;
    const held = new Map(previous.map((m) => [m.id, m]));
    return incoming.map((item) => {
      const was = item && held.get(item.id);
      if (!was) return item;
      const out = { ...item };
      for (const key of ['model', 'modelLabel', 'inputs', 'outputs', 'plan']) {
        if (!(key in out) && key in was) out[key] = was[key];
      }
      return out;
    });
  }
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
   * Push a router's plan — the routing it held as a placeholder — to the frame
   * it has become. Only what differs is sent, and only what fits: a plan port
   * past the size the real router reports is listed back, not dropped
   * silently. `?dryRun=1` counts without sending, which is what the panel
   * shows on the button before anybody presses it.
   */
  ctx.route('POST', '/plan/push', async (req, res, h) => {
    const parsed = await h.readJson(16 * 1024);
    const matrix = config.find((m) => m.id === String(parsed.matrix ?? ''));
    if (!matrix) throw new ctx.HttpError(404, 'no such router');
    if (!matrix.plan) throw new ctx.HttpError(409, `${matrix.name} has no plan to push`);
    const state = supervisor.get(matrix.id)?.state;
    if (!state) throw new ctx.HttpError(409, `${matrix.name} has not answered yet`);
    const { crosspoints, outOfRange, already } = planCrosspoints(matrix.id, matrix.plan, state);
    const summary = { already, outOfRange, toSend: crosspoints.length };
    if (parsed.dryRun || !crosspoints.length) return h.json(200, { ok: true, dryRun: !!parsed.dryRun, ...summary });
    const { status, body } = run({ ok: true, crosspoints });
    h.json(status, { ...body, ...summary });
  });

  /* Forget a live router's plan once it has been pushed, or is not wanted. */
  ctx.route('POST', '/plan/discard', async (req, res, h) => {
    const parsed = await h.readJson(16 * 1024);
    const id = String(parsed.matrix ?? '');
    if (!config.some((m) => m.id === id)) throw new ctx.HttpError(404, 'no such router');
    config = config.map((m) => (m.id === id ? (({ plan: _, ...rest }) => rest)(m) : m));
    if (ctx.storage) await ctx.storage.save('matrices', { matrices: config });
    supervisor.apply(config);
    h.json(200, { ok: true, ...(await snapshot()) });
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
    export: async () => { savePlans(false); return config.length ? config : undefined; },
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
