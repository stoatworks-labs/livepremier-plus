/*
 * Bitfocus Companion: the wire it speaks, and what this app asks of it.
 *
 * Companion is a control surface server. It is not a switcher, and nothing in
 * here belongs to the store mirror — which is the whole reason this file is
 * allowed to exist at all. Read `link.js` beside this for the connection
 * argument; this file is the part with no I/O in it.
 *
 * ## Two APIs, and why both
 *
 * Companion 5 answers on one port with two quite different surfaces, and this
 * app deliberately uses each for what it is good at:
 *
 *  - **`/api/...`, documented and CORS-enabled.** Listing connections,
 *    pressing a button, reading a variable. It is stable, it is public, and a
 *    panel can call it straight through the mount with no client at all.
 *  - **`/trpc`, a WebSocket, undocumented and internal.** Everything the
 *    vendor's own web UI can do that the HTTP API cannot: *creating* a
 *    connection, writing its config, installing a module, streaming button
 *    images. There is no other way to do any of it.
 *
 * The split matters when something breaks. A failure on `/api` is a bug in
 * this app or a Companion that is down. A failure on `/trpc` may equally be
 * Companion having changed its internals between releases, which it is
 * entitled to do — so every tRPC call this app makes is one it can report as
 * unavailable without taking anything else down with it.
 *
 * ## The tRPC frame, verified rather than assumed
 *
 * Read off `@trpc/server`'s own `adapters/ws.ts` as shipped inside Companion
 * 5.0.5, not from the docs for some other version of tRPC:
 *
 *   → {"id":1,"jsonrpc":"2.0","method":"mutation",
 *      "params":{"path":"instances.connections.add","input":{…}}}
 *   ← {"id":1,"result":{"type":"data","data":…}}            query/mutation
 *   ← {"id":1,"result":{"type":"started"}}                  subscription open
 *   ← {"id":1,"result":{"type":"data","data":…}}            …each value
 *   ← {"id":1,"result":{"type":"stopped"}}                  subscription end
 *   ← {"id":1,"error":{…}}                                  either
 *
 * Three things that are easy to get wrong and cost a silent hang each:
 *
 *  - **`id` is required.** A frame without one is answered with a PARSE_ERROR
 *    and no result, which looks exactly like a call that never returned.
 *  - **Stopping a subscription is its own method**, `subscription.stop`, with
 *    the id of the subscription and *no params*. Closing the socket instead
 *    works but takes every other subscription with it.
 *  - **Companion runs tRPC with no transformer** (`initTRPC.context().create()`
 *    with no argument). So input and output are plain JSON. If a future
 *    Companion adds superjson, every `input` here would need wrapping in
 *    `{json: …}` and every `data` unwrapping — the symptom would be
 *    "Invalid or malformed input provided", which is Companion's own wording
 *    from its `tidyZodMiddleware`.
 *
 * ## Shared by both halves, and so it knows nothing about either
 *
 * No DOM, no sockets, no fetch. The plugin's server half imports this to
 * drive a real connection; its page half imports the same table so the two
 * cannot disagree about what a plan means. Tests run it under plain Node. It
 * is the one file of the Companion plugin that both halves load, which is
 * what keeps `core/`'s rule — no I/O — true inside a plugin as well.
 */

/** Companion's default admin port. Its own default, not a preference of ours. */
export const DEFAULT_PORT = 8000;

export const DEFAULT_COMPANION = {
  /* Off, like the OSC listener and for a weaker version of the same reason:
     this one only reaches out rather than opening a door, but an app that
     silently dials a machine on the show network the moment it starts is not
     one an operator can reason about. */
  companionEnabled: false,
  companionHost: '',
  companionPort: DEFAULT_PORT,
};

/**
 * Coerce a stored Companion block into something usable.
 *
 * Same contract as the rest of `src/core/settings.js`: a bad field falls
 * back to its default rather than taking the whole file down, and being *not
 * what was typed* is how it reports itself. This is the plugin's settings
 * schema — `server.js` hands it to the host, which applies it to
 * `plugins.companion.settings`.
 */
export function normaliseCompanion(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const port = Number(input.companionPort);
  const host = typeof input.companionHost === 'string' ? input.companionHost.trim() : '';
  return {
    companionEnabled: input.companionEnabled === true,
    /* The same host shape the proxy already accepts for a switcher. A URL, a
       path or a port glued on the end are all rejected here rather than at
       `net.connect`, where the error would name a DNS failure instead of the
       actual mistake. */
    companionHost: /^[A-Za-z0-9._-]{1,253}$/.test(host) ? host : '',
    companionPort:
      Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_COMPANION.companionPort,
  };
}

/** True when a change means the link has to be rebuilt rather than just noted. */
export const companionChanged = (a, b) =>
  a.companionEnabled !== b.companionEnabled ||
  a.companionHost !== b.companionHost ||
  a.companionPort !== b.companionPort;

/* ------------------------------------------------------------------ the wire */

/**
 * A query or mutation frame.
 *
 * `jsonrpc` is echoed back by the server untouched and is not used to route
 * anything — it is sent because the vendor's own client sends it, and a frame
 * that looks like every other frame is one fewer thing to be the difference
 * when something does not work.
 */
export function request(id, method, path, input) {
  const frame = { id, jsonrpc: '2.0', method, params: { path } };
  /* Omitted rather than sent as null: a procedure with no `.input()` schema
     rejects a null it did not ask for. */
  if (input !== undefined) frame.params.input = input;
  return frame;
}

/** Ask the server to end a subscription without closing the socket. */
export function stopRequest(id) {
  return { id, jsonrpc: '2.0', method: 'subscription.stop' };
}

/**
 * Normalise one inbound frame into something a caller can switch on.
 *
 * Returns `null` for anything unparseable rather than throwing. A socket
 * carrying a frame this app does not understand is not a reason to tear the
 * socket down — Companion is entitled to add message types, and the ones we
 * asked for keep arriving.
 *
 * Batching is real: the adapter maps over an array when the client sent one.
 * We never send a batch, but a server that answers with one is handled here
 * rather than being a surprise at the call site.
 */
export function parseFrames(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const msg of list) {
    if (!msg || typeof msg !== 'object' || typeof msg.id !== 'number') continue;
    if (msg.error) {
      out.push({ id: msg.id, kind: 'error', error: errorMessage(msg.error) });
      continue;
    }
    const type = msg.result?.type;
    if (type === 'data') out.push({ id: msg.id, kind: 'data', data: msg.result.data });
    else if (type === 'started') out.push({ id: msg.id, kind: 'started' });
    else if (type === 'stopped') out.push({ id: msg.id, kind: 'stopped' });
  }
  return out;
}

/**
 * Get a sentence out of a tRPC error shape.
 *
 * Companion's `tidyZodMiddleware` already rewrites a schema failure into
 * "Invalid or malformed input provided for …", which is the message worth
 * showing — it names the procedure and means *this app sent the wrong shape*,
 * which is our bug and not the operator's.
 */
function errorMessage(error) {
  if (typeof error === 'string') return error;
  return error?.message || error?.data?.message || 'Companion refused the call';
}

/* ------------------------------------------------- what a show should contain */

/**
 * The two connections this app knows how to put in a Companion show.
 *
 * They are not alternatives and they do not overlap, which is the point:
 *
 *  - **`analogway-awj` drives the box.** Sources, presets, takes, the layer
 *    state — everything that is in the device's own store. It is the vendor's
 *    own protocol and it is somebody else's module, which is exactly why this
 *    app does not reimplement any of it.
 *  - **`livepremier-plus` drives the show layer.** The cue stack, the
 *    timeline, layer groups, matrix routing — the things this app *adds*, that
 *    the device has never heard of and that no AWJ path can reach.
 *
 * Anything that can be said in AWJ belongs to the first one. That is the same
 * single-source-of-truth rule the rest of this repo keeps: two connections
 * that can both claim to set a source is a show where nobody knows which one
 * last did.
 */
export const MODULES = {
  awj: {
    key: 'awj',
    moduleId: 'analogway-awj',
    /* One of the module's declared `products`. Companion stores it against
       the connection and shows it in the list; it does not change behaviour,
       but a show full of connections labelled by what they actually are is
       worth the one string. */
    product: 'LivePremier',
    label: 'AWJ',
    what: 'The switcher itself — sources, presets, takes, layers.',
    /* Where this module expects to be pointed. `deviceaddr` is a URL string,
       not a host: the module parses scheme, optional port and optional
       credentials out of it. */
    configure: (facts) => ({ deviceaddr: `http://${facts.device}` }),
  },
  lpp: {
    key: 'lpp',
    moduleId: 'livepremier-plus',
    product: 'LivePremier Plus',
    label: 'LivePremier Plus',
    what: 'This app — cue stack, timeline, layer groups, matrix routing.',
    /* Pointed at us, not at the switcher. `facts.self` is the address this
       process is reachable on, which is not always the one the browser used
       to get here — see `selfAddress` in `server/plugin-host.js`. */
    configure: (facts) => ({ host: facts.selfHost, port: facts.selfPort }),
  },
};

/**
 * Decide what to do about a Companion show that already exists.
 *
 * Deliberately **not** "make it look like this". An operator's show is theirs:
 * it may already have an AWJ connection pointed at a different frame on
 * purpose, it may have three of them, and this app arriving and rewriting one
 * would be the kind of help nobody asked for.
 *
 * So the plan has three buckets and only the first one is an action:
 *
 *  - `add`      — nothing of this module is in the show. Safe to create.
 *  - `adopt`    — exactly one is there. Use it; touch nothing.
 *  - `ambiguous`— more than one. Report it and let a person choose, because
 *                 picking one by sort order would be picking one at random.
 *
 * Config is never written as part of adopting. A connection that is pointed
 * somewhere else is surfaced by `configure()` at the call site as an offer,
 * not applied here.
 *
 * @param {Array<{id:string,label:string,moduleId:string,enabled:boolean}>} existing
 *        as `GET /api/connections` returns it
 * @param {string[]} [want] which keys of MODULES to plan for; all of them by default
 */
export function planConnections(existing, want = Object.keys(MODULES)) {
  const list = Array.isArray(existing) ? existing : [];
  const plan = { add: [], adopt: [], ambiguous: [] };

  for (const key of want) {
    const spec = MODULES[key];
    if (!spec) continue;
    const found = list.filter((c) => c && c.moduleId === spec.moduleId);

    if (found.length === 0) plan.add.push({ key, spec });
    else if (found.length === 1) plan.adopt.push({ key, spec, connection: found[0] });
    else plan.ambiguous.push({ key, spec, connections: found });
  }
  return plan;
}

/**
 * The key a module appears under in `instances.modules.watch`.
 *
 * Namespaced by kind, because surfaces live in the same map: `analogway-awj`
 * is `connection:analogway-awj` there and nowhere else in the API. Looking it
 * up by the bare id finds nothing and looks exactly like "not installed".
 */
export const moduleKey = (moduleId, kind = 'connection') => `${kind}:${moduleId}`;

/**
 * Which version of a module to ask for.
 *
 * ## Why this is not simply `null`
 *
 * `addConnectionWithLabel` reads a null `versionId` as "the latest installed
 * version", which reads like an invitation to send one. It is not: the tRPC
 * procedure in front of it declares `versionId: z.string()`, **not
 * nullable**, so a null never reaches that code — it is refused by the schema
 * with Companion's generic "Invalid or malformed input provided for
 * instances.connections.add/mutation", which names the procedure and not the
 * field. Verified the hard way against a live Companion 5.0.5.
 *
 * So a real version string has to be resolved first, and the module list is
 * the only place that knows them.
 *
 * ## The order, and why
 *
 * `stableVersion` first, because it is Companion's *own* answer to "the
 * latest one you should be running" — matching `getLatestVersionOfModule`,
 * which also prefers stable and only returns `dev` when explicitly allowed.
 * Then beta, then whatever is installed, and `dev` last: a developer with a
 * dev build of a module has almost certainly also got it installed, and
 * silently binding a show to a working copy is not this app's decision to
 * make.
 *
 * Returns null when the module is not installed at all — which is a different
 * answer from "no version", and the caller must say so rather than trying the
 * add and reporting a schema error.
 */
export function pickVersion(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = (v) => (v && typeof v.versionId === 'string' && v.versionId ? v.versionId : null);

  const ordered = [entry.stableVersion, entry.betaVersion];
  for (const candidate of ordered) {
    const found = id(candidate);
    if (found) return found;
  }
  if (Array.isArray(entry.installedVersions)) {
    /* Last rather than first: Companion emits these in ascending order, and
       there is no semver comparison here to do better with. A show pinned to
       a version an operator can see in the list is recoverable; one pinned to
       a version chosen by a sort this app invented is not. */
    for (let i = entry.installedVersions.length - 1; i >= 0; i--) {
      const found = id(entry.installedVersions[i]);
      if (found) return found;
    }
  }
  return id(entry.builtinVersion) || id(entry.devVersion);
}

/**
 * The `input` for `instances.connections.add`.
 *
 * `versionId` is a real version string — see `pickVersion` for why it cannot
 * be null, and what it costs when it is.
 */
export function addInput(spec, versionId) {
  return {
    module: { type: spec.moduleId, product: spec.product },
    label: spec.label,
    versionId,
  };
}

/* ------------------------------------------------- the cross-origin question */

/**
 * Normalise a `Host` header the way a `URL`'s `host` is normalised.
 *
 * Lowercased, and a default port dropped — `Example.COM:80` and `example.com`
 * are the same host, and only one of those spellings ever comes back out of
 * `new URL(...).host`.
 */
export function normaliseHost(host, scheme = 'http') {
  const value = String(host || '').trim().toLowerCase();
  if (!value) return '';
  const drop = scheme === 'https' ? ':443' : ':80';
  return value.endsWith(drop) ? value.slice(0, -drop.length) : value;
}

/**
 * Is this WebSocket upgrade coming from the page we served it to?
 *
 * ## Why this has to exist here rather than be left to Companion
 *
 * Companion refuses a cross-origin WebSocket upgrade, to stop Cross-Site
 * WebSocket Hijacking — a page on some other site opening a socket to a
 * Companion it could not otherwise reach, and driving it. WebSockets get no
 * CORS preflight, so that check is the *only* thing standing between a
 * loopback Companion and any web page the operator happens to have open.
 *
 * Mounting Companion under this app's origin breaks that check honestly: the
 * browser sends `Origin: http://<us>` and the far end sees a `Host:
 * <companion>`, which do not match, so every socket is refused and the
 * embedded UI sits on "Connecting" forever.
 *
 * The temptation is to overwrite `Origin` in the relay and be done. That
 * works, and it hands every page on the internet a laundered route to the
 * operator's Companion — this app would become exactly the hole the check
 * exists to close.
 *
 * So the check is **moved, not removed**. We are the origin the browser sees,
 * so we are the only one who can still make the comparison meaningfully: the
 * upgrade's `Origin` must match the `Host` the browser used to reach *us*.
 * Once it does, rewriting `Origin` to Companion's own is just a proxy
 * restating a question it has already answered.
 *
 * A request with **no** `Origin` at all is allowed, which is the same rule
 * Companion itself applies: no `Origin` means no browser, and CSWSH is a
 * browser attack. A literal `"null"` origin — a sandboxed iframe, a
 * `file://` page — is refused, also as Companion does.
 */
export function originAllowed(origin, host) {
  if (origin === undefined || origin === null) return true;   /* not a browser */
  if (origin === 'null' || origin === '') return false;       /* sandboxed, or file:// */

  let originHost;
  let scheme = 'http';
  try {
    const url = new URL(origin);
    originHost = url.host.toLowerCase();
    scheme = url.protocol === 'https:' ? 'https' : 'http';
  } catch {
    return false;                                             /* malformed */
  }
  if (!originHost) return false;

  const expected = normaliseHost(host, scheme);
  return !!expected && originHost === expected;
}

/* --------------------------------------------------------------- the surface */

/**
 * Every location on one Companion page, in reading order.
 *
 * A page is a fixed grid and Companion addresses a button by
 * `pageNumber/row/column` — not by a key number, which is a surface's idea
 * rather than a page's. The default 4x8 is Companion's own default page size.
 * A show that has changed it says so in its user config, as `gridSize` —
 * `{ minRow, maxRow, minColumn, maxColumn }`, inclusive, and the minimums may
 * be **negative**: a grid grown upwards or leftwards keeps the buttons it had
 * at 0/0 and adds rows at -1, -2. So this takes either the plain
 * `{ rows, columns }` or that shape, and never assumes a grid starts at 0.
 *
 * **The field really is `pageNumber`.** Companion's `zodLocation` names it
 * that, and a `{page,…}` sent instead is refused with the same "Invalid or
 * malformed input" every other shape error produces — which names the
 * procedure but not the field. This spelling is kept end to end rather than
 * translated at the socket, so there is nowhere for the two names to drift
 * apart. Note also that pages count from **1**; rows and columns count from
 * whatever `gridSize` says, 0 by default.
 */
export function pageGrid(pageNumber, size = {}) {
  const { rows, columns } = gridAxes(size);
  const out = [];
  for (const row of rows) {
    for (const column of columns) out.push({ pageNumber, row, column });
  }
  return out;
}

/** Companion's own default, 4 rows by 8 columns from 0/0. */
export const DEFAULT_GRID = Object.freeze({ minRow: 0, maxRow: 3, minColumn: 0, maxColumn: 7 });

/**
 * The row and column numbers a grid spans, from either spelling of its size.
 * A malformed or absurd size falls back to Companion's default rather than
 * drawing nothing — or drawing ten thousand subscriptions.
 */
export function gridAxes(size = {}) {
  const int = (v) => (Number.isInteger(v) ? v : null);
  let minRow, maxRow, minColumn, maxColumn;
  if (int(size.rows) != null || int(size.columns) != null) {
    minRow = 0; maxRow = (int(size.rows) ?? 4) - 1;
    minColumn = 0; maxColumn = (int(size.columns) ?? 8) - 1;
  } else {
    minRow = int(size.minRow) ?? DEFAULT_GRID.minRow;
    maxRow = int(size.maxRow) ?? DEFAULT_GRID.maxRow;
    minColumn = int(size.minColumn) ?? DEFAULT_GRID.minColumn;
    maxColumn = int(size.maxColumn) ?? DEFAULT_GRID.maxColumn;
  }
  const span = (a, b) => (b >= a && b - a < 64 ? Array.from({ length: b - a + 1 }, (_, i) => a + i) : null);
  const rows = span(minRow, maxRow);
  const columns = span(minColumn, maxColumn);
  if (!rows || !columns) return gridAxes(DEFAULT_GRID);
  return { rows, columns };
}

/**
 * The key a location is cached and subscribed under.
 *
 * Also exactly the path segment order the HTTP API wants —
 * `POST /api/location/<page>/<row>/<column>/press` — so a press is this key
 * with a verb on the end rather than a second way of spelling a location.
 */
export const locationKey = ({ pageNumber, row, column }) => `${pageNumber}/${row}/${column}`;

/* ------------------------------------------------------- pressing a button */

/**
 * A location as an operator types it: `page/row/column`, the order Companion's
 * own HTTP and OSC APIs spell it in and the one its button editor shows.
 * A dot or a space does as well as a slash. Rows and columns may be negative
 * (see `pageGrid`); a page may not. Null for anything else — a typed trigger
 * that half-parsed would press some other button entirely.
 */
export function parseLocation(text) {
  const m = /^\s*(\d+)\s*[/. ]\s*(-?\d+)\s*[/. ]\s*(-?\d+)\s*$/.exec(String(text ?? ''));
  if (!m) return null;
  const pageNumber = Number(m[1]);
  if (pageNumber < 1 || pageNumber > 999) return null;
  return { pageNumber, row: Number(m[2]), column: Number(m[3]) };
}

/** A location in its own validated shape, or null — for anything read back off disk. */
export function normaliseLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return parseLocation(`${raw.pageNumber}/${raw.row}/${raw.column}`);
}

/**
 * The cue action this plugin contributes: press one Companion button.
 *
 * The kind starts with the plugin's id, as `docs/PLUGINS.md` asks, and the
 * location is stored in Companion's own spelling so a cue file means the same
 * thing to anybody who reads it next to a Companion export.
 */
export const PRESS_KIND = 'companion:press';

export const pressAction = (location) => ({
  kind: PRESS_KIND,
  pageNumber: location.pageNumber,
  row: location.row,
  column: location.column,
});

/**
 * Several locations typed into one field: `1/0/3, 2/1/0`. Answers the
 * locations, or throws with a sentence naming the part that did not read —
 * a cue field that dropped the bad half without a word would be a cue that
 * pressed one button of the two its operator asked for.
 */
export function parseLocationList(text) {
  const parts = String(text ?? '').split(/[,;]+/).map((p) => p.trim()).filter(Boolean);
  return parts.map((part) => {
    const loc = parseLocation(part);
    if (!loc) throw new Error(`“${part}” is not a button — write page/row/column, like 1/0/3`);
    return loc;
  });
}

export const formatLocationList = (locations) => (locations || []).map(locationKey).join(', ');

/* -------------------------------------------------------- memory triggers */

/**
 * Buttons pressed when a memory is recalled, kept per switcher — a memory
 * slot means one box's memory and nothing on another.
 *
 *   { version: 1, memories: { "<bank>:<slot>": [ {pageNumber,row,column}, … ] } }
 *
 * `bank` is the dialect's bank kind — `master`, `screen`, `layer` on a
 * LivePremier, `aux` as well on a Midra — so a trigger reads the same way the
 * Memories panel names the bank.
 */
export const EMPTY_TRIGGERS = Object.freeze({ version: 1, memories: {} });

export const triggerKey = (bank, slot) => `${bank}:${slot}`;

export function normaliseTriggers(raw) {
  const out = { version: 1, memories: {} };
  const memories = raw && typeof raw === 'object' && raw.memories && typeof raw.memories === 'object'
    ? raw.memories : {};
  for (const [key, list] of Object.entries(memories)) {
    if (!/^[a-z]+:\d+$/.test(key) || !Array.isArray(list)) continue;
    const locations = list.map(normaliseLocation).filter(Boolean);
    if (locations.length) out.memories[key] = locations;
  }
  return out;
}

/**
 * Which memory a write recalls, if it recalls one — the inverse of the
 * dialect's `recall()`, read off the path rather than asked of the dialect,
 * so it does not care which part of the page sent it: this app's Memories
 * panel, a cue, the Console, or the vendor's own Memories tab.
 *
 * Every recall on both platforms is
 * `[device, …bank.root, 'control', 'load', 'slotList', 'items', <slot>, …, 'xRequest']`
 * written `true`, and the bank is whichever of the dialect's banks the path
 * starts with. `mode` is the buffer, when the path names one.
 *
 * @param {{banks: {kind: string, root: string[]}[]}} dialect
 */
export function recallOf(dialect, path, value) {
  if (!dialect || !Array.isArray(dialect.banks) || value !== true || !Array.isArray(path)) return null;
  if (path[path.length - 1] !== 'xRequest') return null;
  for (const bank of dialect.banks) {
    const at = 1 + bank.root.length;
    if (!bank.root.every((seg, i) => path[1 + i] === seg)) continue;
    if (path[at] !== 'control' || path[at + 1] !== 'load' || path[at + 2] !== 'slotList' || path[at + 3] !== 'items') continue;
    const slot = Number(path[at + 4]);
    if (!Number.isInteger(slot) || slot < 1) return null;
    const i = path.indexOf('presetList', at + 5);
    const mode = i > 0 && path[i + 1] === 'items' ? path[i + 2] : null;
    return { bank: bank.kind, slot, mode: mode === 'PROGRAM' || mode === 'PREVIEW' ? mode : null };
  }
  return null;
}
