/*
 * Dante — Dante Controller preset files, read and written. No I/O, no DOM.
 *
 * Dante Controller has no remote-control interface, but it does have **File ▸
 * Save Preset** and **File ▸ Load Preset**, and a preset is a plain XML file
 * meant to be edited by hand (its user guide says so). That makes the file
 * the honest way to work beside it: this app writes a preset of what it reads
 * off the network, which Dante Controller can load, and reads a preset Dante
 * Controller saved, to show what applying it would change before anything is
 * sent.
 *
 * ## The format
 *
 * Read off three sources that agree: a preset Dante Controller saved,
 * published as an example in DanteArchitect (MIT,
 * <https://github.com/Nebensound/DanteArchitect>, kept as
 * `test/fixtures/dante/dante-controller-preset.xml`); netaudio's preset reader
 * and writer (`packages/netaudio/src/netaudio/presets/parsing.py`,
 * `serialization.py`, Unlicense); and the element names and parameter rules
 * in Dante Controller 4.18.1.1's own user guide.
 *
 *   <preset version="2.1.0">
 *     <name>…</name> <description>…</description>
 *     <device>
 *       <name>Desk</name> … <friendly_name>Desk</friendly_name>
 *       <instance_id><device_id>001DC10B0AD20000</device_id><process_id>0</process_id></instance_id>
 *       <samplerate>48000</samplerate> <unicast_latency>1000</unicast_latency>   (µs)
 *       <txchannel danteId="1" mediaType="audio"><label>Mix L</label></txchannel>
 *       <rxchannel danteId="1" mediaType="audio">
 *         <name>Front L</name>
 *         <subscribed_channel>Out 1</subscribed_channel>
 *         <subscribed_device>Stagebox</subscribed_device>
 *       </rxchannel>
 *     </device>
 *   </preset>
 *
 * A receive channel with no `subscribed_*` is one with no subscription — and
 * Dante Controller **clears** it when the preset's subscriptions are applied
 * ("any existing subscriptions on the target system that do not exist in the
 * preset will be removed"), which is the rule `presetRoutes` follows.
 *
 * ## The XML reader is ours, and small on purpose
 *
 * The app has no dependencies, and the server has no DOMParser. A preset is a
 * flat, regular document, so this reads elements, attributes, text, CDATA,
 * comments and the five named entities plus numeric ones — and **refuses** a
 * DOCTYPE or an ENTITY declaration outright, as netaudio's reader does, so
 * nothing a file says can make it expand or fetch anything.
 */

import { findDevice, subscriptionOf } from './core.js';

export const MAX_PRESET_BYTES = 4 * 1024 * 1024;
export const PRESET_VERSION = '2.1.0';

/* ---------------------------------------------------------------- reading */

const ENTITY = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    if (e in ENTITY) return ENTITY[e];
    throw new Error(`the preset uses an entity this reader does not know: &${e};`);
  });
}

/**
 * Parse an XML document into `{ tag, attrs, children, text }` nodes. Throws a
 * sentence on anything malformed; never returns half a tree.
 */
export function parseXml(source) {
  const s = String(source ?? '');
  if (s.length > MAX_PRESET_BYTES) throw new Error('the preset is larger than any preset should be');
  if (/<!DOCTYPE|<!ENTITY/i.test(s)) throw new Error('the preset declares a document type or entities, which a preset never needs');
  let i = 0;
  const root = { tag: '#document', attrs: {}, children: [], text: '' };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { top().text += decodeEntities(s.slice(i)); break; }
    if (lt > i) top().text += decodeEntities(s.slice(i, lt));
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      if (end < 0) throw new Error('a comment in the preset never ends');
      i = end + 3;
    } else if (s.startsWith('<![CDATA[', lt)) {
      const end = s.indexOf(']]>', lt + 9);
      if (end < 0) throw new Error('a CDATA section in the preset never ends');
      top().text += s.slice(lt + 9, end);
      i = end + 3;
    } else if (s.startsWith('<?', lt)) {
      const end = s.indexOf('?>', lt + 2);
      if (end < 0) throw new Error('a processing instruction in the preset never ends');
      i = end + 2;
    } else if (s[lt + 1] === '/') {
      const end = s.indexOf('>', lt);
      if (end < 0) throw new Error('the preset ends inside a closing tag');
      const tag = s.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.tag !== tag || open === root) throw new Error(`the preset closes <${tag}> where <${open ? open.tag : '?'}> is open`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/.exec(s.slice(lt, lt + 4096));
      if (!m) throw new Error(`the preset has a malformed tag near “${s.slice(lt, lt + 40)}”`);
      const attrs = {};
      for (const a of m[2].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[a[1]] = decodeEntities(a[2] ?? a[3] ?? '');
      }
      const node = { tag: m[1], attrs, children: [], text: '' };
      top().children.push(node);
      if (!m[3]) stack.push(node);
      i = lt + m[0].length;
    }
  }
  if (stack.length !== 1) throw new Error(`the preset ends with <${top().tag}> still open`);
  const elements = root.children;
  if (elements.length !== 1) throw new Error('a preset has exactly one root element');
  return elements[0];
}

const kids = (node, tag) => node.children.filter((c) => c.tag === tag);
const child = (node, tag) => node.children.find((c) => c.tag === tag) || null;
const textOf = (node, tag) => {
  const c = child(node, tag);
  return c ? c.text.trim() : null;
};

/**
 * A preset file as roles: `{ name, version, roles: [{ name, deviceId,
 * manufacturer, model, sampleRate, latencyUs, tx: [{ number, labels }],
 * rx: [{ number, name, sub }] }] }`. A role is Dante Controller's word for
 * one device's saved configuration, applicable to that device or another.
 */
export function readPreset(source) {
  const root = parseXml(source);
  if (root.tag !== 'preset') {
    throw new Error(root.tag === 'network'
      ? 'this is a legacy Dante Controller preset (<network>); open it in Dante Controller and save it again'
      : 'this is not a Dante Controller preset — its root element is not <preset>');
  }
  const roles = [];
  const names = new Set();
  for (const d of kids(root, 'device')) {
    const name = textOf(d, 'friendly_name') || textOf(d, 'name');
    if (!name) continue;
    if (names.has(name.toLowerCase())) throw new Error(`the preset has two roles called ${name}`);
    names.add(name.toLowerCase());
    const id = child(d, 'instance_id');
    const rx = [];
    const seen = new Set();
    for (const c of kids(d, 'rxchannel')) {
      const number = Number(c.attrs.danteId);
      if (!Number.isInteger(number) || number < 1) throw new Error(`${name}: a receive channel has no danteId`);
      if (seen.has(number)) throw new Error(`${name}: receive channel ${number} is in the preset twice`);
      seen.add(number);
      if ((c.attrs.mediaType || 'audio') !== 'audio') continue;
      const channel = textOf(c, 'subscribed_channel');
      const device = textOf(c, 'subscribed_device');
      if (device && !channel) throw new Error(`${name}: receive channel ${number} names a device and no channel`);
      rx.push({ number, name: textOf(c, 'name') ?? '', sub: channel ? { channel, device: device || name } : null });
    }
    const tx = kids(d, 'txchannel')
      .filter((c) => (c.attrs.mediaType || 'audio') === 'audio' && Number.isInteger(Number(c.attrs.danteId)))
      .map((c) => ({ number: Number(c.attrs.danteId), labels: kids(c, 'label').map((l) => l.text.trim()).filter(Boolean) }));
    const latency = Number(textOf(d, 'unicast_latency'));
    const rate = Number(textOf(d, 'samplerate'));
    roles.push({
      name,
      deviceId: id ? textOf(id, 'device_id') : null,
      manufacturer: textOf(d, 'manufacturer_name'),
      model: textOf(d, 'model_name'),
      sampleRate: Number.isFinite(rate) && rate > 0 ? rate : null,
      latencyUs: Number.isFinite(latency) && latency > 0 ? latency : null,
      tx,
      rx: rx.sort((a, b) => a.number - b.number)
    });
  }
  if (!roles.length) throw new Error('the preset holds no devices');
  return { name: textOf(root, 'name') || '', version: root.attrs.version || null, roles };
}

/* ----------------------------------------------------------- applying one */

/**
 * Which live device each role applies to. Dante Controller's own order
 * (user guide, "Automatic Assignments"): the device the role was saved from,
 * then a device with the role's name. Its third rule — any free device of the
 * same make and model — is left to the operator, through `assign`, because a
 * guess there routes somebody else's amplifier.
 */
export function assignRoles(preset, devices, assign = {}) {
  const used = new Set();
  return preset.roles.map((role) => {
    const forced = assign[role.name];
    if (forced === null || forced === '') return { role: role.name, device: null, by: 'skipped' };
    let device = forced ? findDevice(devices, forced) : null;
    let by = device ? 'chosen' : null;
    if (!device && role.deviceId) {
      device = devices.find((d) => d.deviceId && d.deviceId.toUpperCase() === role.deviceId.toUpperCase() && !used.has(d.name)) || null;
      if (device) by = 'device id';
    }
    if (!device) {
      device = findDevice(devices.filter((d) => !used.has(d.name)), role.name);
      if (device) by = 'name';
    }
    if (device) used.add(device.name);
    return { role: role.name, device: device ? device.name : null, by: device ? by : 'no match' };
  });
}

/**
 * The routes applying a preset's subscriptions asks for, by role assignment.
 * A receive channel the preset lists empty is cleared, and so is one the
 * target has and the preset does not list — Dante Controller's rule — each
 * marked `implied` so the diff can say which is which.
 */
export function presetRoutes(preset, devices, assignments) {
  const out = [];
  for (const a of assignments) {
    if (!a.device) continue;
    const role = preset.roles.find((r) => r.name === a.role);
    const device = findDevice(devices, a.device);
    if (!role || !device) continue;
    const listed = new Set(role.rx.map((c) => c.number));
    for (const c of role.rx) {
      const sub = c.sub ? { channel: c.sub.channel, device: c.sub.device === role.name ? device.name : c.sub.device } : null;
      out.push({ rx: { device: device.name, channel: c.number }, tx: sub, role: role.name });
    }
    for (const c of device.rx || []) {
      if (!listed.has(c.number)) out.push({ rx: { device: device.name, channel: c.number }, tx: null, role: role.name, implied: true });
    }
  }
  return out;
}

/* ---------------------------------------------------------------- writing */

const escapeXml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/**
 * A preset of the devices as this app read them, in the layout Dante
 * Controller writes: four-space indent, `standalone="yes"`, version 2.1.0.
 * What is written is what was read — names, channel labels and
 * subscriptions, the sample rate and latency when the device reported them,
 * and the device id when its CMC advertisement gave one. Nothing is invented
 * to fill a field Dante Controller would have filled.
 */
export function writePreset({ name, description = 'Saved by LivePremier Plus', devices }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>', `<preset version="${PRESET_VERSION}">`];
  const el = (depth, tag, value) => lines.push(`${'    '.repeat(depth)}<${tag}>${escapeXml(value)}</${tag}>`);
  el(1, 'name', name);
  el(1, 'description', description);
  for (const d of devices) {
    lines.push('    <device>');
    el(2, 'name', d.name);
    if (d.deviceId) {
      lines.push('        <instance_id>');
      el(3, 'device_id', d.deviceId.toUpperCase());
      el(3, 'process_id', '0');
      lines.push('        </instance_id>');
    }
    if (d.manufacturer) el(2, 'manufacturer_name', d.manufacturer);
    if (d.model) el(2, 'model_name', d.model);
    el(2, 'friendly_name', d.name);
    if (Number.isFinite(d.sampleRate) && d.sampleRate > 0) el(2, 'samplerate', String(d.sampleRate));
    if (Number.isFinite(d.latencyNs) && d.latencyNs > 0) el(2, 'unicast_latency', String(Math.round(d.latencyNs / 1000)));
    for (const c of d.tx || []) {
      lines.push(`        <txchannel danteId="${c.number}" mediaType="audio">`);
      el(3, 'label', c.label);
      lines.push('        </txchannel>');
    }
    for (const c of d.rx || []) {
      lines.push(`        <rxchannel danteId="${c.number}" mediaType="audio">`);
      el(3, 'name', c.label);
      const sub = subscriptionOf(d, c);
      if (sub) {
        el(3, 'subscribed_channel', sub.channel);
        el(3, 'subscribed_device', sub.device);
      }
      lines.push('        </rxchannel>');
    }
    lines.push('    </device>');
  }
  lines.push('</preset>');
  return lines.join('\n') + '\n';
}

/** A file name for a preset: the name, made safe, `.xml`. */
export const presetFileName = (name) => `${String(name || 'dante-routing').replace(/[^\w .-]+/g, '_').trim() || 'dante-routing'}.xml`;
