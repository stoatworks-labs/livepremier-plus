#!/usr/bin/env node
/*
 * A HyperDeck on this machine: the HyperDeck Ethernet Protocol answered over
 * TCP, with a clip list that plays in real time.
 *
 *   node tools/hyperdeck-sim.mjs                     a HyperDeck on 9993
 *   node tools/hyperdeck-sim.mjs --port 9994 --mitti  Mitti's emulation: no record
 *   … --host 0.0.0.0                                  reachable from other machines
 *
 * What the HyperDecks plugin's tests run against, and what to point the panel
 * at without a deck in the room. It is an emulation of the published protocol,
 * not of any one firmware — the same standing the Videohub emulation had in
 * BlackMatrix. It is not proof that a real deck agrees.
 *
 * Behaviour worth knowing: a clip played with `single clip: true` stops on its
 * last frame, the way a deck (and Mitti at a cue's end) does; without it,
 * playback runs on into the next clip and stops at the end of the last.
 */

import net from 'node:net';
import { fileURLToPath } from 'node:url';

const FPS = 25;
const FORMAT = '1080p25';

const tc = (seconds) => {
  const total = Math.max(0, Math.round(seconds * FPS));
  const f = total % FPS;
  const s = Math.floor(total / FPS);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f)}`;
};

/**
 * @param {{port?:number, host?:string, mitti?:boolean,
 *          clips?:Array<{name:string, seconds:number}>, model?:string}} [options]
 * @returns {Promise<{port:number, close:()=>Promise<void>, state:object, clients:Set}>}
 */
export async function startHyperDeckSim(options = {}) {
  const mitti = !!options.mitti;
  const state = {
    clips: (options.clips || [
      { name: 'Opener.mov', seconds: 8 },
      { name: 'Walk-in loop.mov', seconds: 30 },
      { name: 'Sponsor reel.mov', seconds: 12 },
    ]).map((c, i) => ({ id: i + 1, ...c })),
    status: 'stopped',
    clip: 1,
    single: false,
    loop: false,
    /* Seconds into the whole timeline. */
    at: 0,
    remote: true,
    recording: null,
  };
  const startOf = (id) => state.clips.filter((c) => c.id < id).reduce((t, c) => t + c.seconds, 0);
  const clipAt = (t) => {
    let start = 0;
    for (const c of state.clips) { if (t < start + c.seconds) return c.id; start += c.seconds; }
    return state.clips.length ? state.clips[state.clips.length - 1].id : 1;
  };
  const clients = new Set();
  const push = (block) => { for (const c of clients) if (c.notify) c.socket.write(block); };

  const transportBlock = (code) => [
    `${code} transport info:`,
    `status: ${state.status}`,
    `speed: ${state.status === 'play' ? 100 : 0}`,
    'slot id: 1',
    `clip id: ${state.clip}`,
    `single clip: ${state.single}`,
    `display timecode: ${tc(state.at)}`,
    `timecode: ${tc(state.at)}`,
    `video format: ${FORMAT}`,
    `loop: ${state.loop}`,
    '', ''].join('\r\n');

  const set = (patch) => {
    const before = `${state.status}/${state.clip}`;
    Object.assign(state, patch);
    if (`${state.status}/${state.clip}` !== before) push(transportBlock(508));
  };

  /* The clock: a tenth of a second at a time, which is finer than any client polls. */
  let last = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    const dt = (now - last) / 1000;
    last = now;
    if (state.status !== 'play') return;
    const clip = state.clips.find((c) => c.id === state.clip);
    if (!clip) return;
    const end = startOf(clip.id) + clip.seconds;
    let at = state.at + dt;
    if (at >= end - 1 / FPS) {
      const lastClip = clip.id === state.clips[state.clips.length - 1].id;
      if (state.loop) { at = state.single ? startOf(clip.id) : (lastClip ? 0 : at); }
      else if (state.single || lastClip) { set({ at: end - 1 / FPS, status: 'stopped' }); return; }
    }
    set({ at, clip: clipAt(at) });
  }, 20);

  const server = net.createServer((socket) => {
    const client = { socket, notify: false };
    clients.add(client);
    socket.setEncoding('utf8');
    socket.write(`500 connection info:\r\nprotocol version: 1.11\r\nmodel: ${options.model || (mitti ? 'Mitti' : 'HyperDeck Studio HD Plus')}\r\n\r\n`);
    let buffer = '';
    socket.on('data', (text) => {
      buffer += text;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, '').trim();
        buffer = buffer.slice(i + 1);
        if (line) socket.write(answer(line, client));
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  function answer(line, client) {
    const [head, ...restParts] = line.split(':');
    const cmd = head.trim().toLowerCase();
    const rest = restParts.join(':');
    const arg = (name) => {
      const m = new RegExp(`${name}:\\s*([^:]+?)(?=\\s+[a-z ]+:|$)`, 'i').exec(rest.trim() ? `${rest.trim()}` : '');
      return m ? m[1].trim() : null;
    };
    const guarded = () => (state.remote ? null : '111 remote control disabled\r\n');
    switch (cmd) {
      case 'ping': return '200 ok\r\n';
      case 'device info': return `204 device info:\r\nprotocol version: 1.11\r\nmodel: ${mitti ? 'Mitti' : 'HyperDeck Studio HD Plus'}\r\nslot count: 2\r\nsoftware version: 8.0\r\n\r\n`;
      case 'transport info': return transportBlock(208);
      case 'slot info': return '202 slot info:\r\nslot id: 1\r\nstatus: mounted\r\nvolume name: SSD1\r\nrecording time: 7200\r\nvideo format: 1080p25\r\n\r\n';
      case 'clips count': return `214 clips count:\r\nclip count: ${state.clips.length}\r\n\r\n`;
      case 'clips get': return [`205 clips info:`, `clip count: ${state.clips.length}`,
        ...state.clips.map((c) => `${c.id}: ${c.name} ${tc(startOf(c.id))} ${tc(c.seconds)}`), '', ''].join('\r\n');
      case 'notify': client.notify = /transport:\s*true/i.test(rest); return '200 ok\r\n';
      case 'remote': state.remote = /enable:\s*true/i.test(rest); return '200 ok\r\n';
      case 'play': {
        const g = guarded(); if (g) return g;
        if (arg('single clip')) state.single = arg('single clip') === 'true';
        if (arg('loop')) state.loop = arg('loop') === 'true';
        set({ status: 'play' });
        return '200 ok\r\n';
      }
      case 'stop': {
        const g = guarded(); if (g) return g;
        if (state.status === 'record' && state.recording) {
          const seconds = Math.max(1, Math.round((Date.now() - state.recording.since) / 1000));
          state.clips.push({ id: state.clips.length + 1, name: state.recording.name, seconds });
          state.recording = null;
        }
        set({ status: 'stopped' });
        return '200 ok\r\n';
      }
      case 'record': {
        if (mitti) return '100 syntax error\r\n';
        const g = guarded(); if (g) return g;
        state.recording = { name: `${arg('name') || `Capture ${state.clips.length + 1}`}.mov`, since: Date.now() };
        set({ status: 'record' });
        return '200 ok\r\n';
      }
      case 'preview': {
        if (mitti) return '100 syntax error\r\n';
        set({ status: /enable:\s*true/i.test(rest) ? 'preview' : 'stopped' });
        return '200 ok\r\n';
      }
      case 'goto': {
        const g = guarded(); if (g) return g;
        const id = arg('clip id');
        const where = arg('clip');
        let target = state.clip;
        if (id != null) target = /^[+-]/.test(id) ? state.clip + Number(id) : Number(id);
        if (!Number.isInteger(target) || target < 1 || target > state.clips.length) return '109 out of range\r\n';
        const clip = state.clips.find((c) => c.id === target);
        const at = where === 'end' ? startOf(target) + clip.seconds - 1 / FPS : startOf(target);
        set({ clip: target, at });
        return '200 ok\r\n';
      }
      default: return '100 syntax error\r\n';
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 9993, options.host ?? '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    state,
    clients,
    close: () => new Promise((resolve) => {
      clearInterval(ticker);
      for (const c of clients) c.socket.destroy();
      server.close(() => resolve());
    }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = Number(args[args.indexOf('--port') + 1]) || 9993;
  /* Loopback unless told otherwise: an emulated deck on the LAN is one a real switcher could find. */
  const host = args.includes('--host') ? args[args.indexOf('--host') + 1] : '127.0.0.1';
  const sim = await startHyperDeckSim({ port, host, mitti: args.includes('--mitti') });
  console.log(`HyperDeck${args.includes('--mitti') ? ' (Mitti mode)' : ''} emulation on :${sim.port}`);
}
