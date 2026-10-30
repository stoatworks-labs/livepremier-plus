/*
 * The desk's fixture files for Avolites Titan, as `.d4` personalities — no I/O.
 *
 * Titan reads GDTF only through Personality Builder (v17 and later), which
 * converts it to a `.d4` anyway, so this writes the `.d4` straight from the
 * one definition in `core/dmx-personality.js`: one file per fixture type
 * (Master, Screen, Layer), a mode per mode of the personality. A user's own
 * personalities go in `Documents\Titan\Personalities` on Titan PC (and
 * `D:\Personalities` on a console), named `Manufacturer_Fixture.d4`; Titan
 * reads that folder ahead of its own library.
 *
 * The shape is copied from real personalities (Bitfocus Companion's, which
 * Avolites made, and two others on GitHub): a BOM, CRLF lines, the attributes
 * in `<Control>` with their functions, and each `<Mode>` listing which
 * attributes sit at which channel offsets (1-based; "4,5" for 16-bit, coarse
 * first) on which encoder wheel.
 *
 * Attribute IDs: the opacity is Titan's own `Dimmer`, so it is intensity and
 * follows the grand master, and the Colour folder's red, green and blue are
 * `Red`, `Green` and `Blue`, so the colour picker drives them. Everything else
 * is `LPP_…` in the group a desk shows it in: source under Gobo (where media
 * servers keep it), position and size under Position, crop and mask under
 * Beam, strobe under Intensity, the look under Effects, control under Special.
 *
 * A wheel number looks like a slot on a 30-slot encoder layout, by group, that
 * repeats every 30 (read from those files: Dimmer 1, Pan 2, Tilt 3, Red 10,
 * Special 28 to 30, and a second page from 31). Each attribute gets its
 * group's next free slot, so none share an encoder.
 *
 * ⚠️ Not yet imported into a real Titan (docs/DESK-CONTROL.md says what has run).
 */

import { FIXTURES, MODES } from './dmx-personality.js';
import { MANUFACTURER } from './desk-gdtf.js';
import { zipStore } from './zip.js';

/* Fixed, so the same definition always makes the same bytes. */
const HISTORY_DATE = '30-10-26';
const ZIP_DATE = new Date(2026, 9, 30, 0, 0, 0);

/* Titan's own IDs, where Titan's attribute means the same; then ours that read better than `LPP_X`. */
const OWN_ID = { opacity: 'Dimmer', red: 'Red', green: 'Green', blue: 'Blue' };
const LONG_ID = { x: 'PosX', y: 'PosY', w: 'Width', h: 'Height' };
/* The colour Titan shows a colour mix channel as. */
const COLOUR = { red: '255,0,0', green: '0,255,0', blue: '0,0,255' };

const GROUP = {
  control: 'S', memory: 'S', take: 'S', cut: 'S',
  folder: 'G', file: 'G',
  opacity: 'I', strobe: 'I',
  x: 'P', y: 'P', w: 'P', h: 'P',
  red: 'C', green: 'C', blue: 'C',
  cropLeft: 'B', cropRight: 'B', cropTop: 'B', cropBottom: 'B',
  maskLeft: 'B', maskRight: 'B', maskTop: 'B', maskBottom: 'B',
};
const groupOf = (attr) => GROUP[attr] || 'E';

/* Each group's slots on one 30-wheel page; the next page is 30 on. */
const SLOTS = {
  I: [1, 4, 5, 6], P: [2, 3], C: [10, 11, 12, 7, 8, 9], G: [13, 14, 15, 16, 17, 18],
  B: [19, 20, 21], E: [22, 23, 24, 25, 26, 27], S: [28, 29, 30],
};

/* 16-bit channels shown in pixels; the other 16-bit ones are a share of the picture. */
const PIXELS = new Set(['x', 'y', 'w', 'h', 'shadowX', 'shadowY']);

export const d4Id = (attr) => OWN_ID[attr] || `LPP_${LONG_ID[attr] || attr[0].toUpperCase() + attr.slice(1)}`;

/** The file name Titan expects: Manufacturer_Fixture.d4. */
export function d4Name(kind) {
  return `${MANUFACTURER}_${FIXTURES[kind].name.replace(/\s+/g, '_')}.d4`;
}

/** Every attribute a fixture type uses, in the order its largest mode has them, with a wheel each. */
function attributesOf(ft) {
  const seen = new Map();
  for (const channels of Object.values(ft.modes)) for (const c of channels) if (!seen.has(c.attr)) seen.set(c.attr, c);
  const taken = {};
  return [...seen.values()].map((c) => {
    const group = groupOf(c.attr);
    const n = taken[group] = (taken[group] || 0) + 1;
    const slots = SLOTS[group];
    const wheel = slots[(n - 1) % slots.length] + 30 * Math.floor((n - 1) / slots.length);
    return { c, id: d4Id(c.attr), group, wheel };
  });
}

const round = (v, places = 2) => Number(v.toFixed(places));

/**
 * How Titan shows one value range: a name for a step, or a printf format and
 * the range it spans, `'Memory %.f',1~255`, for a range of values.
 */
function display(c, set) {
  const literal = `'${set.name.replace(/'/g, '')}'`;
  if (set.from === set.to) return literal;
  const numbered = /^(.*\S)\s+(\d+)-(\d+)$/.exec(set.name);
  if (numbered) return `'${numbered[1]} %.f',${numbered[2]}~${numbered[3]}`;
  if (c.bits === 16) {
    const [lo, hi] = c.physical || [0, 65535];
    const at = (v) => Math.round(lo + (v * (hi - lo)) / 65535);
    if (PIXELS.has(c.attr)) return `'%.f px',${at(set.from)}~${at(set.to)}`;
    return `'%.2f%%',${(set.from / 655.35).toFixed(2)}~${(set.to / 655.35).toFixed(2)}`;
  }
  if (c.role === 'dimmer' || c.role === 'value') {
    return set.from === 0 && set.to === 255 ? "'%.1f%%',0.0~100.0" : `'${set.name} %.f%%',0~100`;
  }
  return literal;
}

/** A Locate or PowerOn value: the function a DMX value falls in, and how far along it when it is a range. */
function functionAt(c, value) {
  const i = Math.max(0, c.sets.findIndex((s) => value >= s.from && value <= s.to));
  const set = c.sets[i];
  if (set.from === set.to || !display(c, set).includes("',")) return String(i + 1);
  return `${i + 1}:${round(((value - set.from) / (set.to - set.from)) * 100)}`;
}

/** One fixture type's `.d4`, as text (BOM and CRLF included). */
export function d4Xml(kind, { version = '1' } = {}) {
  const ft = FIXTURES[kind];
  const attrs = attributesOf(ft);
  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push(`<Fixture Name="${x(ft.name)}" ShortName="${x(ft.short)}" Company="${MANUFACTURER}" Version="${x(version)}">`);
  out.push(`  <History Date="${HISTORY_DATE}" Author="LivePremier Plus" Comment="${x(ft.description)}" Version="${x(version)}" />`);
  out.push('  <Manual Filename="" Summary="" />');
  out.push('  <Control>');
  for (const { c, id, group } of attrs) {
    out.push(`    <Attribute ID="${id}" Name="${x(c.name)}" Description="" Group="${group}"${c.bits === 16 ? ' Size="2"' : ''}>`);
    /* Locate shows a layer: full opacity, everything else where it starts. Never Control: locate must not take a screen. */
    const locate = c.role === 'dimmer' ? 255 : c.default || 0;
    out.push(`      <Locate Locate="${functionAt(c, locate)}" PowerOn="${functionAt(c, c.default || 0)}" />`);
    c.sets.forEach((set, i) => {
      out.push(`      <Function ID="${i + 1}" Name="${x(set.name)}" Display="${x(display(c, set))}" Dmx="${set.from}~${set.to}"`
        + `${COLOUR[c.attr] ? ` Colour="${COLOUR[c.attr]}"` : ''} />`);
    });
    out.push('    </Attribute>');
  }
  out.push('  </Control>');
  for (const [modeId, channels] of Object.entries(ft.modes)) {
    const label = (MODES.find((m) => m.id === modeId) || { label: modeId }).label;
    const width = channels.reduce((n, c) => n + (c.bits === 16 ? 2 : 1), 0);
    out.push(`  <Mode Name="${x(label)}" Channels="${width}">`);
    out.push('    <Import PearlRef="" DiamondRef="" WysiwygRef="" />');
    out.push('    <Physical>');
    out.push('      <Bulb Type="" Lumens="" ColourTemp="" />');
    out.push('      <Lens Name="" Degrees="" />');
    out.push('      <Weight Kg="" />');
    out.push('      <Size Height="" Width="" Depth="" />');
    out.push('      <Focus Type="Fixed" PanMax="0" TiltMax="0" PanMaxSpeed="0" TiltMaxSpeed="0" />');
    out.push('    </Physical>');
    out.push('    <Include>');
    let offset = 1;
    for (const c of channels) {
      const a = attrs.find((t) => t.c.attr === c.attr);
      const offsets = c.bits === 16 ? `${offset},${offset + 1}` : String(offset);
      out.push(`      <Attribute ID="${a.id}" ChannelOffset="${offsets}" Wheel="${a.wheel}" />`);
      offset += c.bits === 16 ? 2 : 1;
    }
    out.push('    </Include>');
    out.push('  </Mode>');
  }
  out.push('</Fixture>');
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

/** Every fixture type's `.d4`, as one zip for the card's download. */
export function d4Zip({ version = '1' } = {}) {
  return zipStore(Object.keys(FIXTURES).map((kind) => ({ name: d4Name(kind), data: d4Xml(kind, { version }) })), { date: ZIP_DATE });
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
