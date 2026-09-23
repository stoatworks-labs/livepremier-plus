/*
 * HyperDecks — the plugin's server half: the decks, a link to each, and the
 * commands.
 *
 * The deck list belongs to the installation, like Matrix Routing's routers: a
 * deck in the rack does not move when the app is re-pointed at a backup frame,
 * so re-pointing does not hang any deck up. It is `hyperdecks.json`, and the
 * setup file carries it.
 *
 * ## Where the rules run, and why not here
 *
 * The rules watch what is on air, and **this process holds no store mirror**
 * — `server/awj.js` argues why and `server/osc.js` refuses `program` for the
 * same reason. The page has the live store already, so the rules run there,
 * in one page at a time: an open page claims the lease (`/runner`, the
 * Pixelhue panel's pattern) and only the holder acts, so two open tabs do not
 * both press play. The price is the Timeline's: automation needs a Web RCS
 * page open with this app in it. The panel says so when none holds the lease.
 *
 * What the server does do is notice a clip ending — the transport is here —
 * and tell the pages on `/stream`, where the lease holder decides what that
 * means for the screens.
 */

import { EventEmitter } from 'node:events';
import { DeckLink } from './link.js';
import { normaliseDecks, resolveDecks, plays, records, parseDeckOsc, HYPERDECK_OSC } from './core.js';
import { COMMANDS, RECORD_COMMANDS } from './protocol.js';

const RUNNER_LEASE_MS = 12000;

/** One link per enabled deck with a host; diff-based, so a rename is not a reconnect. */
export class DeckSupervisor extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    this.entries = new Map();
  }

  apply(decks) {
    const wanted = new Map(decks.filter((d) => d.enabled && d.host).map((d) => [d.id, d]));
    for (const [id, entry] of [...this.entries]) {
      const next = wanted.get(id);
      if (!next || identity(next) !== identity(entry.config)) {
        entry.link.removeAllListeners();
        entry.link.close();
        this.entries.delete(id);
      } else {
        entry.config = next;
        entry.link.name = next.name;
      }
    }
    for (const [id, config] of wanted) {
      if (this.entries.has(id)) continue;
      const link = new DeckLink({ ...config, log: this.log });
      link.on('change', () => this.emit('change'));
      link.on('ended', (e) => this.emit('ended', e));
      this.entries.set(id, { config, link });
      link.connect();
    }
    this.emit('change');
  }

  get(id) { return this.entries.get(id)?.link ?? null; }

  describe() { return [...this.entries.values()].map((e) => e.link.describe()); }

  stop() {
    for (const { link } of this.entries.values()) { link.removeAllListeners(); link.close(); }
    this.entries.clear();
  }
}

const identity = (d) => `${d.host}:${d.port}:${d.profile}`;

export default async function activate(ctx) {
  const supervisor = new DeckSupervisor({ log: ctx.log });
  ctx.onDispose(() => supervisor.stop());

  let decks = [];
  let runner = null;
  const runnerId = () => (runner && Date.now() - runner.at <= RUNNER_LEASE_MS ? runner.id : null);

  const snapshot = () => ({ decks, live: supervisor.describe(), runner: runnerId() });

  const stream = ctx.stream('/stream', { onOpen: (first) => first.send('decks', snapshot()) });
  /* A playing deck reports four times a second; the pages hear at most that. */
  let pending = null;
  supervisor.on('change', () => {
    if (pending) return;
    pending = setTimeout(() => { pending = null; stream.send('decks', snapshot()); }, 50);
    pending.unref?.();
  });
  ctx.onDispose(() => { if (pending) clearTimeout(pending); });
  supervisor.on('ended', (e) => stream.send('ended', { ...e, runner: runnerId() }));

  const raw = ctx.storage ? await ctx.storage.load('hyperdecks') : null;
  decks = normaliseDecks(raw);
  supervisor.apply(decks);

  async function save(next) {
    decks = normaliseDecks(next);
    if (ctx.storage) await ctx.storage.save('hyperdecks', { decks });
    supervisor.apply(decks);
  }

  /**
   * Run commands on the decks a reference names, and say what each did. A
   * group (`recorders`) is sent only what its members can do: `record` to the
   * players in `all` is skipped, not refused, so "all stop" means what it says.
   */
  async function run(ref, sequence) {
    const targets = resolveDecks(decks, ref);
    if (!targets.length) return { ok: false, error: `no deck “${ref}”` };
    const group = targets.length > 1 || ref === 'all' || ref === 'players' || ref === 'recorders';
    const results = await Promise.all(targets.map(async (deck) => {
      const link = supervisor.get(deck.id);
      const out = [];
      for (const step of sequence) {
        if (!COMMANDS[step.command]) { out.push({ ok: false, error: `no command “${step.command}”` }); break; }
        if (group && RECORD_COMMANDS.has(step.command) && !records(deck)) continue;
        if (group && step.command === 'play' && !plays(deck)) continue;
        if (!link) { out.push({ ok: false, error: `${deck.name} is ${deck.enabled ? 'not set up with an address' : 'switched off'}` }); break; }
        const r = await link.send(step.command, step);
        out.push(r);
        if (!r.ok) break;
      }
      return { deck: deck.id, results: out };
    }));
    const errors = results.flatMap((r) => r.results.filter((x) => !x.ok).map((x) => x.error));
    return { ok: errors.length === 0, results, ...(errors.length ? { error: errors.join('; ') } : {}) };
  }

  ctx.route('GET', '/', (req, res, h) => h.json(200, snapshot()));
  const put = async (req, res, h) => {
    const body = await h.readJson(256 * 1024);
    await save(body.decks ?? body);
    h.json(200, { ok: true, ...snapshot() });
  };
  ctx.route('PUT', '/', put);
  ctx.route('POST', '/', put);

  /* `{deck, command, …args}` or `{deck, sequence: [{command, …args}]}`. */
  ctx.route('POST', '/command', async (req, res, h) => {
    const body = await h.readJson(16 * 1024);
    const sequence = Array.isArray(body.sequence) ? body.sequence : [body];
    if (!sequence.length || sequence.length > 8) throw new ctx.HttpError(400, 'one to eight commands');
    const result = await run(String(body.deck ?? ''), sequence.map((s) => ({ ...s, command: String(s.command ?? '') })));
    h.json(result.ok ? 200 : 409, result);
  });

  /* An open page's claim to run the rules. Renewed every few seconds; lapses when the page goes. */
  ctx.route('POST', '/runner', async (req, res, h) => {
    const body = await h.readJson(4 * 1024);
    const id = body.id ? String(body.id) : null;
    const now = Date.now();
    const had = runnerId();
    if (id && (!had || had === id)) runner = { id, at: now };
    if (body.release && runner?.id === id) runner = null;
    if (runnerId() !== had) stream.send('decks', snapshot());
    h.json(200, { runner: runnerId() });
  });

  ctx.contribute('configSection', {
    key: 'hyperdecks',
    group: 'installation',
    label: 'HyperDecks',
    export: () => (decks.length ? decks : undefined),
    import: (data) => save(data),
  });

  /*
   * `/hyperdeck/<deck>/<command> [argument]` — the deck by name, id, position
   * or group (`all`, `players`, `recorders`). `/hyperdeck/2/clip 4`,
   * `/hyperdeck/recorders/record "Act 1"`, `/hyperdeck/opener/play`.
   */
  ctx.contribute('oscAddress', {
    prefix: '/hyperdeck/',
    describe: 'Play, stop, record and cue the HyperDecks — docs/HYPERDECK.md',
    entries: HYPERDECK_OSC,
    async handle(address, args) {
      const parsed = parseDeckOsc(address, args);
      if (parsed.error) return { ok: false, error: parsed.error };
      const { ref, step } = parsed;
      const r = await run(ref, [step]);
      return r.ok ? { ok: true, summary: `${ref} ${step.command}`, count: r.results.length } : { ok: false, error: r.error };
    },
  });
}
