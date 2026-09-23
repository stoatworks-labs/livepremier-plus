/*
 * The Pixelhue panel supervisor.  ** PREVIEW **
 *
 * Holds one console link, feeds it a model of the switcher, and turns what it
 * reports back into writes. `core.js` beside this has the reasoning for the
 * model-and-intents shape; `ucenter.js` has the one for holding a socket open;
 * `server.js` puts it on the app as a plugin.
 *
 * ## It reads the switcher in bursts, and holds nothing open on it
 *
 * There is no store mirror in this process — `server/osc.js` says so and
 * refuses `preview`/`program` for exactly that reason. A panel needs rather
 * more than OSC does: screen names, input names, memory names, and, before
 * every source change, which preset letter is preview.
 *
 * All of it is read with `server/awj.js`'s `exchange()` — a burst of `get`s on
 * one connection, which is then closed. **This deliberately does not open a
 * subscription**, and that is not an oversight:
 *
 * - The rule in `awj.js` stands until something needs to beat it, and a
 *   refresh-on-demand panel does not.
 * - A letter read at the moment of the write is a fact about the device. A
 *   letter read from a mirror is our opinion of it, and the whole app is
 *   careful about that distinction.
 * - It costs one round trip per source change on a local network. That is
 *   cheaper than the class of bug a stale mirror produces.
 *
 * What this gives up is **live tally**: a memory recalled from the Web RCS, or
 * a take fired from the front panel, does not relight the console's keys until
 * the next refresh. That is the honest limit of the preview, it is written
 * down in `docs/PIXELHUE.md`, and closing it is what a scoped subscription
 * would be *for* — at which point `awj.js`'s argument has to be beaten
 * properly, in writing, the way `plugins/matrix-routing/routers/` did.
 */

import { EventEmitter } from 'node:events';

import { exchange, AWJ_PORT } from '../../server/awj.js';
import { UCenterLink } from './ucenter.js';
import { NLC, MNG } from '../../src/core/dialect.js';
import { commandsFor } from '../../src/core/commands.js';
import { letterFor } from '../../src/vendor/surface/preset.js';
import { toAwj } from '../../src/core/paths.js';
import {
  businessModel, readIntent, writesFor, Selection, commandName, CONSOLE_MODELS,
} from './core.js';

export { CONSOLE_MODELS };

/* How much of a switcher to ask about. Bounded on purpose: these are `get`s in
   one burst, and a LivePremier has 24 screens, 20-odd inputs and a thousand
   memory slots, of which a console with an eight-key bus wants the first few
   pages. */
const SCREENS = 24;
const INPUTS = 24;
const MEMORIES = 32;
const HISTORY = 40;

const IDENTITY = {
  nlc: 'DeviceObject/system/$device/@items/1/@props/dev',
  mng: 'DeviceObject/system/@props/platformLabel',
};

export class PixelhueSupervisor extends EventEmitter {
  #link = null;
  #config = null;
  #dialect = null;
  #facts = null;

  /**
   * @param {object} opts
   * @param {() => string|null} opts.deviceHost  the switcher, as the proxy knows it
   */
  constructor({ deviceHost = () => null, awjPort = AWJ_PORT, log = () => {} } = {}) {
    super();
    this.deviceHost = deviceHost;
    this.awjPort = awjPort;
    this.log = log;
    this.selection = new Selection();
    this.history = [];
  }

  /* --------------------------------------------------------------- lifecycle */

  /**
   * Bring the link into line with the settings. Idempotent and diff-based, the
   * same as `MatrixSupervisor.apply` — renaming nothing must not drop a panel
   * an operator is holding.
   */
  async apply(settings) {
    const want = settings && settings.pixelhueEnabled && settings.pixelhueHost
      ? {
        host: settings.pixelhueHost,
        model: settings.pixelhueModel,
        port: portFor(settings.pixelhueModel),
      }
      : null;

    const same = want && this.#config
      && want.host === this.#config.host && want.port === this.#config.port;
    if (same) { this.#config = want; return this.describe(); }

    if (this.#link) { await this.#link.stop(); this.#link = null; }
    this.#config = want;
    this.selection.reset();
    if (!want) { this.#note({ kind: 'stopped' }); return this.describe(); }

    const link = new UCenterLink({ host: want.host, port: want.port, log: this.log });
    this.#link = link;
    link.on('open', () => { this.#note({ kind: 'connected' }); void this.refresh(); });
    link.on('close', () => this.#note({ kind: 'disconnected' }));
    link.on('failure', (err) => this.#note({ kind: 'error', error: err.message }));
    link.on('command', (report) => { void this.#onCommand(report); });
    link.start();
    this.#note({ kind: 'starting', host: want.host, port: want.port, model: want.model });
    return this.describe();
  }

  async stop() {
    if (this.#link) { await this.#link.stop(); this.#link = null; }
    this.#config = null;
    this.selection.reset();
  }

  /* ------------------------------------------------------------- the switcher */

  /** One burst of AWJ `get`s, turned into the facts a model is built from. */
  async readFacts() {
    const host = this.deviceHost();
    if (!host) throw new Error('no switcher configured');

    const dialect = await this.#identify(host);
    const isNlc = dialect.id === 'nlc';

    /* Enumerating a collection is not something AWJ does — `@itemKeys` answers
       null even for collections that exist — so the ids come from the
       platform's own fixed ranges and `isUsed` / `isValid` decide what is
       real. */
    const ids = isNlc
      ? Array.from({ length: SCREENS }, (_, i) => `S${i + 1}`)
      : Array.from({ length: 4 }, (_, i) => `S${i + 1}`);

    const gets = [];
    for (const id of ids) {
      gets.push({ op: 'get', path: toAwj(dialect.takeStatus(id, 'isUsed')) });
      gets.push({ op: 'get', path: toAwj(labelPath(dialect, id)) });
    }
    for (let n = 1; n <= INPUTS; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) });
      gets.push({ op: 'get', path: toAwj(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) });
    }
    for (let slot = 1; slot <= MEMORIES; slot++) {
      const built = dialect.label('screen', slot, '');
      if (built) gets.push({ op: 'get', path: toAwj(built.path) });
    }

    const replies = await exchange({ host, port: this.awjPort, messages: gets });
    const byPath = new Map(replies.map((r) => [r.path, r.value]));
    const at = (path) => byPath.get(toAwj(path));

    const destinations = ids.map((id) => ({
      id,
      kind: id.startsWith('A') ? 'aux' : 'screen',
      label: String(at(labelPath(dialect, id)) || ''),
      isUsed: at(dialect.takeStatus(id, 'isUsed')) === true,
    }));

    const inputs = [];
    for (let n = 1; n <= INPUTS; n++) {
      const key = isNlc ? `IN_${n}` : String(n);
      if (at(['device', 'inputList', 'items', key, 'mapping', 'pp', 'isValid']) !== true) continue;
      const label = String(at(['device', 'inputList', 'items', key, 'control', 'pp', 'label']) || '');
      inputs.push({ number: n, source: isNlc ? `LIVE_${n}` : `INPUT_${n}`, label });
    }

    const presets = [];
    for (let slot = 1; slot <= MEMORIES; slot++) {
      const built = dialect.label('screen', slot, '');
      if (!built) continue;
      const label = byPath.get(toAwj(built.path));
      /* A slot with no label is an empty one. Publishing a bus full of
         "Memory 17" that recalls nothing is worse than a short bus. */
      if (!label) continue;
      presets.push({ slot, label: String(label) });
    }

    this.#dialect = dialect;
    this.#facts = { destinations, inputs, presets, deviceId: host };
    return this.#facts;
  }

  /** Read the switcher and hand the console a fresh model. */
  async refresh() {
    if (!this.#link) return null;
    try {
      const facts = await this.readFacts();
      const model = businessModel({
        ...facts,
        selection: { destination: this.selection.list[0] || null, layer: this.selection.layer },
      });
      await this.#link.publish(model);
      this.selection.restrict(model.screens.map((s) => s.uid));
      this.#note({
        kind: 'published',
        screens: model.screens.length,
        inputs: model.inputs.length,
        presets: model.presets.length,
      });
      return model;
    } catch (err) {
      this.#note({ kind: 'error', error: err.message });
      return null;
    }
  }

  /** Which preset letter is the panel's buffer, read from the device now. */
  async #lettersFor(ids) {
    const host = this.deviceHost();
    const dialect = this.#dialect;
    if (!host || !dialect || !ids.length) return new Map();
    const props = ['presetUp', 'presetDown', 'presetPrevious'];
    const gets = [];
    for (const id of ids) {
      for (const prop of props) gets.push({ op: 'get', path: toAwj(dialect.takeControl(id, prop)) });
      gets.push({ op: 'get', path: toAwj(dialect.takeStatus(id, 'transition')) });
    }
    const replies = await exchange({ host, port: this.awjPort, messages: gets });
    const byPath = new Map(replies.map((r) => [r.path, r.value]));
    const out = new Map();
    for (const id of ids) {
      const group = {
        control: { pp: Object.fromEntries(props.map((p) => [p, byPath.get(toAwj(dialect.takeControl(id, p)))])) },
        status: { pp: { transition: byPath.get(toAwj(dialect.takeStatus(id, 'transition'))) } },
      };
      out.set(id, letterFor(this.selection.buffer, group));
    }
    return out;
  }

  /* ----------------------------------------------------------------- intents */

  async #onCommand(report) {
    const intent = readIntent(report);
    const code = report && report.command;
    if (!intent) {
      this.#note({ kind: 'ignored', command: commandName(code) });
      return;
    }

    if (!this.selection.accepts(intent)) {
      this.#note({
        kind: 'noted',
        command: commandName(code),
        note: `refused — ${intent.destination || 'that screen'} is not one this app published`,
      });
      return;
    }

    const before = this.selection.describe();
    this.selection.apply(intent);
    const selectionMoved = JSON.stringify(before) !== JSON.stringify(this.selection.describe());

    let letters = new Map();
    if (intent.kind === 'source') {
      try {
        letters = await this.#lettersFor(this.selection.list);
      } catch (err) {
        this.#note({ kind: 'error', command: commandName(code), error: err.message });
        return;
      }
    }

    const { writes, note } = writesFor(intent, {
      dialect: this.#dialect,
      commands: commandsFor(this.#dialect),
      selected: this.selection.list,
      layer: this.selection.layer,
      buffer: this.selection.buffer,
      letterFor: (id) => letters.get(id) || null,
    });

    if (!writes.length) {
      this.#note({ kind: 'noted', command: commandName(code), note });
      if (selectionMoved) void this.#republish();
      return;
    }

    const host = this.deviceHost();
    if (!host) { this.#note({ kind: 'error', command: commandName(code), error: 'no switcher configured' }); return; }
    try {
      await exchange({
        host,
        port: this.awjPort,
        messages: writes.map((w) => ({ op: 'replace', path: toAwj(w.path), value: w.value })),
      });
      this.#note({ kind: 'sent', command: commandName(code), note, writes: writes.length });
    } catch (err) {
      this.#note({ kind: 'error', command: commandName(code), error: err.message });
    }
    if (selectionMoved) void this.#republish();
  }

  /** Re-send the model so the panel's lamps agree with the selection we hold. */
  async #republish() {
    if (!this.#link || !this.#facts) return;
    try {
      await this.#link.publish(businessModel({
        ...this.#facts,
        selection: { destination: this.selection.list[0] || null, layer: this.selection.layer },
      }));
    } catch (err) {
      this.#note({ kind: 'error', error: err.message });
    }
  }

  /* -------------------------------------------------------------- reporting */

  #note(entry) {
    const full = { at: Date.now(), ...entry };
    this.history.unshift(full);
    if (this.history.length > HISTORY) this.history.length = HISTORY;
    if (entry.error) this.log(`panel: ${entry.error}`);
    this.emit('activity', full);
  }

  describe() {
    return {
      preview: true,
      configured: !!this.#config,
      model: this.#config ? this.#config.model : null,
      host: this.#config ? this.#config.host : null,
      port: this.#config ? this.#config.port : null,
      platform: this.#dialect ? this.#dialect.name : null,
      link: this.#link ? this.#link.state : null,
      selection: this.selection.describe(),
      history: this.history.slice(0, 12),
    };
  }

  async #identify(host) {
    const replies = await exchange({
      host,
      port: this.awjPort,
      messages: [{ op: 'get', path: IDENTITY.nlc }, { op: 'get', path: IDENTITY.mng }],
    });
    const answered = (path) => replies.find(
      (r) => r.path === path && typeof r.value === 'string' && r.value !== '',
    );
    if (answered(IDENTITY.nlc)) return NLC;
    if (answered(IDENTITY.mng)) return MNG;
    throw new Error(`${host} answered neither identity path — is AWJ enabled on it?`);
  }
}

/**
 * Where a destination keeps its name.
 *
 * ⚠️ The two dialects disagree about how to get there and only one of them has
 * `split`: on LivePremier `S1` is the key of `screenList`, and on a Midra the
 * same identifier means screen 1 of `screenList` keyed plain `1`. Asking the
 * dialect rather than spelling either is the whole point of `core/dialect.js`.
 */
function labelPath(dialect, id) {
  const [listName, key] = dialect.split ? dialect.split(id) : [dialect.listNameFor(id), id];
  return ['device', listName, 'items', key, 'control', 'pp', 'label'];
}

export const portFor = (model) =>
  (CONSOLE_MODELS.find((m) => m.id === model) || CONSOLE_MODELS[0]).port;
