/*
 * The desk's fixture files for grandMA2, as MA's fixture type XML — no I/O.
 *
 * grandMA2 does not read GDTF (MA's own converter does, a file at a time), so
 * this writes its XML straight from the one definition in
 * `core/dmx-personality.js`. MA2 has one mode per fixture type, so it is one
 * file per fixture type per mode, named as MA names them,
 * `manufacturer@fixture@mode.xml`. On onPC they go in the user library
 * (`C:\ProgramData\MA Lighting Technologies\grandma\gma2_V_<version>\library`),
 * then Setup → Patch → Fixture Types → Import → User.
 *
 * The shape is copied from files MA2 wrote (the MA Importer's, and
 * Bitfocus Companion's): a channel type per channel with its attribute,
 * feature and preset; a channel function giving the 24-bit DMX range it
 * spans and the physical range it means; channel sets naming the steps.
 *
 * Attributes: the opacity is MA's `DIM` (it follows the grand master), the
 * source is the media server pair `MEDIASERVERINPUTDIRECTORY` and
 * `MEDIASERVERINPUT`, red, green and blue are `COLORRGB1` to `3`, so MA files
 * them where its operators expect. The rest are `LPP_…` under a real feature
 * (Position, Shaper, Shutter) or one of their own under the Video preset; the
 * `*_user_name` fields are what MA names an attribute or feature it does not
 * have yet when the file is imported.
 *
 * ⚠️ Not yet imported into a real grandMA2 (docs/DESK-CONTROL.md says what has run).
 */

import { FIXTURES, MODES } from './dmx-personality.js';
import { MANUFACTURER } from './desk-gdtf.js';
import { zipStore } from './zip.js';

const SCHEMA = '3.9.60';
const DATETIME = '2026-10-30T00:00:00';
const ZIP_DATE = new Date(2026, 9, 30, 0, 0, 0);

/* attr → [attribute, attribute's name, feature, preset, subattribute (when not the attribute)]. */
const MA_ATTRIBUTES = {
  opacity: ['DIM', 'Dim', 'DIMMER', 'DIMMER'],
  folder: ['MEDIASERVERINPUTDIRECTORY', 'MediaServerInputDirectory', 'MEDIA', 'GOBO', 'MEDIASERVERINPUTDIRECTORYSELECT'],
  file: ['MEDIASERVERINPUT', 'MediaServerInput', 'MEDIA', 'GOBO', 'MEDIASERVERINPUTFILESELECT'],
  red: ['COLORRGB1', 'Red', 'COLORRGB', 'COLOR'],
  green: ['COLORRGB2', 'Green', 'COLORRGB', 'COLOR'],
  blue: ['COLORRGB3', 'Blue', 'COLORRGB', 'COLOR'],
};

/* The feature and preset of the attributes of our own. */
const FEATURE = {
  control: 'CONTROL', memory: 'CONTROL', take: 'CONTROL', cut: 'CONTROL',
  x: 'POSITION', y: 'POSITION', w: 'POSITION', h: 'POSITION',
  cropLeft: 'SHAPER', cropRight: 'SHAPER', cropTop: 'SHAPER', cropBottom: 'SHAPER',
  maskLeft: 'SHAPER', maskRight: 'SHAPER', maskTop: 'SHAPER', maskBottom: 'SHAPER',
  strobe: 'SHUTTER',
  borderStyle: 'LPP_BORDER', borderRadius: 'LPP_BORDER', borderWidth: 'LPP_BORDER', borderHeight: 'LPP_BORDER',
  borderOpacity: 'LPP_BORDER', borderRed: 'LPP_BORDER', borderGreen: 'LPP_BORDER', borderBlue: 'LPP_BORDER',
  shadowStyle: 'LPP_SHADOW', shadowRadius: 'LPP_SHADOW', shadowX: 'LPP_SHADOW', shadowY: 'LPP_SHADOW',
  shadowOpacity: 'LPP_SHADOW', shadowRed: 'LPP_SHADOW', shadowGreen: 'LPP_SHADOW', shadowBlue: 'LPP_SHADOW',
};
const PRESET_OF = {
  CONTROL: 'CONTROL', POSITION: 'POSITION', SHAPER: 'SHAPERS', SHUTTER: 'BEAM',
  LPP_LOOK: 'VIDEO', LPP_BORDER: 'VIDEO', LPP_SHADOW: 'VIDEO',
};
const USER_NAME = {
  DIMMER: 'Dimmer', MEDIA: 'Media', GOBO: 'Gobo', COLORRGB: 'Color RGB', COLOR: 'Color', CONTROL: 'Control',
  POSITION: 'Position', SHAPER: 'Shaper', SHAPERS: 'Shapers', SHUTTER: 'Shutter', BEAM: 'Beam', VIDEO: 'Video',
  LPP_LOOK: 'Look', LPP_BORDER: 'Border', LPP_SHADOW: 'Shadow',
};
const COLOUR = { red: 'ff0000', green: '00ff00', blue: '0000ff' };

/** MA's name for an attribute of ours: `LPP_CROPLEFT`, `LPP_POSX`. */
const LONG = { x: 'POSX', y: 'POSY', w: 'WIDTH', h: 'HEIGHT' };
const ownAttribute = (attr) => `LPP_${LONG[attr] || attr.toUpperCase()}`;

function maOf(c) {
  const known = MA_ATTRIBUTES[c.attr];
  if (known) {
    const [attribute, userName, feature, preset, sub] = known;
    return { attribute, userName, feature, preset, sub: sub || attribute };
  }
  const feature = FEATURE[c.attr] || 'LPP_LOOK';
  const attribute = ownAttribute(c.attr);
  return { attribute, userName: c.name, feature, preset: PRESET_OF[feature], sub: attribute };
}

export function ma2Name(kind, mode) {
  return `${MANUFACTURER}@${FIXTURES[kind].name.replace(/\s+/g, '_')}@${mode}.xml`.toLowerCase();
}

const pct = (v, top) => Number(((v / top) * 100).toFixed(3));
/* A step's physical range is its DMX range; a level's is 0 to 1. */
const physical = (c) => (c.role === 'dimmer' || c.role === 'value' ? [0, 1] : [0, 255]);

/** One fixture type in one mode, as MA2's XML (BOM included). */
export function ma2Xml(kind, mode, { version = '1' } = {}) {
  const ft = FIXTURES[kind];
  const channels = ft.modes[mode];
  if (!channels) throw new Error(`no mode ${mode} on ${kind}`);
  const label = (MODES.find((m) => m.id === mode) || { label: mode }).label;
  const out = [];
  out.push('<?xml version="1.0" encoding="utf-8"?>');
  out.push('<MA xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://schemas.malighting.de/grandma2/xml/MA"'
    + ` xsi:schemaLocation="http://schemas.malighting.de/grandma2/xml/MA http://schemas.malighting.de/grandma2/xml/${SCHEMA}/MA.xsd"`
    + ` major_vers="3" minor_vers="9" stream_vers="60">`);
  out.push(`\t<Info datetime="${DATETIME}" showfile="LivePremier Plus ${x(version)}" />`);
  out.push(`\t<FixtureType index="1" name="${x(ft.name)}" mode="${x(label)}">`);
  out.push(`\t\t<short_name>${x(ft.short)}</short_name>`);
  out.push(`\t\t<manufacturer>${MANUFACTURER}</manufacturer>`);
  out.push(`\t\t<short_manufacturer>${MANUFACTURER}</short_manufacturer>`);
  out.push('\t\t<Modules index="0">');
  out.push('\t\t\t<Module index="0" name="Main Module" class="None" beamtype="None" beam_angle="30" beam_intensity="10000">');
  let coarse = 1;
  channels.forEach((c, index) => {
    const m = maOf(c);
    const wide = c.bits === 16;
    const top = wide ? 65535 : 255;
    const snap = c.role !== 'dimmer' && c.role !== 'value';
    /* MA's default is in 8-bit steps whatever the resolution. */
    const def = Number(((c.default || 0) / (wide ? 256 : 1)).toFixed(3));
    out.push(`\t\t\t\t<ChannelType index="${index}" attribute="${m.attribute}" feature="${m.feature}" preset="${m.preset}"`
      + ` coarse="${coarse}"${wide ? ` fine="${coarse + 1}"` : ''} default="${def}"`
      + `${snap ? ' snap="true"' : ''}${c.role === 'dimmer' ? ' react_to_master="1"' : ''}`
      + `${COLOUR[c.attr] ? ` color="${COLOUR[c.attr]}"` : ''}>`);
    const names = `subattribute="${m.sub}" subattribute_user_name="${x(m.userName)}" attribute="${m.attribute}" attribute_user_name="${x(m.userName)}"`
      + ` feature="${m.feature}" feature_user_name="${USER_NAME[m.feature]}" preset="${m.preset}" preset_user_name="${USER_NAME[m.preset]}"`;
    if (wide) {
      /* 16-bit: a function per range, each in its own physical units. No sets: their DMX would be 8-bit. */
      const [lo, hi] = c.physical || [0, top];
      const at = (v) => Number((lo + (v * (hi - lo)) / top).toFixed(3));
      c.sets.forEach((set, i) => {
        out.push(`\t\t\t\t\t<ChannelFunction index="${i}"${c.sets.length > 1 ? ` name="${x(set.name)}"` : ''}`
          + ` from="${pct(set.from, top + 1)}" to="${set.to === top ? 100 : pct(set.to + 1, top + 1)}"`
          + ` min_dmx_24="${set.from * 256}" max_dmx_24="${set.to * 256 + 255}" physfrom="${at(set.from)}" physto="${at(set.to)}" ${names} />`);
      });
    } else {
      const [pf, pt] = physical(c);
      const whole = c.sets.length === 1 && c.sets[0].from === 0 && c.sets[0].to === top;
      out.push(`\t\t\t\t\t<ChannelFunction index="0" from="0" to="100" min_dmx_24="0" max_dmx_24="16777215"`
        + ` physfrom="${pf}" physto="${pt}" ${names}${whole ? ' />' : '>'}`);
      if (!whole) {
        c.sets.forEach((set, i) => {
          out.push(`\t\t\t\t\t\t<ChannelSet index="${i}" name="${x(set.name)}" from_dmx="${set.from}" to_dmx="${set.to}" />`);
        });
        out.push('\t\t\t\t\t</ChannelFunction>');
      }
    }
    out.push('\t\t\t\t</ChannelType>');
    coarse += wide ? 2 : 1;
  });
  out.push('\t\t\t</Module>');
  out.push('\t\t</Modules>');
  out.push('\t\t<Instances index="1">');
  out.push('\t\t\t<Instance index="0" module_index="0" />');
  out.push('\t\t</Instances>');
  out.push('\t\t<Wheels index="2" />');
  out.push('\t\t<VirtualFunctionBlocks index="3" />');
  out.push('\t\t<FixtureMacroCollect index="5" />');
  out.push('\t\t<Body />');
  out.push('\t\t<AutoPresets index="4" />');
  out.push('\t</FixtureType>');
  out.push('</MA>');
  return '\uFEFF' + out.join('\n') + '\n';
}

/** Every fixture type in every mode, as one zip for the card's download. */
export function ma2Zip({ version = '1' } = {}) {
  const files = [];
  for (const [kind, ft] of Object.entries(FIXTURES)) {
    for (const mode of Object.keys(ft.modes)) files.push({ name: ma2Name(kind, mode), data: ma2Xml(kind, mode, { version }) });
  }
  return zipStore(files, { date: ZIP_DATE });
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
