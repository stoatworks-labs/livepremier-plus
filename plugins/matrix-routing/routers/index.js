/*
 * The matrix supervisor: one driver per configured router, kept connected.
 *
 * ## Why this holds connections open when `awj.js` deliberately does not
 *
 * `server/awj.js` opens a socket per exchange and argues at length that it
 * must never hold one or subscribe to anything. That argument is about the
 * **store mirror** — about not becoming a second source of truth for state the
 * vendor socket already carries. None of it applies here, and the reason is
 * that an external router is not in the store at all:
 *
 * - **There is no other source.** Nothing else in this process, or in the Web
 *   RCS page, knows what a Videohub is routing. There is no mirror to
 *   contradict, because a switcher's store has never heard of the router in
 *   front of it.
 * - **The crosspoints change without us.** Somebody at a router panel, a
 *   Companion button, another operator — a poll-on-demand design would show a
 *   grid that was right when the panel was opened, which is worse than no
 *   grid.
 * - **The client budget is the switcher's, not the router's.** The five-client
 *   limit `awj.js` respects is an AWJ limit on the Analog Way frame. A
 *   Videohub is happy with many clients and says so in its own protocol.
 *
 * What this does share with `awj.js` is the rule it inherits from
 * `plugins/matrix-routing/routers/driver.js`: it never writes state it has not been told.
 *
 * ## Lifecycle
 *
 * Matrices are installation-level, like the OSC listener — they survive the
 * switcher being re-pointed, because the router in the rack does not move when
 * you fail over to a backup frame. `apply()` is therefore idempotent and
 * diff-based: a matrix whose settings did not change keeps its socket, and
 * only what actually changed is torn down. Reconnecting every router because
 * somebody renamed one would drop a live grid for no reason.
 */

import { EventEmitter } from 'node:events';
import { VideohubDriver } from './videohub.js';
import { LightwareDriver } from './lightware.js';
import { TurtleDriver } from './turtle.js';

const DRIVERS = {
  videohub: VideohubDriver,
  lightware: LightwareDriver,
  turtle: TurtleDriver,
};

/** What makes two configurations the same socket. A rename is not a reconnect. */
const identity = (m) => `${m.kind}:${m.host}:${m.port}:${m.protocol ?? ''}`;

export class MatrixSupervisor extends EventEmitter {
  constructor({ log = () => {} } = {}) {
    super();
    this.log = log;
    /** @type {Map<string, {config: object, driver: object|null}>} */
    this.entries = new Map();
  }

  /**
   * Bring the running drivers into line with a configuration list.
   *
   * @param {Array<{id,kind,name,host,port,enabled}>} matrices  already normalised
   */
  apply(matrices) {
    const wanted = new Map(matrices.map((m) => [m.id, m]));

    /* Gone, or newly disabled: stop and forget. */
    for (const [id, entry] of [...this.entries]) {
      const next = wanted.get(id);
      if (!next || !next.enabled) {
        entry.driver?.close();
        this.entries.delete(id);
        this.log(`matrix ${id} stopped`);
      }
    }

    for (const config of matrices) {
      if (!config.enabled) continue;
      const existing = this.entries.get(config.id);

      if (existing && identity(existing.config) === identity(config)) {
        /* Same socket, possibly a new display name. Update in place; do not
           disturb a connection that is working. */
        existing.config = config;
        if (existing.driver) existing.driver.name = config.name;
        continue;
      }
      existing?.driver?.close();

      const driver = this.createDriver(config);
      if (!driver) {
        this.log(`matrix ${config.id}: no driver for kind "${config.kind}"`);
        continue;
      }
      driver.on('change', () => this.emit('change', this.describe()));
      this.entries.set(config.id, { config, driver });
      driver.connect();
      this.log(`matrix ${config.id} (${config.kind}) connecting to ${config.host}:${config.port}`);
    }

    this.emit('change', this.describe());
  }

  /**
   * Build the driver for one configuration, or null if there is no such kind.
   *
   * A seam, and the only one: a test that wants to exercise `apply`'s
   * bookkeeping must not open sockets to addresses that do not exist, and
   * reaching into a private field to prevent that is how a test ends up
   * pinning an implementation detail instead of a behaviour.
   */
  createDriver(config) {
    const Driver = DRIVERS[config.kind];
    if (!Driver) return null;
    return new Driver({
      id: config.id,
      name: config.name,
      host: config.host,
      port: config.port,
      protocol: config.protocol,
      log: this.log,
    });
  }

  /** Every configured matrix, connected or not, in configuration order. */
  describe() {
    return [...this.entries.values()].map(({ config, driver }) =>
      driver ? driver.describe() : { ...config, status: 'disconnected', state: null });
  }

  /** Port counts per matrix, in the shape `core/patch.js` validate() wants. */
  sizes() {
    const out = {};
    for (const [id, { driver }] of this.entries) {
      const state = driver?.state;
      if (state) out[id] = { inputs: state.inputs, outputs: state.outputs };
    }
    return out;
  }

  /** Routing tables per matrix, in the shape `core/patch.js` currentFor() wants. */
  routing() {
    const out = {};
    for (const [id, { driver }] of this.entries) {
      const state = driver?.state;
      if (state) out[id] = state.routing;
    }
    return out;
  }

  get(id) { return this.entries.get(id)?.driver ?? null; }

  /**
   * Take a set of crosspoints, as `core/patch.js` groups them.
   *
   * Reports per group what reached the wire — never what the router did with
   * it, which arrives later as state. A matrix that is absent or disconnected
   * is a failure with a reason rather than a silent no-op: a cue that fires
   * into a dead router must say so.
   *
   * @param {Array<{matrix:string, routes:Array<{output:number,input:number}>}>} groups
   */
  route(groups) {
    const results = [];
    for (const group of groups) {
      const driver = this.get(group.matrix);
      if (!driver) {
        results.push({ matrix: group.matrix, ok: false, error: 'no such matrix', sent: 0 });
        continue;
      }
      if (driver.status !== 'connected') {
        results.push({
          matrix: group.matrix,
          ok: false,
          error: `${driver.name} is ${driver.status}`,
          sent: 0,
        });
        continue;
      }
      let sent = 0;
      const refused = [];
      for (const { output, input } of group.routes) {
        if (driver.route(output, input)) sent++;
        else refused.push(output);
      }
      results.push({
        matrix: group.matrix,
        ok: refused.length === 0,
        sent,
        ...(refused.length ? { error: `driver refused output ${refused.join(', ')}` } : {}),
      });
    }
    return results;
  }

  stop() {
    for (const { driver } of this.entries.values()) driver?.close();
    this.entries.clear();
  }
}

export { VideohubDriver, LightwareDriver, TurtleDriver };
