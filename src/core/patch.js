/*
 * The patch: which socket on the switcher is on the other end of which port
 * on an external router, and what routing follows from that.
 *
 * This file is a cable schedule and the arithmetic over it. It opens no
 * socket and knows no protocol — `plugins/matrix-routing/routers/` does that — so the rules
 * below can be tested against a plain object under `node --test`, which is
 * the only way anybody is going to check them without a rack.
 *
 * ## The one idea
 *
 * A router port and a switcher socket are the two ends of one cable, so the
 * *direction inverts*:
 *
 * ```text
 *   switcher INPUT   <--- cable ---   router OUTPUT     (the router feeds us)
 *   switcher OUTPUT   --- cable --->  router INPUT      (we feed the router)
 * ```
 *
 * That inversion is the whole model, and it is the thing that reads wrong at
 * first glance every single time. An entry therefore stores the switcher side
 * only and **derives** the router side, because a stored direction is a stored
 * opportunity to disagree with the side it belongs to.
 *
 * From it, the two operations fall out, and they are not symmetrical:
 *
 * - **Feed an input.** The socket is fed by one router output, so choosing
 *   what the switcher sees is choosing that output's source: exactly one
 *   crosspoint, and it fully determines the result.
 * - **Send an output.** The socket arrives at one router input, so putting it
 *   somewhere is setting *those destinations* to that input: one crosspoint
 *   per destination named, and it determines only the ones named.
 *
 * ⚠️ **A send does not take away.** Naming outputs 1-4 routes 1-4 and leaves
 * output 5 alone even if it was showing this source a moment ago. That is not
 * laziness: a router output always shows *something*, so "removing" a
 * destination means choosing a different source for it, and there is no
 * answer to which one that should be. Anything that wants output 5 to show
 * something else has to say so.
 *
 * ## Numbering
 *
 * ⚠️ **Everything here counts from 1**, because every front panel, every one
 * of the three protocols' own documentation and every operator does. The
 * Videohub *wire* counts from 0 — see `plugins/matrix-routing/routers/videohub.js`, which is
 * the only place in this repo allowed to know that, exactly as
 * `core/paths.js` is the only place that knows the AWJ spelling. A number
 * that crosses this boundary in the wrong base routes the wrong crosspoint
 * and looks plausible doing it.
 *
 * ## What is per-device and what is not
 *
 * The **patch is per device**, filed with the cue stack, because it describes
 * this frame's sockets: a different frame is a different set of cables. The
 * **matrix list is not** — the same router serves whichever frame you point
 * at, so it lives with the installation's settings, and re-pointing at a
 * backup frame must not drop the routers off the network. Same reasoning as
 * `core/settings.js` gives for the OSC port.
 */

/** Switcher side -> the router side at the other end of the cable. */
export const ROUTER_SIDE = { input: 'output', output: 'input' };

/** The drivers that exist, as the panel and the server both need to name them. */
export const MATRIX_KINDS = [
  {
    id: 'videohub',
    label: 'Blackmagic Videohub',
    what: 'Videohub Ethernet Protocol, TCP 9990. Pushes every change, so the grid stays live without polling.',
    defaultPort: 9990,
  },
  {
    id: 'lightware',
    label: 'Lightware',
    what: 'LW3 on TCP 6107 or LW2 on TCP 10001 — whichever the frame answers. LW3 pushes changes; LW2 is polled.',
    defaultPort: 6107,
  },
  {
    id: 'turtle',
    label: 'Turtle AV',
    what: 'The ASCII command set on TCP 8000. Answers what it is asked and pushes nothing, so it is polled.',
    defaultPort: 8000,
  },
  {
    id: 'placeholder',
    label: 'Placeholder (no hardware)',
    what: 'A router of the right size with nothing on the other end — patch, route and cue a show before the real one is on the network, then go live and push the plan.',
    defaultPort: 0,
  },
];

/** The kinds that are a real frame on the network, which a placeholder can become. */
export const LIVE_KINDS = MATRIX_KINDS.filter((k) => k.id !== 'placeholder');

export const MATRIX_KIND_IDS = MATRIX_KINDS.map((k) => k.id);

/* A port number a person could have typed. Routers this size do not exist,
   which is the point: it is a sanity bound, not a model table. The real limit
   is whatever the connected router reports, and `validate` uses that when it
   has it. */
const MAX_PORT = 1024;

/**
 * Coerce a stored matrix list into a valid one.
 *
 * Same contract as `core/settings.js` normalise: a bad field falls back
 * rather than taking the list down, because this runs on a file a previous
 * version wrote and a person may have edited. A matrix with no usable id or
 * host is dropped — there is nothing to fall back *to* for those two.
 */
export function normaliseMatrices(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.matrices) ? raw.matrices : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = slug(item.id ?? item.name);
    const kind = MATRIX_KIND_IDS.includes(item.kind) ? item.kind : 'videohub';
    const placeholder = kind === 'placeholder';
    const host = typeof item.host === 'string' ? item.host.trim() : '';
    /* A placeholder has no address — that is what it is — but it has a size,
       and a size is the one thing it cannot fall back on. */
    const inputs = portCount(item.inputs);
    const outputs = portCount(item.outputs);
    if (!id || seen.has(id)) continue;
    if (placeholder ? !(inputs && outputs) : !host) continue;
    seen.add(id);

    const defaultPort = MATRIX_KINDS.find((k) => k.id === kind).defaultPort;
    const port = Number(item.port);
    const plan = normalisePlan(item.plan);
    out.push({
      id,
      kind,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      host: placeholder ? '' : host,
      port: placeholder ? 0 : Number.isInteger(port) && port > 0 && port < 65536 ? port : defaultPort,
      enabled: item.enabled !== false,
      /* What it was planned as. A live router keeps these so the panel can say
         when the frame that turned up is not the one the show was built on. */
      ...(typeof item.model === 'string' && item.model ? { model: item.model } : {}),
      ...(typeof item.modelLabel === 'string' && item.modelLabel ? { modelLabel: item.modelLabel } : {}),
      ...(inputs && outputs ? { inputs, outputs } : {}),
      ...(plan ? { plan } : {}),
    });
  }
  return out;
}

const portCount = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= MAX_PORT ? n : 0;
};

/**
 * A routing plan — `{ output: input }`, 1-based, the shape every driver
 * reports — or null if there is nothing usable in it. Bad pairs are dropped
 * one at a time, not the plan, for the same reason as everything else here.
 */
export function normalisePlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const output = portCount(key);
    const input = portCount(value);
    if (output && input) out[output] = input;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The crosspoints that would make a router match a plan: every planned
 * destination whose current source differs, within the size it reports.
 *
 * Returns what would be sent and, separately, what cannot be — a plan built on
 * a 40×40 placeholder pushed to the 20×20 that turned up must say which half
 * of the show did not make it, rather than routing the half that fits and
 * looking finished.
 *
 * @param {Object<number,number>} plan
 * @param {{inputs:number, outputs:number, routing:Object}} state  the live router's
 */
export function planCrosspoints(matrixId, plan, state) {
  const crosspoints = [];
  const outOfRange = [];
  let already = 0;
  for (const [key, input] of Object.entries(plan || {})) {
    const output = Number(key);
    if (output > state.outputs || input > state.inputs) {
      outOfRange.push({ output, input });
      continue;
    }
    if (Number(state.routing?.[output]) === input) { already++; continue; }
    crosspoints.push({ matrix: matrixId, output, input });
  }
  return { crosspoints, outOfRange, already };
}

/**
 * Coerce a stored patch into a valid one.
 *
 * Entries that name no connector or no matrix are dropped. Duplicates are
 * **not** dropped here — a duplicate is a real conflict an operator needs to
 * see and fix, not a parse error to swallow silently, so `validate` reports
 * it and the panel shows it. Quietly keeping the first of two would hide the
 * fact that somebody patched two cables to one port.
 */
export function normalisePatch(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.entries) ? raw.entries : [];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const side = item.side === 'input' || item.side === 'output' ? item.side : null;
    const key = item.key == null ? '' : String(item.key);
    const matrix = slug(item.matrix);
    const port = Number(item.port);
    if (!side || !key || !matrix) continue;
    if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) continue;
    out.push({
      side,
      key,
      matrix,
      port,
      /* Derived, never stored — see the header. Present on the object because
         every caller wants it and none should re-derive it. */
      routerSide: ROUTER_SIDE[side],
      note: typeof item.note === 'string' ? item.note.slice(0, 200) : '',
    });
  }
  return out;
}

/** `input:IN_5` for an entry, matching `core/connectors.js`. */
export const entryConnectorId = (entry) => `${entry.side}:${entry.key}`;

/** The entry for one switcher socket, or null. First wins; `validate` flags the rest. */
export function entryForConnector(patch, connectorId) {
  return patch.find((e) => entryConnectorId(e) === connectorId) ?? null;
}

/** Every entry landing on one matrix, by router side. */
export function entriesOnMatrix(patch, matrixId, routerSide = null) {
  return patch.filter((e) => e.matrix === matrixId && (!routerSide || e.routerSide === routerSide));
}

/**
 * Everything wrong with a patch, in the words an operator can act on.
 *
 * `matrices` is the configured list; `state` is what the drivers currently
 * know, keyed by matrix id, each `{inputs, outputs}` or absent. Port-range
 * problems are only reported for a matrix that has actually said how big it
 * is — before that, a number is not wrong, it is merely unconfirmed, and
 * calling it an error on a router that is simply offline would cry wolf every
 * time the network hiccuped.
 *
 * @returns {Array<{severity:'error'|'warning', entry:object|null, message:string}>}
 */
export function validate(patch, { matrices = [], state = {} } = {}) {
  const problems = [];
  const known = new Map(matrices.map((m) => [m.id, m]));

  const byConnector = new Map();
  const byPort = new Map();

  for (const entry of patch) {
    const matrix = known.get(entry.matrix);
    if (!matrix) {
      problems.push({
        severity: 'error',
        entry,
        message: `No matrix called “${entry.matrix}” is configured.`,
      });
    }

    /* One socket, one cable. */
    const cid = entryConnectorId(entry);
    if (byConnector.has(cid)) {
      problems.push({
        severity: 'error',
        entry,
        message: `${entry.side === 'input' ? 'Input' : 'Output'} ${entry.key} is patched twice.`,
      });
    } else byConnector.set(cid, entry);

    /* One port, one cable. */
    const pid = `${entry.matrix}:${entry.routerSide}:${entry.port}`;
    const clash = byPort.get(pid);
    if (clash) {
      problems.push({
        severity: 'error',
        entry,
        message: `${matrixName(matrix, entry.matrix)} ${entry.routerSide} ${entry.port} already has ${clash.side} ${clash.key} on it.`,
      });
    } else byPort.set(pid, entry);

    const size = state[entry.matrix];
    if (size) {
      const count = entry.routerSide === 'input' ? size.inputs : size.outputs;
      if (Number.isInteger(count) && entry.port > count) {
        problems.push({
          severity: 'error',
          entry,
          message: `${matrixName(matrix, entry.matrix)} has ${count} ${entry.routerSide}s; this names ${entry.port}.`,
        });
      }
    }
  }
  return problems;
}

/**
 * Feed a switcher input from a router source.
 *
 * One crosspoint: the router output this socket hangs off takes `sourcePort`.
 *
 * @param {Array} patch
 * @param {string} connectorId  `input:IN_5`
 * @param {number} sourcePort   1-based router input
 * @returns {{ok: true, crosspoints: Array<{matrix:string, output:number, input:number}>}
 *          | {ok: false, error: string}}
 */
export function feed(patch, connectorId, sourcePort) {
  const entry = entryForConnector(patch, connectorId);
  if (!entry) return fail(`${connectorId} is not patched to a matrix.`);
  if (entry.side !== 'input') {
    return fail(`${connectorId} is an output — an output is sent, not fed.`);
  }
  if (!isPort(sourcePort)) return fail(`${sourcePort} is not a port number.`);
  return {
    ok: true,
    crosspoints: [{ matrix: entry.matrix, output: entry.port, input: sourcePort }],
  };
}

/**
 * Send a switcher output to router destinations.
 *
 * One crosspoint per destination. See the header for why this adds and never
 * removes.
 *
 * @param {Array} patch
 * @param {string} connectorId   `output:5`
 * @param {number[]} destPorts   1-based router outputs
 */
export function send(patch, connectorId, destPorts) {
  const entry = entryForConnector(patch, connectorId);
  if (!entry) return fail(`${connectorId} is not patched to a matrix.`);
  if (entry.side !== 'output') {
    return fail(`${connectorId} is an input — an input is fed, not sent.`);
  }
  const ports = Array.isArray(destPorts) ? destPorts : [destPorts];
  if (!ports.length) return fail('No destinations given.');
  const bad = ports.find((p) => !isPort(p));
  if (bad !== undefined) return fail(`${bad} is not a port number.`);

  /* De-duplicated, because naming a destination twice is a typo rather than a
     request to route it twice, and the drivers should not see the same
     crosspoint arrive at them two deep. */
  const unique = [...new Set(ports)];
  return {
    ok: true,
    crosspoints: unique.map((output) => ({ matrix: entry.matrix, output, input: entry.port })),
  };
}

/**
 * What a switcher socket is currently seeing, or arriving at, per the router.
 *
 * `routing` is the driver's view: source port per destination port, 1-based,
 * null where the router has not said. For an input this is one answer. For an
 * output it is a list, because a router input can be on any number of
 * destinations at once and an operator wants to see all of them.
 */
export function currentFor(patch, connectorId, routing) {
  const entry = entryForConnector(patch, connectorId);
  if (!entry) return null;
  const table = routing && routing[entry.matrix];
  if (!table) return { entry, known: false };

  if (entry.side === 'input') {
    const source = table[entry.port];
    return { entry, known: true, source: source ?? null };
  }
  const destinations = Object.entries(table)
    .filter(([, source]) => Number(source) === entry.port)
    .map(([dest]) => Number(dest))
    .sort((a, b) => a - b);
  return { entry, known: true, destinations };
}

/**
 * The router ports one socket can choose between, and where each one stands.
 *
 * Both of the per-socket surfaces (`plugins/matrix-routing/router-box.js`) draw this twice — as a
 * grid of port tiles and as a list — and the two must never disagree, so the
 * model is built once here and both are drawn from it.
 *
 * The choice is on the side opposite the cable, which is the inversion again:
 *
 * - An **input** is hung off a router output, so it chooses among router
 *   *inputs*. Exactly one of them is `live` — the source that output takes.
 * - An **output** arrives at a router input, so it chooses among router
 *   *outputs*. Any number are `live` — every destination already taking it —
 *   and each port also carries `source`, what it is showing now, because
 *   sending there replaces that and an operator should see what they displace.
 *
 * `count` is what the router reported. Before it has said, there are no
 * ports: a grid of guessed ports is a grid of buttons that may route nothing.
 *
 * @param {object} entry     a normalised patch entry
 * @param {{inputs?:number, outputs?:number, inputLabels?:object, outputLabels?:object}|null} state
 * @param {object} routing   the router's table, destination -> source, 1-based
 * @returns {{side:'input'|'output', ports:Array<{port:number, label:string, live:boolean, source?:number|null}>}}
 */
export function choicesFor(entry, state, routing) {
  const side = entry.side === 'input' ? 'input' : 'output';
  const count = state ? (side === 'input' ? state.inputs : state.outputs) : 0;
  const labels = (state && (side === 'input' ? state.inputLabels : state.outputLabels)) || {};
  const table = routing || {};
  const ports = [];
  for (let port = 1; Number.isInteger(count) && port <= Math.min(count, MAX_PORT); port++) {
    const label = labels[port] ? String(labels[port]) : '';
    if (side === 'input') {
      ports.push({ port, label, live: Number(table[entry.port]) === port });
    } else {
      const source = table[port] == null ? null : Number(table[port]);
      ports.push({ port, label, live: source === entry.port, source });
    }
  }
  return { side, ports };
}

/**
 * The patch with one socket's cable replaced, added or removed.
 *
 * The per-socket surfaces edit one entry at a time, but the server stores the
 * whole schedule, so this is the one place that turns "this socket is on hub
 * output 3" into a new list. `null` for the matrix unpatches. Every other
 * entry is kept exactly as it was, including a duplicate `validate` would
 * flag — fixing somebody else's conflict is not this edit's business.
 */
export function withEntry(patch, connectorId, { matrix, port } = {}) {
  const match = /^(input|output):(.+)$/.exec(String(connectorId ?? ''));
  if (!match) return patch;
  const rest = patch.filter((e) => entryConnectorId(e) !== connectorId);
  if (!matrix) return rest;
  return normalisePatch([...rest, { side: match[1], key: match[2], matrix, port }]);
}

/**
 * Group crosspoints by matrix, so a caller makes one call per router.
 *
 * Order within a matrix is preserved. A later crosspoint for the same output
 * replaces an earlier one rather than both being sent — two routes to one
 * destination in a single action is a contradiction, and sending both means
 * the result depends on which arrived last.
 */
export function groupCrosspoints(crosspoints) {
  const byMatrix = new Map();
  for (const point of crosspoints) {
    if (!byMatrix.has(point.matrix)) byMatrix.set(point.matrix, new Map());
    byMatrix.get(point.matrix).set(point.output, point.input);
  }
  return [...byMatrix].map(([matrix, routes]) => ({
    matrix,
    routes: [...routes].map(([output, input]) => ({ output, input })),
  }));
}

/**
 * Destinations as somebody would actually write them.
 *
 * `4`, `[1,2,3]`, `"1-4"` and `"1,2,5-8"` all mean the same thing to an
 * operator, and a range is how a person says "outputs 1 to 4" — the request
 * this feature was asked for used exactly that phrasing. Anything
 * unparseable is dropped rather than coerced to zero, because port 0 is
 * refused and a silent 0 would surface as an error about a port nobody typed.
 */
export function toPortList(value) {
  if (value == null) return [];
  const tokens = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const token of tokens) {
    if (typeof token === 'number') { if (Number.isInteger(token)) out.push(token); continue; }
    const text = String(token).trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(text);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      /* A descending range is a typo, not a request to count backwards. */
      if (from <= to && to - from < MAX_PORT) for (let n = from; n <= to; n++) out.push(n);
      continue;
    }
    const single = Number(text);
    if (Number.isInteger(single)) out.push(single);
  }
  return out;
}

/**
 * This app's own OSC address space for matrix routing.
 *
 * ⚠️ **Deliberately not in mynah.** Every other OSC address this app answers
 * belongs to `vendor/mynah-lang.mjs`, because it addresses the *switcher* and
 * there must be exactly one statement of that grammar. A router in front of
 * the switcher is not the switcher: mynah has never heard of it, the device
 * store has never heard of it, and putting these addresses upstream would be
 * asking a language about a box it does not describe. So this is ours, it is
 * documented as ours, and it lives beside the model it addresses.
 *
 * ```text
 *   /lp/matrix/input/5/source        7          feed switcher input 5 from router input 7
 *   /lp/matrix/output/2/destinations "1-4"      send switcher output 2 to router outputs 1-4
 *   /lp/matrix/hub/route/3           9          router "hub": output 3 takes input 9
 * ```
 *
 * The first two count in **switcher connector numbers** and consult the patch;
 * the third counts in **router port numbers** and does not. A sender that has
 * no patch can still drive a router with the third form.
 *
 * ⚠️ The connector number is the logical one — `/input/5` is the socket the
 * device calls `IN_5`, and an output's is its bare key. The patch is matched
 * on that number, so a sender never has to know the `IN_` prefix exists.
 *
 * @returns {{ok:true, crosspoints:Array, summary:string}|{ok:false, error:string}|null}
 *          null when the address is not ours at all, which is how the caller
 *          knows to pass it on to mynah rather than reject it.
 */
export function resolveMatrixOsc(address, args, patch) {
  const parts = String(address ?? '').split('/').filter(Boolean);
  if (parts[0] !== 'lp' || parts[1] !== 'matrix') return null;

  const first = (fallback) => (args && args.length ? args[0] : fallback);

  /* /lp/matrix/<side>/<n>/<verb> */
  if ((parts[2] === 'input' || parts[2] === 'output') && parts.length === 5) {
    const side = parts[2];
    const number = Number(parts[3]);
    if (!Number.isInteger(number)) return { ok: false, error: `“${parts[3]}” is not a connector number` };

    const entry = patch.find((e) => e.side === side && keyIndex(e.key) === number);
    if (!entry) return { ok: false, error: `switcher ${side} ${number} is not patched to a matrix` };
    const id = entryConnectorId(entry);

    if (side === 'input' && parts[4] === 'source') {
      const source = Number(first(null));
      const result = feed(patch, id, source);
      return result.ok
        ? { ...result, summary: `feed ${side} ${number} from ${entry.matrix} input ${source}` }
        : result;
    }
    if (side === 'output' && (parts[4] === 'destinations' || parts[4] === 'destination')) {
      /* Several ints, or one string holding a range — senders differ, and
         both are obviously what was meant. */
      const ports = args && args.length > 1 ? toPortList(args) : toPortList(first(null));
      const result = send(patch, id, ports);
      return result.ok
        ? { ...result, summary: `send ${side} ${number} to ${entry.matrix} outputs ${ports.join(', ')}` }
        : result;
    }
    return { ok: false, error: `no such matrix address: ${address}` };
  }

  /* /lp/matrix/<matrixId>/route/<output> */
  if (parts[3] === 'route' && parts.length === 5) {
    const matrix = slug(parts[2]);
    const output = Number(parts[4]);
    const input = Number(first(null));
    if (!isPort(output)) return { ok: false, error: `“${parts[4]}” is not a router output number` };
    if (!isPort(input)) return { ok: false, error: `“${first('')}” is not a router input number` };
    return {
      ok: true,
      crosspoints: [{ matrix, output, input }],
      summary: `${matrix}: output ${output} takes input ${input}`,
    };
  }

  return { ok: false, error: `no such matrix address: ${address}` };
}

/**
 * The dictionary entries for the addresses above, in mynah's own entry shape
 * so one table renderer does both. Beside the resolver on purpose:
 * `test/osc.test.js` runs each one through `resolveMatrixOsc`, and
 * `tools/gen-osc-docs.mjs` and the website publish them from here.
 */
export const MATRIX_OSC = [
  {
    group: 'External matrix routing',
    address: '/lp/matrix/input/{n}/source',
    args: 'int — a router input',
    summary: 'Feed switcher input n from that router input. One crosspoint. Needs input n patched to a router.',
  },
  {
    group: 'External matrix routing',
    address: '/lp/matrix/output/{n}/destinations',
    args: 'ints, or one string such as "1-4" or "1,2,5-8"',
    summary: 'Send switcher output n to those router outputs, one crosspoint each. Adds and never takes away. Needs output n patched to a router.',
  },
  {
    group: 'External matrix routing',
    address: '/lp/matrix/{router}/route/{out}',
    args: 'int — a router input',
    summary: 'Raw crosspoint on the router with that id: output out takes that input. Consults no patch.',
  },
];

/** The logical number in a connector key, either spelling. See core/connectors.js. */
const keyIndex = (key) => {
  const match = /^(?:IN_|OUT_)?(\d+)$/.exec(String(key));
  return match ? Number(match[1]) : null;
};

const isPort = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_PORT;
const fail = (error) => ({ ok: false, error });
const matrixName = (matrix, id) => (matrix ? matrix.name : id);

/* Ids have to survive being a key in a settings file, an OSC address and a
   fragment of a console command, so they are reduced to the set all three
   agree on rather than escaped differently in each. */
function slug(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}
