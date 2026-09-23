#!/usr/bin/env node
/*
 * How often does the switcher's firmware really rewrite a thumbnail?
 *
 *   node tools/snapshot-probe.mjs --device 192.168.2.140 [--path inputs/1] [--hz 10] [--seconds 30]
 *
 * Asks for one snapshot, straight from the switcher, faster than the Web RCS
 * does, and compares each answer byte for byte with the one before. The
 * intervals between changes are the firmware's refresh rate — the number
 * that decides whether polling faster than the vendor's once a second is
 * worth building. The Thumbnail relay's card can only see changes as fast as
 * the Web RCS asks; this asks as fast as you tell it to.
 *
 * Also reports what the thumbnail is (size, colour type, how compressed),
 * what caching headers the switcher sends, and what the relay's JPEG of it
 * would weigh. Read-only: GETs and one HEAD, nothing written.
 *
 * Point it at a source with a moving picture — a camera, a clock, a test
 * pattern with motion. A still source reports no changes, correctly.
 * `--hz 10` against one input is 5.9 MB/s from a Pulse at 512×512; keep runs
 * short on a show network.
 */

import http from 'node:http';
import { readHeader, decodePng } from '../plugins/snapshot-relay/png.js';
import { encodeJpeg } from '../plugins/snapshot-relay/jpeg.js';
import { DEFAULTS } from '../plugins/snapshot-relay/core.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.device || args.help) {
  console.log('usage: node tools/snapshot-probe.mjs --device <host[:port]> [--path inputs/1] [--hz 10] [--seconds 30] [--json]');
  process.exit(args.help ? 0 : 2);
}
const [host, port = '80'] = String(args.device).split(':');
const path = `/api/device/snapshots/${args.path || 'inputs/1'}`;
const hz = Math.min(25, Math.max(0.5, Number(args.hz) || 10));
const seconds = Math.min(300, Math.max(2, Number(args.seconds) || 30));

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
const COLOUR = { 0: 'grey', 2: 'RGB', 3: 'palette', 4: 'grey+alpha', 6: 'RGBA' };

function get(method = 'GET', headers = {}) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: Number(port), path: `${path}?${Date.now()}`, method, agent, headers, timeout: 5000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: performance.now() - t0 }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const pct = (list, p) => {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const round = (v) => (v == null ? null : Math.round(v));

const first = await get();
if (first.status !== 200) {
  console.error(`${path}: HTTP ${first.status} — ${first.body.toString('utf8').slice(0, 200)}`);
  process.exit(1);
}
const header = readHeader(first.body);
const report = {
  device: args.device,
  path,
  status: first.status,
  bytes: first.body.length,
  png: header && { ...header, colour: COLOUR[header.colorType] },
  /* Bytes the pixels would take raw, per the header: near 1.0 means stored. */
  ratioToRaw: header ? +(first.body.length / (header.width * header.height * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[header.colorType] || 4))).toFixed(3) : null,
  headers: Object.fromEntries(['content-type', 'cache-control', 'etag', 'last-modified', 'content-encoding', 'server']
    .filter((k) => first.headers[k]).map((k) => [k, first.headers[k]]))
};

try {
  const img = decodePng(first.body);
  const jpeg = encodeJpeg(img.data, img.width, img.height, DEFAULTS.quality);
  report.relayJpegBytes = jpeg.length;
} catch (err) {
  report.relayJpegBytes = `not decodable: ${err.message}`;
}

try {
  const head = await get('HEAD');
  report.head = { status: head.status, bytes: head.body.length };
  if (first.headers['last-modified']) {
    const cond = await get('GET', { 'if-modified-since': first.headers['last-modified'] });
    report.ifModifiedSince = { status: cond.status, bytes: cond.body.length };
  }
} catch (err) {
  report.head = `failed: ${err.message}`;
}

console.error(`probing ${host}:${port}${path} at ${hz} Hz for ${seconds} s …`);
const period = 1000 / hz;
const end = Date.now() + seconds * 1000;
let prev = first.body;
let lastChange = null;
const intervals = [];
const latencies = [];
let polls = 0; let changes = 0; let bytes = 0; let failures = 0;
while (Date.now() < end) {
  const began = Date.now();
  try {
    const r = await get();
    polls++;
    bytes += r.body.length;
    latencies.push(r.ms);
    if (r.status === 200 && !r.body.equals(prev)) {
      const t = began + r.ms / 2;
      if (lastChange != null) intervals.push(t - lastChange);
      lastChange = t;
      changes++;
      prev = r.body;
    }
  } catch {
    failures++;
  }
  const wait = period - (Date.now() - began);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
agent.destroy();

const median = pct(intervals, 0.5);
Object.assign(report, {
  hz, seconds, polls, failures, changes,
  achievedHz: +(polls / seconds).toFixed(2),
  throughputMbit: +((bytes * 8) / 1e6 / seconds).toFixed(1),
  latencyMs: { p50: round(pct(latencies, 0.5)), p90: round(pct(latencies, 0.9)), max: round(pct(latencies, 1)) },
  changeIntervalMs: { p10: round(pct(intervals, 0.1)), p50: round(median), p90: round(pct(intervals, 0.9)) },
  firmwareHz: median ? +(1000 / median).toFixed(2) : null,
  verdict: !changes
    ? 'no change seen — is this source moving?'
    : median && median < (1000 / hz) * 1.5
      ? `changes at about the poll rate — the firmware may be faster than ${hz} Hz; try a higher --hz`
      : `the firmware rewrites this thumbnail about every ${round(median)} ms (${(1000 / median).toFixed(1)} Hz)`
});

if (args.json) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`\n${report.path} on ${report.device}`);
  console.log(`  image     ${report.png ? `${report.png.width}×${report.png.height} ${report.png.colour} ${report.png.bitDepth}-bit` : 'not a PNG'}, ${report.bytes} bytes (${report.ratioToRaw}× raw)`);
  console.log(`  as JPEG   ${report.relayJpegBytes} bytes at quality ${DEFAULTS.quality}`);
  console.log(`  headers   ${JSON.stringify(report.headers)}`);
  console.log(`  HEAD      ${JSON.stringify(report.head)}${report.ifModifiedSince ? `   If-Modified-Since → ${JSON.stringify(report.ifModifiedSince)}` : ''}`);
  console.log(`  polled    ${polls} times (${report.achievedHz} Hz achieved, ${failures} failed), ${report.throughputMbit} Mbit/s`);
  console.log(`  latency   p50 ${report.latencyMs.p50} ms, p90 ${report.latencyMs.p90} ms, max ${report.latencyMs.max} ms`);
  console.log(`  changes   ${changes}; interval p10 ${report.changeIntervalMs.p10} / p50 ${report.changeIntervalMs.p50} / p90 ${report.changeIntervalMs.p90} ms`);
  console.log(`  verdict   ${report.verdict}\n`);
}
