/*
 * A placeholder router: the right number of inputs and outputs, and a routing
 * table, with nothing on the other end.
 *
 * This is how a show is patched and routed before the real router is on the
 * network — see `../library.js`. It is **not** an emulator of any protocol:
 * there is no socket, no wire format and nothing to prove. It exists so every
 * surface that routes can be driven against the simulator unchanged.
 *
 * ## The one place a driver writes its own state
 *
 * `driver.js` forbids it, and for a real router that rule is the whole
 * layer. Here there is no router to ask: the placeholder *is* the router, so a
 * crosspoint taken is a crosspoint made, and the grid moves on the click. What
 * it reports is therefore exactly as true as a real router's report — it is
 * just that nobody else can change it.
 *
 * The crosspoints actually taken on it are the **plan** (`planned`): the
 * server saves them into the router's configuration on every change, so they
 * survive a restart, travel in the setup file, and are still there to push
 * once the router goes live. Only what was taken — the factory routing below
 * is not part of it, because pushing it would overwrite every output on the
 * real frame, including the ones the show never touches.
 *
 * ## Factory routing
 *
 * A fresh placeholder routes output N from input N (the last input, past the
 * end), which is how a Videohub and a Lightware MX2 ship. A table with holes
 * in it would draw "nothing" in the Now column for a real router that is never
 * showing nothing.
 */

import { MatrixDriver, emptyState } from './driver.js';

export class PlaceholderDriver extends MatrixDriver {
  static get kind() { return 'placeholder'; }

  /**
   * @param {{id, name?, inputs:number, outputs:number, model?:string,
   *          plan?:Object<number,number>, log?}} options
   */
  constructor(options) {
    super({ host: '', port: 0, ...options });
    this.inputs = options.inputs;
    this.outputs = options.outputs;
    this.model = options.model || `${options.inputs}×${options.outputs}`;
    this.plan = options.plan || null;
    /** `{ output: input }` taken on this placeholder, the plan included. */
    this.planned = {};
  }

  describe() {
    return { ...super.describe(), placeholder: true };
  }

  connect() {
    this.closing = false;
    const state = emptyState();
    state.model = this.model;
    state.name = this.name;
    state.inputs = this.inputs;
    state.outputs = this.outputs;
    this.planned = {};
    for (let out = 1; out <= this.outputs; out++) {
      const planned = Number(this.plan?.[out]);
      if (Number.isInteger(planned) && planned >= 1 && planned <= this.inputs) {
        state.routing[out] = planned;
        this.planned[out] = planned;
      } else {
        state.routing[out] = Math.min(out, this.inputs);
      }
    }
    this.current = state;
    this.lastError = null;
    this.setStatus('connected');
  }

  close() {
    this.closing = true;
    this.setStatus('disconnected');
  }

  /** 1-based, like every driver. Out of range is refused, as a real frame would. */
  route(output, input) {
    if (this.connectionStatus !== 'connected') return false;
    if (!Number.isInteger(output) || output < 1 || output > this.outputs) return false;
    if (!Number.isInteger(input) || input < 1 || input > this.inputs) return false;
    this.planned[output] = input;
    if (this.current.routing[output] !== input) {
      this.current.routing[output] = input;
      this.changed();
    } else {
      /* Nothing moved, but it is now part of the plan — say so, or the
         server never saves a route that happened to match the factory. */
      this.emit('change', this.describe());
    }
    return true;
  }
}
