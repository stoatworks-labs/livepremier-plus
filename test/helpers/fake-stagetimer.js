/*
 * A stand-in for api.stagetimer.io, on 127.0.0.1: the HTTP API v1 envelope
 * (`{ ok, message, data }`, a Bearer key) and the Socket.IO v4 feed at
 * `/v1/socket.io/` over a plain WebSocket, as bdstage's notes describe it and
 * as the real server answered a made-up room on 2026-11-10. Event payloads
 * are the documented ones — no real room's have been seen.
 *
 *   const st = new FakeStagetimer({ roomId: 'R', apiKey: 'K' });
 *   await st.listen();            // st.base = 'http://127.0.0.1:<port>'
 *   st.emit('playback_status', { … });
 *   await st.close();
 */

import http from 'node:http';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x81, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([head, payload]);
}

/** Masked client frames out of a buffer: `{ messages, rest }`. Text and close only. */
function readFrames(buf) {
  const messages = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) { if (buf.length - p < 2) break; len = buf.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (buf.length - p < 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
    const masked = (b1 & 0x80) !== 0;
    if (buf.length - p < (masked ? 4 : 0) + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : null;
    if (masked) p += 4;
    const data = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
    const op = b0 & 0x0f;
    if (op === 0x1) messages.push({ op: 'text', text: data.toString('utf8'), masked });
    else if (op === 0x8) messages.push({ op: 'close', masked });
    off = p + len;
  }
  return { messages, rest: buf.subarray(off) };
}

export class FakeStagetimer {
  constructor({ roomId = 'ROOM', apiKey = 'KEY', timers = [], status = null, room = { _id: 'ROOM', name: 'Main hall', timezone: 'Europe/London' } } = {}) {
    this.roomId = roomId;
    this.apiKey = apiKey;
    this.timers = timers;
    this.status = status;
    this.room = room;
    this.requests = [];
    this.connects = [];
    this.sockets = new Set();
    this.unmasked = 0;
    this.socketOff = false;
    this.server = http.createServer((req, res) => this.#http(req, res));
    this.server.on('upgrade', (req, socket) => this.#upgrade(req, socket));
  }

  listen() {
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      this.base = `http://127.0.0.1:${this.server.address().port}`;
      resolve(this);
    }));
  }

  close() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  /** An EVENT to every connected socket. */
  emit(name, data) {
    const line = textFrame(`42${JSON.stringify([name, data])}`);
    for (const s of this.sockets) if (s.connected) s.write(line);
  }

  /** Drop every socket, as a venue network would. */
  drop() { for (const s of this.sockets) s.destroy(); }

  #authorised(roomId, key) { return roomId === this.roomId && key === this.apiKey; }

  #http(req, res) {
    const url = new URL(req.url, 'http://stand-in');
    this.requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null });
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', date: new Date().toUTCString() });
      res.end(JSON.stringify(body));
    };
    const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!/^Bearer /.test(String(req.headers.authorization || ''))) return send(400, { ok: false, message: 'authorization: Not a valid Bearer token' });
    if (!this.#authorised(url.searchParams.get('room_id'), key)) return send(401, { ok: false, message: 'Access Denied' });
    const endpoint = url.pathname.replace(/^\/v1\//, '');
    if (endpoint === 'test_auth') return send(200, { ok: true, message: 'Authorized', data: null });
    if (endpoint === 'get_status') return send(200, { ok: true, data: { ...this.status, server_time: Date.now() } });
    if (endpoint === 'get_all_timers') return send(200, { ok: true, data: this.timers });
    if (endpoint === 'get_room') return send(200, { ok: true, data: this.room });
    return send(404, { ok: false, message: 'Not found' });
  }

  #upgrade(req, socket) {
    const url = new URL(req.url, 'http://stand-in');
    if (this.socketOff || url.pathname !== '/v1/socket.io/' || url.searchParams.get('EIO') !== '4' || url.searchParams.get('transport') !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    this.sockets.add(socket);
    socket.connected = false;
    socket.write(textFrame(`0${JSON.stringify({ sid: 'sid1', upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000 })}`));
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { messages, rest } = readFrames(buf);
      buf = rest;
      for (const m of messages) {
        if (!m.masked) this.unmasked += 1;
        if (m.op !== 'text') continue;
        if (m.text.startsWith('40')) {
          let auth = {};
          try { auth = JSON.parse(m.text.slice(2) || '{}'); } catch { /* bad */ }
          this.connects.push(auth);
          if (!this.#authorised(auth.room_id, auth.api_key)) {
            socket.write(textFrame(`44${JSON.stringify({ message: auth.room_id === this.roomId ? 'Access Denied: Invalid API key' : 'Access Denied: Room not found' })}`));
            continue;
          }
          socket.connected = true;
          socket.write(textFrame(`40${JSON.stringify({ sid: 'sock1' })}`));
          /* The state on connect, as Stagetimer sends it. */
          if (this.room) socket.write(textFrame(`42${JSON.stringify(['room', this.room])}`));
          if (this.status) socket.write(textFrame(`42${JSON.stringify(['playback_status', { ...this.status, server_time: Date.now() }])}`));
          const cur = this.status && this.timers.find((t) => t._id === this.status.timer_id);
          if (cur) socket.write(textFrame(`42${JSON.stringify(['current_timer', cur])}`));
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => this.sockets.delete(socket));
  }
}
