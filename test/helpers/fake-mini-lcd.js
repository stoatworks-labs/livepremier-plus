/*
 * A stand-in for a U5 mini's LCD app, as far as its key grid goes: the
 * Companion surface on TCP 17100. `StandInConsole` (fake-ucenter.js) starts
 * one when asked for `grid: true`.
 *
 * ⚠️ **A pass against this proves the app agrees with a reading of the
 * firmware. It proves nothing about a console.** What it does is what the
 * LCD app's own code does in firmware V1.0.3, as read from its symbols
 * (`docs/PIXELHUE.md`, U5 mini; pixelhue-bridge's `docs/protocols.md` names
 * the functions) — not what this repo's code does:
 *
 * - **One client.** A LAN client takes the grid from a localhost one and from
 *   another LAN address; a second connection from the address holding it, or
 *   from localhost while a LAN client holds it, is closed at once
 *   (`TcpServer::acceptThread`). Test sockets all come from 127.0.0.1, so each
 *   one is given an address: `lanAddress` on the grid's own port, or the one
 *   `listenAs(address)` was given on the port it returns — so two pretend
 *   machines cannot be told apart by which dialled first.
 *   `builtInCompanion()` is the console's own Companion on localhost, retrying
 *   for ever as Pixelhue's build does.
 * - **A row shows a client's drawing only while switched to Companion** with
 *   its area-switch key (`areaSwitch`); what was drawn for the other rows is
 *   kept until then (`CompanionBiz::setCachedRows`). Other rows are the LCD
 *   app's own, bound to a Pixelhue switcher this does not have: a bus key
 *   there reaches nobody here.
 * - **`page` is the row's page.** A draw for another page moves the row; a
 *   press reports the page the row shows (`updateUIWithRow`, `setKeyOperate`).
 * - **Ten columns:** eight bus keys and the row's page keys. On a Companion row
 *   all ten go to the client; on any other row the page keys report 549 / 550
 *   and the area-switch key 595 to the control service, as a user's mini did.
 *   That the page keys are columns 8 and 9 is inferred, not proved.
 *
 * Its packet reader and writer are written here from the vendor plugin's
 * layout, NOT imported from `src/vendor/pixelhue/surface.js`: the app's codec
 * is checked against a second reading of the format rather than against
 * itself — the trap the WebSocket path fell into. A draw's PNG is checked for
 * a signature and a 72 × 72 header, which is the most the LCD app's
 * "companion pixmap conversion failed" says it checks.
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';

const MAGIC = Buffer.from([0x10, 0x30, 0x50, 0x00]);
const HEAD = 12;
export const ROWS = 4;
export const COLUMNS = 10;
const MODULES = ['screen', 'layer', 'input', 'preset', 'companion'];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const LOCALHOST = new Set(['127.0.0.1', '::1', 'localhost']);

/** One packet, as the vendor plugin and the LCD app frame it. */
function frame(json, { response = false, seq = 1 } = {}) {
  const body = Buffer.from(JSON.stringify(json), 'utf8');
  const out = Buffer.alloc(HEAD + 4 + body.length);
  MAGIC.copy(out, 0);
  out.writeUInt16LE(response ? 1 : 0, 4);
  out.writeUInt16LE(0x0101, 6);
  out.writeUInt16LE(seq & 0xffff, 8);
  out.writeUInt16LE(out.length, 10);
  out.writeUInt16LE(response ? 2 : 1, 12);
  out.writeUInt16LE(body.length, 14);
  body.copy(out, 16);
  return out;
}

/** The size a PNG says it is, or why it is not one. */
function pngSize(buf) {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return { error: 'not a PNG' };
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return { error: 'no IHDR' };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export class StandInLcd extends EventEmitter {
  /**
   * @param {object} o
   * @param {(code:number) => void} [o.report]  a command to the control service's sockets (549, 550, 595)
   */
  constructor({ port = 17100, host = '127.0.0.1', lanAddress = '192.168.0.10', report = () => {} } = {}) {
    super();
    this.port = port;
    this.host = host;
    this.lanAddress = lanAddress;
    this.report = report;
    /* Each row's module, as the console starts: its own bus. */
    this.modules = ['screen', 'layer', 'input', 'preset'];
    this.pages = [1, 1, 1, 1];
    /* `row,column,page` → `{png, width, height}`. */
    this.cache = new Map();
    this.rejected = [];
    this.draws = 0;
    /* `{address, local, socket}` holding the grid, or null. */
    this.current = null;
    this.refused = [];
    this.kicked = [];
    this.sockets = new Set();
    this.extra = [];
    this.builtIn = null;
    this.seq = 1;
  }

  async start() {
    this.server = net.createServer((socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  /** A port whose connections the console sees as coming from `address`. */
  async listenAs(address) {
    const server = net.createServer((socket) => this.#accept(socket, address));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.extra.push(server);
    return server.address().port;
  }

  async stop() {
    if (this.builtIn) this.builtIn.stop();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    for (const server of [this.server, ...this.extra]) {
      if (server) await new Promise((resolve) => server.close(() => resolve()));
    }
  }

  /* ----------------------------------------------------------- the slot */

  #accept(socket, address = null) {
    const from = address || this.lanAddress;
    const local = LOCALHOST.has(from);
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
      if (this.current && this.current.socket === socket) this.current = null;
    });
    socket.on('error', () => {});
    const cur = this.current;
    const refuse = (why) => { this.refused.push({ address: from, why }); socket.end(); };
    if (cur) {
      if (local) return refuse(cur.local ? 'localhost already holds the grid' : 'a LAN client holds the grid');
      if (!cur.local && cur.address === from) return refuse('that address already holds the grid');
      this.kicked.push({ address: cur.address, by: from });
      cur.socket.end();
    }
    this.current = { address: from, local, socket };
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      buf = this.#read(socket, buf);
    });
    this.emit('client', { address: from, local });
  }

  /** Packets and pings out of a client's bytes; what is left over. */
  #read(socket, buf) {
    for (;;) {
      if (buf.length >= 4 && buf.subarray(0, 4).toString('ascii') === 'ping') {
        socket.write('pong');
        buf = buf.subarray(4);
        continue;
      }
      const at = buf.indexOf(MAGIC);
      if (at < 0) return buf.length > 3 ? buf.subarray(buf.length - 3) : buf;
      if (at > 0) buf = buf.subarray(at);
      if (buf.length < HEAD) return buf;
      const total = buf.readUInt16LE(10);
      if (buf.length < total) return buf;
      const len = buf.readUInt16LE(14);
      let body = null;
      try { body = JSON.parse(buf.subarray(16, 16 + len).toString('utf8')); } catch { /* dropped, as the LCD logs and drops */ }
      const seq = buf.readUInt16LE(8);
      buf = buf.subarray(total);
      if (socket === (this.current && this.current.socket)) this.#request(socket, body, seq);
    }
  }

  #request(socket, body, seq) {
    for (const d of Array.isArray(body) ? body : [body]) {
      if (!d || typeof d !== 'object' || typeof d.data !== 'string') continue;
      const { page, row, column } = d;
      if (!Number.isInteger(page) || !Number.isInteger(row) || !Number.isInteger(column)
        || row < 0 || row >= ROWS || column < 0 || column >= COLUMNS) {
        this.rejected.push({ d: { page, row, column }, why: 'page, row or column out of range' });
        continue;
      }
      const m = /^base64,(.*)$/s.exec(d.data);
      const png = m ? Buffer.from(m[1], 'base64') : Buffer.alloc(0);
      const size = pngSize(png);
      if (size.error || size.width !== 72 || size.height !== 72) {
        this.rejected.push({ d: { page, row, column }, why: size.error || `${size.width}×${size.height}, not 72×72` });
        continue;
      }
      this.cache.set(`${row},${column},${page}`, { png, ...size });
      this.pages[row] = page;
      this.draws++;
      this.emit('draw', { row, column, page });
    }
    socket.write(frame({ code: 0 }, { response: true, seq }));
  }

  /* ----------------------------------------------------- what hands do */

  /** The row's area-switch key: its module moves on, and the control service hears 595. */
  areaSwitch(row) {
    this.modules[row] = MODULES[(MODULES.indexOf(this.modules[row]) + 1) % MODULES.length];
    this.report(595);
    return this.modules[row];
  }

  /** Switch a row round to Companion, as an operator would. */
  toCompanion(row) {
    while (this.modules[row] !== 'companion') this.areaSwitch(row);
  }

  /** What a key shows: the client's drawing on a Companion row, null on the LCD app's own. */
  shown(row, column) {
    if (this.modules[row] !== 'companion') return null;
    return this.cache.get(`${row},${column},${this.pages[row]}`) || null;
  }

  /** A thumb on a grid key, held `hold` ms. */
  async press(row, column, hold = 60) {
    const send = (type) => {
      const c = this.current;
      if (c) c.socket.write(frame({ page: this.pages[row], row, column, type }, { seq: this.seq++ }));
    };
    if (this.modules[row] === 'companion') {
      send(0);
      await new Promise((r) => setTimeout(r, hold));
      send(1);
      return;
    }
    await new Promise((r) => setTimeout(r, hold));
    if (column === 8) this.report(549);
    if (column === 9) this.report(550);
  }

  /**
   * The console's own Companion, connecting from localhost and retrying for
   * ever when dropped or refused, as Pixelhue's build does. `retryMs` is far
   * shorter than its real 5–60 s, so a test sees several tries.
   */
  async builtInCompanion({ retryMs = 40 } = {}) {
    const port = await this.listenAs('127.0.0.1');
    let stopped = false;
    let socket = null;
    const state = { connected: false, attempts: 0, refusedOrKicked: 0 };
    const dial = () => {
      if (stopped) return;
      state.attempts++;
      socket = net.createConnection({ host: '127.0.0.1', port });
      socket.on('connect', () => { state.connected = true; });
      socket.on('data', () => {});
      socket.on('end', () => { state.refusedOrKicked++; });
      socket.on('error', () => {});
      socket.on('close', () => {
        state.connected = false;
        if (!stopped) setTimeout(dial, retryMs);
      });
    };
    dial();
    this.builtIn = { state, stop: () => { stopped = true; socket?.destroy(); } };
    return this.builtIn;
  }
}
