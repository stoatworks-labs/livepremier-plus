/*
 * Companion — the plugin's server half.
 *
 * Everything this app does about a Bitfocus Companion that has to happen in
 * this process: the supervised link (`link.js`), the mount that serves
 * Companion's own web UI on our origin, the relay for that UI's socket, the
 * live view of the show, and the one write this app will make to it. It used
 * to be forty lines threaded through `server/proxy.js`; it is here, in one
 * place, and the plugin host takes all of it down when the plugin is switched
 * off.
 *
 * Routes, all under `/__lpp/companion`:
 *
 *     GET  /state         the link, the settings, the show and the plan
 *     GET  /stream        server-sent `show` events when the show changes
 *     POST /connections   add what the plan says is missing
 *     POST /press         press one or more buttons — a cue, a memory trigger
 *     GET|PUT /triggers   the buttons each memory recall presses, per switcher
 *     *    /ui/…          Companion's own web UI, mounted whole
 *     WS   /ui/trpc       and its socket
 *
 * ## Present, and active
 *
 * The plugin switch says whether any of this exists. The plugin's own setting,
 * "Connect to a Companion" (`companionEnabled`), says whether the link dials
 * out while it does. The first is the plugin host's; the second is this
 * plugin's own, and it starts off.
 */

import {
  CompanionLink, addConnections, listConnections, prefixHeaderFor,
  proxyToCompanion, relayUpgradeToCompanion,
} from './link.js';
import {
  MODULES, companionChanged, locationKey, normaliseCompanion, normaliseLocation,
  normaliseTriggers, planConnections,
} from './core.js';
import { documentSection } from '../../server/documents.js';

/**
 * The settings schema, read by the plugin host whether the plugin is on or off.
 *
 * `legacy` names where these three fields were kept before plugins had a
 * namespace — at the top level of `settings.json`. The host lifts them into
 * `plugins.companion.settings` the first time it meets them, so a settings
 * file, an old setup file or a caller that still sends the old shape all keep
 * working.
 */
export const settings = {
  normalise: normaliseCompanion,
  changed: companionChanged,
  legacy: ['companionEnabled', 'companionHost', 'companionPort'],
};

/** Where Companion's UI is mounted, below this plugin's base — so `/__lpp/companion/ui`. */
const UI = '/ui';

/**
 * The surface a press is reported as coming from. Companion logs it, and a
 * button whose actions branch on `$(internal:…)` surface variables sees it —
 * so it names this app rather than borrowing the HTTP API's.
 */
const SURFACE_ID = 'livepremier-plus';

/**
 * How long a press is held before it is let go. Companion's own HTTP `press`
 * waits 20 ms; a little longer here, because a button with a "long press"
 * step must still read this as a short one, and nothing an operator can see
 * happens in 60 ms.
 */
const HOLD_MS = 60;

/** The most buttons one request may press. A cue that presses more is a typo. */
const MAX_PRESSES = 16;

export default function activate(ctx) {
  /*
   * The link to a Companion.
   *
   * Installation-level, like the OSC listener and the matrices: a control
   * surface in the rack does not move when you fail over to a backup frame, so
   * re-pointing the switcher must not disturb it. `link.js` carries the
   * argument for why this one holds a socket open, and it is the matrix
   * argument rather than the AWJ one.
   */
  const link = new CompanionLink(ctx.log);
  link.apply(ctx.settings.get());
  /* Only on a change `companionChanged` cares about — a save of some other
     setting must not hang up a link that nobody touched. */
  ctx.settings.onChange((next) => link.apply(next));
  ctx.onDispose(() => link.stop());

  /*
   * Pages watching the show.
   *
   * A panel that only updated when you touched it would be a panel that was
   * right when it was opened, and this one has the sharpest version of that
   * problem: Companion's own editor opens from the panel, so the most likely
   * way for the show to change is the operator changing it in the window
   * beside it.
   */
  const show = ctx.stream('/stream');
  link.on('showChanged', () => {
    if (!show.size) return;
    /* Re-read over the documented API rather than forwarding whatever the
       subscription said — the link uses that only as a doorbell. */
    listConnections(link.target).then((connections) => {
      show.send('show', { connections, plan: planConnections(connections), link: link.state });
    }).catch(() => { /* the next change will try again */ });
  });

  /**
   * The facts a module needs to be pointed at something: the switcher, and us.
   * Our own address comes off the request — `selfAddress` in the plugin host
   * says why, and why it can still be wrong in a way the panel must say.
   */
  const facts = (req) => {
    const self = ctx.selfAddress(req);
    return {
      device: ctx.device() || null,
      selfHost: self ? self.host : null,
      selfPort: self ? self.port : null,
      selfIsLoopback: Boolean(self && self.loopback),
    };
  };

  /*
   * Companion, mounted whole under our own origin.
   *
   * What is below the mount is not ours to interpret. The mount point is
   * stripped here rather than at the far end: Companion matches its own routes
   * on the unprefixed path and is *told* about the prefix by a header instead —
   * see `link.js`. The header is derived from where the host actually put us,
   * so the two cannot disagree.
   */
  const prefix = prefixHeaderFor(ctx.url(UI));
  ctx.mount(UI, (req, res, { rest }) => proxyToCompanion(req, res, rest, link.target, ctx.log, prefix));

  /*
   * The embedded UI computes its socket address from the prefix it was served
   * with, so it dials `/__lpp/companion/ui/trpc` — and Companion matches that
   * upgrade on the pathname `/trpc` and nothing else. The host hands over the
   * path below the mount; passing the mounted path through verbatim gets a
   * socket that opens and then says nothing, with no error at either end.
   */
  ctx.upgrade(UI, (req, socket, head, { rest }) =>
    relayUpgradeToCompanion(req, socket, head, rest, link.target, ctx.log, prefix));

  /*
   * What this app knows about that Companion, which is not the same as what
   * Companion knows about itself.
   *
   * The connection list comes from Companion's **documented** HTTP API rather
   * than from the tRPC socket — see `listConnections`. The plan on top of it is
   * entirely ours, and it is the part that decides what this app is willing to
   * do to a show it did not create.
   */
  ctx.route('GET', '/state', async (req, res, h) => {
    const body = {
      link: link.state,
      /* The stored fields, so the address form has something to draw without a
         second round trip — and so that what the form shows and what the link
         is using cannot disagree. */
      settings: ctx.settings.get(),
      /* The address our own module would be pointed at, so the panel can show
         it before anybody commits to it. */
      facts: facts(req),
      modules: Object.fromEntries(
        Object.entries(MODULES).map(([k, m]) => [k, { moduleId: m.moduleId, label: m.label, what: m.what }])),
      connections: null,
      plan: null,
      error: null,
    };
    if (!link.target) return h.json(200, body);

    try {
      body.connections = await listConnections(link.target);
      body.plan = planConnections(body.connections);
    } catch (err) {
      body.error = err.message;
    }
    return h.json(200, body);
  });

  /*
   * Put the two connections in the show.
   *
   * A POST rather than a PUT: this creates, and it is emphatically not
   * idempotent in the "make it look like this" sense — a second call adds
   * nothing, because the plan is recomputed from what is actually there first.
   * That recomputation is the whole safety property, so it happens HERE and not
   * from whatever the panel last drew: a show can have gained a connection
   * since the panel loaded.
   */
  ctx.route('POST', '/connections', async (req, res, h) => {
    if (!link.target) return h.json(409, { error: 'no Companion configured' });
    if (!link.state.connected) return h.json(409, { error: 'not connected to Companion' });

    const parsed = await h.readJson(4096);
    const want = Array.isArray(parsed.keys) ? parsed.keys.filter((k) => k in MODULES) : null;

    let connections;
    try { connections = await listConnections(link.target); }
    catch (err) { return h.json(502, { error: err.message }); }

    const plan = planConnections(connections);
    const results = await addConnections(link, plan, facts(req), want, link.target);

    /* Read back rather than reporting what we meant to do. */
    let after = connections;
    try { after = await listConnections(link.target); } catch { /* the adds still happened */ }

    return h.json(200, {
      ok: results.every((r) => r.ok),
      results,
      connections: after,
      plan: planConnections(after),
    });
  });

  /*
   * Press a button, for a cue or a memory trigger.
   *
   * Over the link's tRPC socket, `controls.hotPressControl` — the call
   * Companion's own emulator makes — rather than the HTTP API's
   * `/api/location/…/press`, because the HTTP API answers only while
   * Companion's "HTTP API" setting is on, and a cue that silently pressed
   * nothing on a Companion where somebody had switched it off would be the
   * worst kind of failure: the show goes on and one thing does not happen.
   * The socket is already open, and it has no such switch.
   *
   * Here and not from the page: a cue fires in whichever page pressed GO, and
   * that page may never have opened the Companion panel, so it has no socket
   * of its own to press with. The link is up whenever a Companion is set.
   *
   * `{ location }` or `{ locations: [...] }`; `direction` `down` or `up` for
   * a hold, anything else is a press — down, then up `HOLD_MS` later.
   */
  ctx.route('POST', '/press', async (req, res, h) => {
    const body = (await h.readJson(8192)) || {};
    const raw = Array.isArray(body.locations) ? body.locations : [body.location];
    const locations = raw.map(normaliseLocation);
    if (!locations.length || locations.some((l) => !l)) {
      return h.json(400, { error: 'a press needs a location: { pageNumber, row, column }' });
    }
    if (locations.length > MAX_PRESSES) return h.json(400, { error: `at most ${MAX_PRESSES} buttons at once` });
    if (!link.target) return h.json(409, { error: 'no Companion configured' });
    if (!link.state.connected) return h.json(409, { error: 'not connected to Companion' });

    const hot = (location, down) => link.call('mutation', 'controls.hotPressControl', {
      location, direction: down, surfaceId: SURFACE_ID,
    });
    const direction = body.direction === 'down' || body.direction === 'up' ? body.direction : 'press';

    const results = await Promise.all(locations.map(async (location) => {
      try {
        if (direction !== 'up') await hot(location, true);
        if (direction === 'press') await new Promise((r) => setTimeout(r, HOLD_MS));
        if (direction !== 'down') await hot(location, false);
        return { location: locationKey(location), ok: true };
      } catch (err) {
        return { location: locationKey(location), ok: false, error: err.message };
      }
    }));
    const failed = results.filter((r) => !r.ok);
    if (failed.length) ctx.log(`companion press failed: ${failed.map((r) => `${r.location} ${r.error}`).join('; ')}`);
    return h.json(failed.length ? 502 : 200, {
      ok: !failed.length, results, error: failed.length ? failed[0].error : null,
    });
  });

  /*
   * The buttons each memory recall presses.
   *
   * Per switcher, like a cue stack: a memory slot means one box's memory.
   * Normalised on the way in as well as out, so a hand-edited or restored
   * file cannot put a location in front of Companion that `/press` would
   * refuse anyway.
   */
  const TRIGGERS = 'companion-triggers';
  const storage = () => {
    if (!ctx.storage) throw new ctx.HttpError(501, 'no storage configured');
    return ctx.storage;
  };
  ctx.route('GET', '/triggers', async (req, res, h) => {
    h.json(200, { data: normaliseTriggers(await storage().load(TRIGGERS, { perDevice: true })) });
  });
  ctx.route('PUT', '/triggers', async (req, res, h) => {
    const store = storage();
    const body = await h.readJson(256 * 1024);
    const data = normaliseTriggers(body && body.data !== undefined ? body.data : body);
    await store.save(TRIGGERS, data, { perDevice: true });
    h.json(200, { ok: true, data });
  });
  /* In the one-file setup beside the cue stack, which is where it belongs:
     both are a show written against one box. */
  documentSection(ctx, TRIGGERS, {
    group: 'show',
    label: 'Companion memory triggers',
    empty: (data) => !data || !Object.keys(normaliseTriggers(data).memories).length,
  });
}
