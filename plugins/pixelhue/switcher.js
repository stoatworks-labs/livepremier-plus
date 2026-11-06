/*
 * This app as the Pixelhue switcher a U5 mini is bound to.  ** PREVIEW **
 *
 * ## Why a console needs a switcher to take
 *
 * A U5 mini's TAKE and CUT never reach this app (`core.js`, `takeCutNote`). Its
 * LCD app runs them itself, against the Pixelhue switcher the mini is bound
 * to: a PUT to that switcher's `/unico/v1/screen/take` or `screen/cut`, for the
 * screens selected on the console's own SCREEN row. So for the console's own
 * keys to drive a LivePremier, this app has to be that switcher. It answers
 * the mini's discovery, its login and the handful of reads its TAKE needs, and
 * turns the two writes into the take and cut every other console here makes.
 *
 * What a mini asks a switcher for, and what it makes of the answers, was
 * watched with the mini's own firmware (V1.0.3) bound to a stand-in. Nothing
 * here has met a real mini yet. `docs/PIXELHUE.md` keeps what is known.
 *
 * - **Port 19999 is fixed.** The LCD app logs in to its bound switcher on
 *   19999 whatever the switcher advertises. nvcontroller, the mini's control
 *   service, opens the WebSocket on the advertised port, which is 19999 too.
 * - **The WebSocket wants pings.** nvcontroller sends nothing on it and drops
 *   it after 4 s of silence. WebSocket ping frames hold it; the vendor's own
 *   keep-alive frames do not count.
 * - **TAKE needs `screen/list-thumb`.** Without the screen brief list, the
 *   console draws the screens but has none selected to take, and its TAKE
 *   does nothing.
 * - **A refused take shows the operator nothing.** The LCD logs it and moves
 *   on, so whatever refuses one has to say so on this app's card.
 *
 * ## No I/O
 *
 * Same rule as `core.js`: this decides what each request is answered with and
 * what a take means. `switcher-server.js` moves the bytes, and the tests drive
 * this directly.
 */

import { randomBytes } from 'node:crypto';

import { crc16x25 } from '../../src/vendor/pixelhue/crc16.js';
import { MAGIC, FRAME_HEAD, TLV_HEAD } from '../../src/vendor/pixelhue/apollo.js';

/** The LCD app's fixed switcher port, and nvcontroller's discovery port. */
export const SWITCHER_PORT = 19999;
export const DISCOVERY_PORT = 5600;
/** The TLV code of a discovery search and of its answer. */
export const DISCOVERY_CODE = 0x00010001;

/**
 * Who this app says it is: a Pixelhue P10 (Unico's model 28945) on firmware
 * V1.9.0, the identity the stand-in was bound as. The name is what the
 * console's header shows, beside the address it logged in to.
 */
export const IDENTITY = Object.freeze({ modelId: 28945, version: 'V1.9.0', name: 'LivePremier Plus' });

const API = '/unico/v1/';

/* ------------------------------------------------------------- identity */

/** A serial for this app, made once and kept: 'LPP' and nine digits, twelve characters like a mini's own. */
export function newSerial(random = randomBytes) {
  const digits = [...random(9)].map((b) => String(b % 10)).join('');
  return `LPP${digits}`;
}

/** A login token, made once and kept, so a console still holding it after this app restarts is not refused. */
export const newToken = (random = randomBytes) => random(16).toString('hex');

/** A locally administered MAC for the serial: `node/ethernet` must list one, and it must not change. */
export function macFor(serial) {
  const n = [...String(serial)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const bytes = [0x02, 0x4c, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(':');
}

/* -------------------------------------------------------------- screens */

/**
 * The screens a console is offered: the switcher's screens in use, by
 * number. `S3` is the console's screen 3, so a take names the same screen on
 * both sides. Auxes are left out: the console's SCREEN row is for screens.
 *
 * @param {object|null} facts  `ConsoleSwitcher.readFacts()`'s, or null when the switcher has not been read
 * @returns {Array<{n:number, id:string, label:string}>}
 */
export function screensFrom(facts) {
  const out = [];
  for (const d of (facts && facts.destinations) || []) {
    const m = /^S(\d+)$/.exec(String(d.id));
    if (!m || !d.isUsed) continue;
    out.push({ n: Number(m[1]), id: d.id, label: String(d.label || `Screen ${m[1]}`) });
  }
  return out.sort((a, b) => a.n - b.n);
}

const guid = (n) => `lppscreen-${n}`;

/**
 * The destinations a take or cut body names, as this app's ids.
 *
 * The body is a list, one entry per screen selected on the console:
 * `[{screenId, direction, effectSelect, switchEffect, screenName, swapEnable}]`
 * for a take, `[{screenId, direction, screenName, screenGuid, swapEnable}]`
 * for a cut. Only `screenId` is used. The switcher's own transition time is
 * what a take runs for, not the console's `switchEffect`.
 *
 * @returns {{ids: string[], unknown: Array<unknown>}}  `unknown` holds the
 *          screen ids that are not a screen this app offered, for the history
 */
export function parseScreens(body, screens) {
  const byNumber = new Map(screens.map((s) => [s.n, s.id]));
  const ids = [];
  const unknown = [];
  for (const entry of Array.isArray(body) ? body : []) {
    const n = entry && entry.screenId;
    const id = Number.isInteger(n) ? byNumber.get(n) : undefined;
    if (!id) { unknown.push(n ?? null); continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  return { ids, unknown };
}

/* -------------------------------------------------------------- replies */

/** A Pixelhue answer. `code` 0 is success; anything else is a refusal, with its message. */
export const ok = (data = {}) => ({ code: 0, message: 'ok', data });
export const refusal = (message, code = 1) => ({ code, message: String(message) });

const page = (list) => ({ count: list.length, page: 1, totalCount: list.length, totalPage: 1, list });

/** `GET screen/list-detail`: the screens as the console's SCREEN row draws them. */
export function listDetail(screens) {
  return page(screens.map((s, i) => ({
    screenId: s.n,
    screenIdObj: { id: s.n, type: 2 },
    guid: guid(s.n),
    enable: 1,
    select: i === 0 ? 1 : 0,
    general: { name: s.label },
    freeze: 0,
    ftb: { enable: 0, time: 500 },
    thumbTiming: { interlaced: 0, frame: 60, width: 1920, height: 1080 },
    createTime: 0,
  })));
}

/** `GET screen/list-thumb`: the screen brief list, which the console's TAKE selects from. */
export function listThumb(screens) {
  return page(screens.map((s) => ({
    screenId: s.n,
    screenIdObj: { id: s.n, type: 2 },
    general: { name: s.label, area: { areaId: 0, areaName: '' } },
    mosaic: { type: 0, splice: { row: 1, column: 1 } },
    enable: 1,
  })));
}

/** `GET screen/tbar`: where each screen's T-bar rests. A list, never an object, or nothing decodes. */
export function tbar(screens) {
  return screens.map((s) => ({
    screenId: s.n, screenGuid: guid(s.n), percent: 0, effectSelect: 0, switchEffect: { time: 500, type: 1 }, swapEnable: 0,
  }));
}

/** `GET node/detail`: the switcher itself. Work mode 0, since the console refuses a take in some others. */
export function nodeDetail({ serial, name = IDENTITY.name }) {
  return {
    nodeId: 1, modelId: IDENTITY.modelId, seriesType: 0, status: 1, online: 1, sn: serial, version: IDENTITY.version,
    versionMatching: { serverVersion: IDENTITY.version.replace(/^V/, ''), minMatchingVersion: '', minProductVersion: '' },
    general: { name }, configInfo: { md5: '' }, powerState: 0, area: { areaId: 0, areaName: '' },
    mode: { workMode: 0, masterSlave: 0 }, location: { enable: 0 }, time: { timestamp: 0, timezone: 0 },
    stateInfo: { slot: [{ slotId: 100, status: [{ type: 4, index: 0, state: 1, value: 1, online: 1 }, { type: 0, index: 0, state: 1, value: 0, online: 1 }] }] },
    syncTime: { timeMode: 0, gps: {}, lora: { groupId: '' }, ntp: { server: '' } },
    networkType: 1, subcards: [],
    genlock: {
      type: 0, sourceId: 0, frameRate: 0, frameRateScale: 0, syncLockStatus: 0,
      phase: { enable: 0, offset: 0, phaseOffsetType: 0, angle: 0, angleScale: 0, percentage: 0, percentageScale: 0, lineCount: 0, pixel: 0 },
      frameRateMode: 0, internalFrame: { framerate: 0 }, output: { type: 0 },
    },
    genlockStatus: { status: 0 }, deviceBeacon: 1, deviceType: 0,
    deviceBackup: { master: { mac: '', sn: '', ip: '', name: '', modeId: 0 }, slave: [] },
    lastOperationTime: 0, subStatus: [], virtualId: 0, layerMode: 0,
    authorInfo: { startTimestamp: 0, endTimestamp: 0, durationTimestamp: 0, flag: 0 },
    fanMode: 0, mvr: { mode: 0 }, plugin: { resource: { url: '', md5: '' } }, antiStatic: { enable: 0, time: 0 },
    displaySwitchInfo: { startupPictureEnable: 0, manufacturerIdentityEnable: 0 }, fadeLever: 0,
  };
}

/** `GET node/ethernet`. It must list an interface: with none, nvcontroller panics reading its MAC. */
export function nodeEthernet({ serial, address }) {
  return {
    nodeId: 1, state: 0,
    ethernet: {
      mode: 0,
      infos: [{
        index: 0, mac: macFor(serial), dhcp: 0, ip: address || '0.0.0.0', netmask: '255.255.255.0',
        gateway: '0.0.0.0', interfaceType: 25, autoDNS: 0, dns: [],
      }],
    },
  };
}

/* ------------------------------------------------------------- requests */

/**
 * What one request is answered with.
 *
 * @param {object} req
 * @param {string} req.method
 * @param {string} req.path    the URL path, without the query
 * @param {unknown} req.body   the parsed JSON body, or null
 * @param {object} state
 * @param {Array} state.screens  `screensFrom(facts)`
 * @param {string} state.serial
 * @param {string} state.token
 * @param {string} [state.address]  this app's address on the mini's network
 * @returns {{reply: object} | {action: 'take'|'cut', ids: string[], unknown: Array}}
 *          an action is answered by whoever performs it; `unhandled` marks a
 *          request answered with a bare success because nothing here knows it
 */
export function respond({ method, path, body }, state) {
  const name = String(path || '').startsWith(API) ? String(path).slice(API.length) : String(path || '');
  const verb = String(method || 'GET').toUpperCase();
  const key = `${verb} ${name}`;
  const { screens = [], serial, token, address } = state || {};

  switch (key) {
    case 'POST system/auth/login': return { reply: ok({ token }) };
    case 'GET screen/list-detail': return { reply: ok(listDetail(screens)) };
    case 'GET screen/list-thumb': return { reply: ok(listThumb(screens)) };
    case 'GET screen/tbar': return { reply: ok(tbar(screens)) };
    /* Read on every take. An empty answer is the console's default: 500 ms, type 1. */
    case 'GET screen/global/switch-effect': return { reply: ok({}) };
    case 'GET node/detail': return { reply: ok(nodeDetail({ serial })) };
    case 'GET node/ethernet': return { reply: ok(nodeEthernet({ serial, address })) };
    /* Empty, on purpose: listing this app here made the stand-in's takes lag and then stop. */
    case 'GET ucenter/device-list': return { reply: ok({ list: [] }) };
    case 'GET preset': return { reply: ok(page([])) };
    case 'GET picture/list': return { reply: ok({ usedCapacity: 0, totalCapacity: 100, list: [] }) };
    case 'PUT screen/take': return { action: 'take', ...parseScreens(body, screens) };
    case 'PUT screen/cut': return { action: 'cut', ...parseScreens(body, screens) };
    default: return { reply: ok({}), unhandled: true };
  }
}

/* ------------------------------------------------------------ discovery */

/**
 * A discovery search, or null for anything else on the port. nvcontroller
 * sends one a second, broadcast and to each address in its `device-ips`: one
 * frame carrying ONE TLV, unlike the two of a WebSocket frame, so `apollo.js`'s
 * decoder does not apply.
 *
 * @returns {{seq:number, code:number}|null}
 */
export function discoveryProbe(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEAD + TLV_HEAD) return null;
  if (!buf.subarray(0, 4).equals(MAGIC)) return null;
  const code = buf.readUInt32LE(FRAME_HEAD);
  if (code !== DISCOVERY_CODE) return null;
  return { seq: buf.readUIntLE(22, 3), code };
}

/** What a search is answered with: who this is, and where to log in. */
export function discoveryBody({ serial, name = IDENTITY.name, port = SWITCHER_PORT }) {
  const protocols = [['http', port], ['websocket', port], ['udp', DISCOVERY_PORT]].map(([linkType, p]) => ({
    linkType, protocolType: 'G4A', protocolVersion: '2.0', apiVersion: '1.0', port: p, frameSize: 65535,
  }));
  return {
    modelId: IDENTITY.modelId, SN: serial, deviceName: name,
    encryption: { encryMode: 0, encryParameters: '' },
    protocols,
    connectionLimit: { maxConnectionNum: 50, connectedNum: 0 },
  };
}

/** The answer frame: the search's own seq and code, one TLV of JSON. */
export function discoveryReply({ seq, code = DISCOVERY_CODE, body }) {
  const json = Buffer.from(JSON.stringify(body), 'utf8');
  const frame = Buffer.alloc(FRAME_HEAD + TLV_HEAD + json.length);
  MAGIC.copy(frame, 0);
  frame[5] = 1;
  frame.writeUInt16LE((frame.length - 22) & 0xffff, 16);
  frame.writeUIntLE(seq & 0xffffff, 22, 3);
  frame[26] = 1;
  frame.writeUInt32LE(code >>> 0, FRAME_HEAD);
  frame.writeUInt16LE((json.length >>> 16) & 0xffff, FRAME_HEAD + 4);
  frame.writeUInt16LE(json.length & 0xffff, FRAME_HEAD + 6);
  json.copy(frame, FRAME_HEAD + TLV_HEAD);
  frame.writeUInt16LE(crc16x25(frame.subarray(22)), 18);
  frame.writeUInt16LE(crc16x25(frame.subarray(0, 20)), 20);
  return frame;
}

/** Read an answer back (for tests, and the card's own check): `{seq, code, body}`, or null. */
export function readDiscoveryReply(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < FRAME_HEAD + TLV_HEAD || !buf.subarray(0, 4).equals(MAGIC)) return null;
  const length = buf.readUInt16LE(FRAME_HEAD + 6) + (buf.readUInt16LE(FRAME_HEAD + 4) << 16);
  const raw = buf.subarray(FRAME_HEAD + TLV_HEAD, FRAME_HEAD + TLV_HEAD + length);
  let body = null;
  try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; }
  return { seq: buf.readUIntLE(22, 3), code: buf.readUInt32LE(FRAME_HEAD), body };
}
