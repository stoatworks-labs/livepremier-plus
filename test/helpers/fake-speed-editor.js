/*
 * A Speed Editor as node-hid presents one, for the device host's tests.
 *
 * It runs the real handshake: it issues a challenge, checks the answer with
 * the vendored `authResponse`, and says nothing until it has been answered,
 * as the hardware does. It also refuses a feature read at any length but the
 * report's own, which is what the real panel does on macOS and why WebHID
 * could never read the challenge (`devices/modules/speed-editor/driver.js`).
 */

import { EventEmitter } from 'node:events';
import { authResponse, VENDOR_ID, PRODUCT_ID } from '../../src/vendor/surface/hid/speed-editor.js';
import { createHostCore } from '../../devices/core.js';

export class FakePanel extends EventEmitter {
  constructor({ refuse = false, pressOnAuth = null } = {}) {
    super();
    this.challenge = 0x0123456789abcdefn;
    this.step = null;
    this.authed = false;
    this.refuse = refuse;
    this.pressOnAuth = pressOnAuth;
    this.reads = [];
    this.written = [];
    this.closed = false;
  }
  async sendFeatureReport(data) {
    if (data[0] !== 6) throw new Error(`feature report ${data[0]} is not the handshake`);
    this.step = data[1];
    if (this.step === 3) {
      let v = 0n;
      for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(data[2 + i]);
      this.authed = !this.refuse && v === authResponse(this.challenge);
      if (this.authed && this.pressOnAuth) setTimeout(() => { this.press(this.pressOnAuth); this.press(); }, 30);
    }
    return data.length;
  }
  async getFeatureReport(id, length) {
    this.reads.push([id, length]);
    /* The real panel on macOS: IOHIDDeviceGetReport 0xE0005000 at any other length. */
    if (id !== 6 || length !== 10) throw new Error('IOHIDDeviceGetReport failed: (0xE0005000)');
    const out = Buffer.alloc(10);
    out[0] = 6;
    if (this.step === 0) {
      for (let i = 0; i < 8; i++) out[2 + i] = Number((this.challenge >> BigInt(8 * i)) & 0xffn);
    } else if (this.step === 1) {
      out[1] = 2;
    } else if (this.step === 3) {
      out[1] = this.authed ? 4 : 0;
      out[2] = 0x58; out[3] = 0x02;                   // 600 s
    }
    return out;
  }
  async write(data) { this.written.push([...data]); return data.length; }
  async close() { this.closed = true; }
  /** The panel says something — only once it has been answered. */
  press(...codes) {
    if (!this.authed) return;
    const data = Buffer.alloc(13);
    data[0] = 4;
    codes.forEach((c, i) => { data[1 + 2 * i] = c; });
    this.emit('data', data);
  }
}

/** node-hid's module shape over a list of fake panels. `present` can be swapped to unplug. */
export function fakeHid(panels) {
  const hid = {
    present: [...panels],
    opened: [],
    async devicesAsync() {
      return hid.present.map((p, i) => ({ vendorId: VENDOR_ID, productId: PRODUCT_ID, path: `panel-${i}`, product: 'DaVinci Resolve Speed Editor' }));
    },
    HIDAsync: {
      async open(path, opts) {
        if (opts?.nonExclusive !== true) throw new Error('opened exclusively: the panel must be shared');
        const p = hid.present[Number(path.split('-')[1])];
        hid.opened.push(p);
        return p;
      },
    },
  };
  return hid;
}

/**
 * A stand-in for `child_process.fork` that runs the host's core in this
 * process, over a pretend IPC channel — the supervisor, the core and the
 * driver together, without a process to wait for.
 */
export function inProcessFork({ hid, modules, reason = null }) {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    child.connected = true;
    let core = null;
    child.send = (msg) => { if (child.connected) queueMicrotask(() => core?.handle(msg)); };
    const end = async (signal = null) => {
      if (!child.connected) return;
      child.connected = false;
      await core?.stop();
      child.emit('exit', signal ? null : 0, signal);
    };
    child.disconnect = () => { void end(); };
    child.kill = (signal = 'SIGTERM') => { void end(signal); };
    children.push(child);
    queueMicrotask(() => {
      core = createHostCore({ hid, reason, modules, send: (m) => { if (child.connected) child.emit('message', m); } });
    });
    return child;
  };
  fork.children = children;
  return fork;
}
