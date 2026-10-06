/*
 * Dante — what both halves share: the settings, the routing model, the diff
 * that every write goes through, snapshots, and the cue and OSC grammar. No
 * I/O and no DOM; the tests run it under plain Node.
 *
 * ## The model
 *
 * A Dante network is a set of devices, each with transmit channels and
 * receive channels. Routing is held entirely by the **receivers**: a receive
 * channel carries at most one subscription, which names a transmit channel by
 * its label and a device by its name — `Mix L@Desk` in Dante's own notation.
 * Nothing at the transmitter records who is listening. So a route here is
 * always
 *
 *   { rx: { device, channel }, tx: { device, channel } | null }
 *
 * with `null` meaning "clear this receive channel". A receive channel is named
 * by its number or its label; a transmit channel by its label, because that is
 * what goes on the wire. A subscription to a device that is not on the network
 * is legitimate (Dante shows it as unresolved and connects when it appears),
 * so the transmit side is never checked against what was discovered.
 *
 * ## Every write is a diff
 *
 * The grid, a cue, an OSC address, a snapshot recall and a Dante Controller
 * preset all reduce to a list of routes, and `plan()` turns that list into
 * what actually has to change against what the devices said last — nothing is
 * sent for a channel that already carries what was asked, and everything that
 * cannot be done is named with a reason rather than skipped. The server sends
 * the changes and then **reads the receivers back**; what it reports is what
 * the devices said, never what was asked (`docs/DANTE.md`).
 */

/* -------------------------------------------------------------- settings */

export const POLL_SECONDS = { min: 1, max: 60, def: 5 };
export const BROWSE_SECONDS = { min: 5, max: 300, def: 30 };

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const clampInt = (v, { min, max, def }) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
};

/** `192.168.1.20`, `192.168.1.20:4440` — an IPv4 address and an optional port. */
export function parseAddress(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d{1,5}))?$/.exec(text(s));
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  if (octets.some((o) => o > 255)) return null;
  const port = m[5] ? Number(m[5]) : null;
  if (port != null && (port < 1 || port > 65535)) return null;
  return { address: octets.join('.'), port };
}

/**
 * The plugin's settings. Corrected, never refused, like every other setting
 * in the app.
 *
 * - `discovery` — ask the network for Dante devices (mDNS).
 * - `interface` — the IPv4 address of the interface to ask on; empty for every
 *   interface this machine has that is up and not loopback.
 * - `discoveryTarget` — where questions go, `host:port`; empty for the mDNS
 *   group. Only the simulator and the tests point it elsewhere.
 * - `manualDevices` — devices by address, for a network where multicast does
 *   not reach this machine.
 * - `pollSeconds` — how often each device's receive channels are read again,
 *   so a change made in Dante Controller shows here.
 * - `browseSeconds` — how often the network is asked again.
 * - `switcherDevice` — the Dante name of the switcher's own card, when it
 *   cannot be matched by its name or address.
 */
export function normaliseSettings(raw = {}) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const manual = (Array.isArray(r.manualDevices) ? r.manualDevices
    : typeof r.manualDevices === 'string' ? r.manualDevices.split(/[\s,]+/) : [])
    .map(text).filter((s) => parseAddress(s));
  const iface = parseAddress(r.interface);
  const target = parseAddress(r.discoveryTarget);
  return {
    discovery: r.discovery !== false,
    interface: iface && iface.port == null ? iface.address : '',
    discoveryTarget: target ? `${target.address}:${target.port ?? 5353}` : '',
    manualDevices: [...new Set(manual)].slice(0, 64),
    pollSeconds: clampInt(r.pollSeconds, POLL_SECONDS),
    browseSeconds: clampInt(r.browseSeconds, BROWSE_SECONDS),
    switcherDevice: text(r.switcherDevice).slice(0, 31)
  };
}

/** A change the running server half has to act on — not `switcherDevice`, which only the page reads. */
export function settingsChanged(a, b) {
  const keys = ['discovery', 'interface', 'discoveryTarget', 'pollSeconds', 'browseSeconds'];
  return keys.some((k) => a[k] !== b[k]) || JSON.stringify(a.manualDevices) !== JSON.stringify(b.manualDevices);
}

/* --------------------------------------------------------- references */

/**
 * `Mix L@Desk` → `{ channel: 'Mix L', device: 'Desk' }`. A device name cannot
 * hold an `@` and a channel label can, so the split is at the last one.
 */
export function parseRef(s) {
  const t = text(s);
  const at = t.lastIndexOf('@');
  if (at <= 0 || at === t.length - 1) return null;
  return { channel: t.slice(0, at).trim(), device: t.slice(at + 1).trim() };
}

export const formatRef = (r) => (r ? `${r.channel}@${r.device}` : 'nothing');

const same = (a, b) => String(a ?? '') === String(b ?? '');
const sameCi = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

/** A device by name — exactly, then ignoring case, because Dante names are DNS names. */
export function findDevice(devices, name) {
  return devices.find((d) => same(d.name, name)) || devices.find((d) => sameCi(d.name, name)) || null;
}

/** A receive channel by number (`3`, `"3"`) or by label. */
export function findRx(device, ref) {
  if (!device || !Array.isArray(device.rx)) return null;
  const n = typeof ref === 'number' ? ref : /^\d+$/.test(text(String(ref ?? ''))) ? Number(ref) : null;
  if (n != null) return device.rx.find((c) => c.number === n) || null;
  return device.rx.find((c) => same(c.label, ref)) || device.rx.find((c) => sameCi(c.label, ref)) || null;
}

/** A transmit channel by label, or by number when a number is all there is. */
export function findTx(device, ref) {
  if (!device || !Array.isArray(device.tx)) return null;
  const byLabel = device.tx.find((c) => same(c.label, ref)) || device.tx.find((c) => sameCi(c.label, ref));
  if (byLabel) return byLabel;
  const n = typeof ref === 'number' ? ref : /^\d+$/.test(text(String(ref ?? ''))) ? Number(ref) : null;
  return n != null ? device.tx.find((c) => c.number === n) || null : null;
}

/**
 * What a receive channel is subscribed to, with the receiver's own `"."`
 * spelled out — a device reporting a subscription to itself says `.`.
 */
export function subscriptionOf(device, channel) {
  const sub = channel && channel.sub;
  if (!sub || !sub.channel) return null;
  return { channel: sub.channel, device: !sub.device || sub.device === '.' ? device.name : sub.device };
}

/** Whether a receive channel's subscription is to this transmit channel. */
export function isSubscribedTo(rxDevice, rxChannel, txDevice, txChannel) {
  const sub = subscriptionOf(rxDevice, rxChannel);
  return Boolean(sub && sameCi(sub.device, txDevice.name) && (same(sub.channel, txChannel.label) || sameCi(sub.channel, txChannel.label)));
}

/* --------------------------------------------------------------- plans */

/**
 * Normalise a route as callers send it. A transmit side of `null`, `''`,
 * `'none'` or `'-'` clears; a string is read as `channel@device`.
 */
export function normaliseRoute(r) {
  if (!r || typeof r !== 'object') return null;
  const rx = typeof r.rx === 'string' ? parseRef(r.rx) : r.rx;
  if (!rx || !text(String(rx.device ?? '')) || rx.channel == null || text(String(rx.channel)) === '') return null;
  let tx = r.tx;
  if (tx == null || (typeof tx === 'string' && /^(|none|-|clear)$/i.test(tx.trim()))) tx = null;
  else if (typeof tx === 'string') { tx = parseRef(tx); if (!tx) return null; }
  else if (!text(String(tx.device ?? '')) || !text(String(tx.channel ?? ''))) return null;
  return {
    rx: { device: text(String(rx.device)), channel: typeof rx.channel === 'number' ? rx.channel : text(String(rx.channel)) },
    tx: tx ? { device: text(String(tx.device)), channel: text(String(tx.channel)) } : null
  };
}

/**
 * Turn wanted routes into what has to change, against the devices as last
 * read. Every route comes back with an `outcome`:
 *
 * - `change` — to be sent; `from` is what the channel carries now
 * - `same` — already so; nothing will be sent
 * - `missing` — the receiving device or channel is not there, `error` says which
 * - `refused` — the device cannot be written (`error` says why) or the
 *   transmit names are not ones Dante accepts
 *
 * The same receive channel named twice keeps the last, as a cue sheet read
 * top to bottom would.
 */
export function plan(devices, routes, { validate = () => null } = {}) {
  const byKey = new Map();
  for (const raw of routes) {
    const r = normaliseRoute(raw);
    if (!r) continue;
    byKey.set(`${String(r.rx.device).toLowerCase()}\u0000${String(r.rx.channel).toLowerCase()}`, r);
  }
  const out = [];
  for (const r of byKey.values()) {
    const device = findDevice(devices, r.rx.device);
    if (!device) { out.push({ ...r, outcome: 'missing', error: `no device called ${r.rx.device}` }); continue; }
    const channel = findRx(device, r.rx.channel);
    if (!channel) { out.push({ ...r, outcome: 'missing', error: `${device.name} has no receive channel ${r.rx.channel}` }); continue; }
    const at = { device: device.name, channel: channel.number, label: channel.label };
    const from = subscriptionOf(device, channel);
    const tx = r.tx ? { device: r.tx.device === '.' ? device.name : r.tx.device, channel: r.tx.channel } : null;
    const already = tx ? Boolean(from && sameCi(from.device, tx.device) && same(from.channel, tx.channel)) : !from;
    if (already) { out.push({ rx: at, tx, from, outcome: 'same' }); continue; }
    if (!device.writable) { out.push({ rx: at, tx, from, outcome: 'refused', error: device.why || `${device.name} cannot be written` }); continue; }
    const problem = tx ? validate(tx) : null;
    if (problem) { out.push({ rx: at, tx, from, outcome: 'refused', error: problem }); continue; }
    out.push({ rx: at, tx, from, outcome: 'change' });
  }
  return out;
}

/** The changes in a plan, by receiving device: `Map(name → [{ number, tx }])`. */
export function changesByDevice(planned) {
  const out = new Map();
  for (const p of planned) {
    if (p.outcome !== 'change') continue;
    if (!out.has(p.rx.device)) out.set(p.rx.device, []);
    out.get(p.rx.device).push({ number: p.rx.channel, tx: p.tx });
  }
  return out;
}

/**
 * After a write, what the devices say now against what was asked: each
 * change becomes `confirmed` (the receiver reports the subscription asked
 * for — whether audio flows yet is its status, reported beside it),
 * `unconfirmed` (it reports something else), or keeps a failure it already
 * had.
 */
export function confirm(planned, devices, failures = new Map()) {
  return planned.map((p) => {
    if (p.outcome !== 'change') return p;
    const failed = failures.get(`${p.rx.device}\u0000${p.rx.channel}`);
    const device = findDevice(devices, p.rx.device);
    const channel = device && findRx(device, p.rx.channel);
    const now = channel ? subscriptionOf(device, channel) : null;
    const status = channel ? channel.status : null;
    const ok = p.tx ? Boolean(now && sameCi(now.device, p.tx.device) && same(now.channel, p.tx.channel)) : !now;
    if (ok) return { ...p, outcome: 'confirmed', now, status };
    return { ...p, outcome: failed ? 'refused' : 'unconfirmed', now, status, error: failed || `${p.rx.device} reports ${formatRef(now)}` };
  });
}

/** One sentence for a whole plan's result, the way a cue warning or an OSC log line wants it. */
export function summarise(results) {
  const n = (o) => results.filter((r) => r.outcome === o).length;
  const parts = [];
  if (n('confirmed')) parts.push(`${n('confirmed')} confirmed`);
  if (n('change')) parts.push(`${n('change')} to change`);
  if (n('same')) parts.push(`${n('same')} already so`);
  if (n('unconfirmed')) parts.push(`${n('unconfirmed')} not confirmed`);
  if (n('refused')) parts.push(`${n('refused')} refused`);
  if (n('missing')) parts.push(`${n('missing')} missing`);
  return parts.join(', ') || 'nothing to do';
}

export const failed = (results) => results.filter((r) => ['unconfirmed', 'refused', 'missing'].includes(r.outcome));

/* ------------------------------------------------------------ snapshots */

const SNAPSHOT_NAME = /^[^\u0000-\u001f]{1,64}$/;

/**
 * A routing snapshot: `{ name, savedAt, devices: [{ name, rx: [{ number,
 * label, sub }] }] }`, `sub` being `{ channel, device }` or null. Only what a
 * recall needs, and every receive channel of every device saved — a channel
 * saved empty is cleared on recall, as Dante Controller clears one.
 */
export function normaliseSnapshots(raw) {
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.snapshots) ? raw.snapshots : [];
  const out = [];
  const names = new Set();
  for (const s of list) {
    if (!s || typeof s.name !== 'string' || !SNAPSHOT_NAME.test(s.name.trim())) continue;
    const name = s.name.trim();
    if (names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const devices = (Array.isArray(s.devices) ? s.devices : []).map((d) => ({
      name: text(d && d.name),
      rx: (Array.isArray(d && d.rx) ? d.rx : []).filter((c) => c && Number.isInteger(c.number) && c.number > 0).map((c) => ({
        number: c.number,
        label: typeof c.label === 'string' ? c.label : '',
        sub: c.sub && text(c.sub.channel) && text(c.sub.device) ? { channel: text(c.sub.channel), device: text(c.sub.device) } : null
      }))
    })).filter((d) => d.name && d.rx.length);
    out.push({ name, savedAt: typeof s.savedAt === 'string' ? s.savedAt : null, devices });
  }
  return out;
}

/** A snapshot of the named devices as they read now — every receiving device when `names` is empty. */
export function snapshotOf(devices, name, names = [], savedAt = null) {
  const chosen = names.length ? names.map((n) => findDevice(devices, n)).filter(Boolean) : devices;
  return normaliseSnapshots([{
    name,
    savedAt,
    devices: chosen.filter((d) => d.rx && d.rx.length).map((d) => ({
      name: d.name,
      rx: d.rx.map((c) => ({ number: c.number, label: c.label, sub: subscriptionOf(d, c) }))
    }))
  }])[0] || null;
}

/** The routes a snapshot recall asks for: every saved channel, by number. */
export function snapshotRoutes(snapshot) {
  const out = [];
  for (const d of snapshot.devices) {
    for (const c of d.rx) out.push({ rx: { device: d.name, channel: c.number }, tx: c.sub ? { ...c.sub } : null });
  }
  return out;
}

/* ------------------------------------------------------------------ cues */

/**
 * The cue field: one action per `;`.
 *
 *   snapshot Show A              recall a saved snapshot
 *   1@Amp-1 <- Mix L@Desk        subscribe receive channel 1 of Amp-1
 *   Front L@Amp-1 <- none        clear a receive channel, named by its label
 *
 * Throws a sentence for the editor to show.
 */
export function parseCueText(textIn) {
  const out = [];
  for (const part of String(textIn ?? '').split(';').map((s) => s.trim()).filter(Boolean)) {
    const snap = /^snapshot\s+(.+)$/i.exec(part);
    if (snap) { out.push({ kind: CUE_KIND, snapshot: snap[1].trim() }); continue; }
    const arrow = part.indexOf('<-');
    if (arrow < 0) throw new Error(`“${part}” — write snapshot <name>, or <rx channel>@<device> <- <tx channel>@<device>`);
    const rx = parseRef(part.slice(0, arrow));
    if (!rx) throw new Error(`“${part.slice(0, arrow).trim()}” is not <channel>@<device>`);
    const right = part.slice(arrow + 2).trim();
    const clear = /^(none|-|clear|nothing)$/i.test(right);
    const tx = clear ? null : parseRef(right);
    if (!clear && !tx) throw new Error(`“${right}” is not <channel>@<device>, or none`);
    out.push({ kind: CUE_KIND, rx: formatRef(rx), tx: tx ? formatRef(tx) : null });
  }
  return out;
}

export const CUE_KIND = 'dante:route';

export function describeCueAction(a) {
  if (!a) return 'Dante';
  if (a.snapshot) return `Dante snapshot ${a.snapshot}`;
  return `${a.rx} <- ${a.tx || 'none'}`;
}

/** What a cue action asks the server for. */
export function cueRequest(a) {
  if (a && a.snapshot) return { path: '/snapshots/recall', body: { name: a.snapshot } };
  return { path: '/apply', body: { routes: [{ rx: a && a.rx, tx: a ? a.tx : null }] } };
}

/* ------------------------------------------------------------------- OSC */

/**
 * `/lp/dante/…` — this app's own addresses, not the switcher's. Under `/lp/`
 * because they belong to the show the switcher is running, and only a
 * built-in may answer there (docs/PLUGINS.md).
 */
export const OSC_PREFIX = '/lp/dante/';
export const DANTE_OSC = [
  { group: 'Dante', address: '/lp/dante/snapshot/{name}/recall', args: 'none', summary: 'Recall a saved routing snapshot: only what differs is sent, and the devices are read back. A release (0) sends nothing.' },
  { group: 'Dante', address: '/lp/dante/route/{device}/{channel}', args: 'string — `channel@device`', summary: 'Subscribe a receive channel (by number, or by label with spaces as `-`) to a transmit channel. An empty string or `none` clears it.' },
  { group: 'Dante', address: '/lp/dante/clear/{device}/{channel}', args: 'none', summary: 'Clear a receive channel’s subscription. A release (0) sends nothing.' }
];

/** mynah's release rule: a trigger fires on no argument or a non-zero one. */
const released = (args) => args.length > 0 && (args[0] === 0 || args[0] === false || args[0] === '0');

/**
 * Read a `/lp/dante/…` address: `{ snapshot }`, `{ route }`, `{ released }`,
 * `{ error }`, or null for an address that is not one of ours.
 */
export function parseDanteOsc(address, args = []) {
  if (!String(address).startsWith(OSC_PREFIX)) return null;
  const parts = String(address).slice(OSC_PREFIX.length).split('/').map((p) => decodeURIComponent(p));
  if (parts[0] === 'snapshot' && parts.length === 3 && parts[2] === 'recall') {
    if (released(args)) return { released: true };
    return { snapshot: parts[1].replace(/-/g, ' '), snapshotExact: parts[1] };
  }
  if ((parts[0] === 'route' || parts[0] === 'clear') && parts.length === 3) {
    const channel = /^\d+$/.test(parts[2]) ? Number(parts[2]) : parts[2].replace(/-/g, ' ');
    if (parts[0] === 'clear') {
      if (released(args)) return { released: true };
      return { route: { rx: { device: parts[1], channel }, tx: null } };
    }
    const value = args.length ? String(args[0]) : '';
    const tx = /^(|none|-|clear)$/i.test(value.trim()) ? null : parseRef(value);
    if (value.trim() && !/^(none|-|clear)$/i.test(value.trim()) && !tx) return { error: `${address} wants channel@device, not “${value}”` };
    return { route: { rx: { device: parts[1], channel }, tx } };
  }
  return { error: `${address} is not a Dante address — docs/OSC.md lists them` };
}

/* ------------------------------------------------------------------ grid */

/**
 * How a whole receiving device meets a whole transmitting one: `count` of
 * its channels take from it, and `straight` when channel i takes channel i
 * for every channel the two have in common — the one-click "stage box into
 * the console, 1 to 1".
 */
export function blockState(rxDevice, txDevice) {
  let count = 0;
  for (const c of rxDevice.rx || []) {
    const sub = subscriptionOf(rxDevice, c);
    if (sub && sameCi(sub.device, txDevice.name)) count += 1;
  }
  const n = Math.min((rxDevice.rx || []).length, (txDevice.tx || []).length);
  let straight = n > 0;
  for (let i = 0; i < n && straight; i++) {
    if (!isSubscribedTo(rxDevice, rxDevice.rx[i], txDevice, txDevice.tx[i])) straight = false;
  }
  return { count, straight, span: n };
}

/** The routes for a click on a block: lay 1→1, or clear exactly that when it is already so. */
export function blockRoutes(rxDevice, txDevice) {
  const { straight, span } = blockState(rxDevice, txDevice);
  const out = [];
  for (let i = 0; i < span; i++) {
    out.push({
      rx: { device: rxDevice.name, channel: rxDevice.rx[i].number },
      tx: straight ? null : { device: txDevice.name, channel: txDevice.tx[i].label }
    });
  }
  return out;
}

/** The route for a click on a crosspoint: subscribe, or clear when it is already that. */
export function cellRoute(rxDevice, rxChannel, txDevice, txChannel) {
  const on = isSubscribedTo(rxDevice, rxChannel, txDevice, txChannel);
  return { rx: { device: rxDevice.name, channel: rxChannel.number }, tx: on ? null : { device: txDevice.name, channel: txChannel.label } };
}

/** A filter over devices and channel labels, case-insensitive; empty keeps everything. */
export function matches(filter, ...values) {
  const f = text(filter).toLowerCase();
  return !f || values.some((v) => String(v ?? '').toLowerCase().includes(f));
}

/** Format a latency in nanoseconds as Dante Controller does, in milliseconds. */
export function formatLatency(ns) {
  if (!Number.isFinite(ns)) return '—';
  return `${Number((ns / 1e6).toFixed(3))} ms`;
}

/** A time as the operator's clock reads it: `2026-10-06 14:05`. */
export function formatLocal(when) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatRate(hz) {
  if (!Number.isFinite(hz) || !hz) return '—';
  return `${(hz / 1000).toFixed(hz % 1000 ? 1 : 0)} kHz`;
}
