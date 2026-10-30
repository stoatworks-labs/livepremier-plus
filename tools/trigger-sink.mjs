#!/usr/bin/env node
/*
 * A pretend receiver for Triggers: prints what arrives, so a show's triggers
 * can be watched without a desk or a node on the bench.
 *
 *   node tools/trigger-sink.mjs [--osc 9000] [--artnet 6454] [--sacn 5568] [--midi 51326] [--bind 127.0.0.1]
 *
 * Each listener is opt-in. Point a destination at this machine and the port:
 * OSC messages print decoded, MIDI over TCP prints as hex, and a DMX universe
 * prints the channels that changed (Art-Net and sACN refresh every second;
 * an unchanged refresh prints nothing). sACN is unicast here — give the
 * destination this machine's address rather than leaving it on multicast.
 *
 * It binds to loopback unless told otherwise. Do not bind it on a show
 * network's Art-Net port beside a real node: it would only listen, but
 * a second thing answering on 6454 is a thing to explain to somebody.
 */

import dgram from 'node:dgram';
import net from 'node:net';
import { decode } from '../server/osc.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? Number(args[i + 1]) : null; };
const bind = (() => { const i = args.indexOf('--bind'); return i >= 0 ? args[i + 1] : '127.0.0.1'; })();
const stamp = () => new Date().toISOString().slice(11, 23);
const say = (what, text) => process.stdout.write(`${stamp()}  ${what.padEnd(7)} ${text}\n`);

function udp(port, what, onMessage) {
  const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  s.on('message', (buf, from) => { try { onMessage(buf, from); } catch (err) { say(what, `unreadable from ${from.address}: ${err.message}`); } });
  s.on('error', (err) => say(what, `could not listen on ${port}: ${err.message}`));
  s.bind(port, bind, () => say(what, `listening on ${bind}:${s.address().port}`));
}

const universes = new Map();
function dmx(what, key, data) {
  const before = universes.get(key) || new Uint8Array(512);
  const changed = [];
  for (let i = 0; i < 512; i++) if (data[i] !== before[i]) changed.push(`${i + 1}=${data[i]}`);
  universes.set(key, Uint8Array.from(data));
  if (changed.length) say(what, `${key}: ${changed.length > 24 ? `${changed.slice(0, 24).join(' ')} … (${changed.length})` : changed.join(' ')}`);
}

if (opt('osc')) {
  udp(opt('osc'), 'OSC', (buf) => {
    for (const m of decode(buf)) say('OSC', `${m.address} ${m.args.map((a) => JSON.stringify(a)).join(' ')}`.trim());
  });
}
if (opt('artnet')) {
  udp(opt('artnet'), 'Art-Net', (buf) => {
    if (buf.toString('latin1', 0, 8) !== 'Art-Net\0' || buf.readUInt16LE(8) !== 0x5000) return;
    const universe = buf[14] | (buf[15] << 8);
    dmx('Art-Net', `${universe >> 8}:${(universe >> 4) & 15}:${universe & 15}`, buf.subarray(18, 18 + buf.readUInt16BE(16)));
  });
}
if (opt('sacn')) {
  udp(opt('sacn'), 'sACN', (buf) => {
    if (buf.length < 126 || buf.toString('latin1', 4, 13) !== 'ASC-E1.17') return;
    const universe = buf.readUInt16BE(113);
    if (buf[112] & 0x40) { say('sACN', `${universe}: stream terminated (priority ${buf[108]})`); universes.delete(`u${universe}`); return; }
    dmx('sACN', `u${universe}`, buf.subarray(126, 638));
  });
}
if (opt('midi')) {
  const server = net.createServer((socket) => {
    say('MIDI', `connection from ${socket.remoteAddress}`);
    socket.on('data', (d) => say('MIDI', d.toString('hex').toUpperCase().replace(/(..)/g, '$1 ').trim()));
    socket.on('close', () => say('MIDI', 'connection closed'));
  });
  server.listen(opt('midi'), bind, () => say('MIDI', `listening on ${bind}:${server.address().port}`));
}
if (!['osc', 'artnet', 'sacn', 'midi'].some(opt)) {
  process.stderr.write('usage: node tools/trigger-sink.mjs [--osc 9000] [--artnet 6454] [--sacn 5568] [--midi 51326] [--bind 127.0.0.1]\n');
  process.exit(2);
}
