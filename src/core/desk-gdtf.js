/*
 * The desk's fixture files, as GDTF 1.2 — no I/O.
 *
 * GDTF is the one format more than one desk reads: grandMA3 imports it
 * directly, MagicQ imports it (and saves a head file from it), and Titan's
 * Personality Builder converts it to a `.d4` since v17. grandMA2 needs MA's
 * own converter. So the fixture files are generated, from the one definition
 * in `core/dmx-personality.js`, rather than drawn by hand in three editors
 * that would drift apart.
 *
 * One file per fixture type (Master, Screen, Layer), each with a DMX mode per
 * mode of the personality. A `.gdtf` is a zip holding `description.xml`;
 * nothing else is required, and this adds nothing else.
 *
 * Attribute names: the opacity is GDTF's own `Dimmer`, and the source is
 * `MediaFolder1` / `MediaContent1`, the names media-server fixtures use, so a
 * desk files them where its operator expects. The control channels have no
 * GDTF name and get one of their own (`LPPControl` and so on) under the
 * Control feature; a desk that does not recognise a name still patches it as
 * a plain channel (MagicQ says so in its `gdtf.log`).
 *
 * ⚠️ Node links in GDTF are dot-separated names, so no name here may hold a
 * dot, and the channel names follow the 1.2 rule `<Geometry>_<Attribute>`.
 */

import { FIXTURES, MODES } from './dmx-personality.js';
import { zipStore } from './zip.js';

export const MANUFACTURER = 'Stoatworks';
const GEOMETRY = 'Base';
/* A fixed date, so the same definition always makes the same bytes. */
const REVISION_DATE = '2026-10-30T00:00:00';
const ZIP_DATE = new Date(2026, 9, 30, 0, 0, 0);

/* attr → [GDTF attribute, pretty, feature, physical unit]. */
const ATTRIBUTES = {
  control: ['LPPControl', 'Control', 'Control.Control', 'None'],
  memory: ['LPPMemory', 'Memory', 'Control.Control', 'None'],
  take: ['LPPTake', 'Take', 'Control.Control', 'None'],
  cut: ['LPPCut', 'Cut', 'Control.Control', 'None'],
  folder: ['MediaFolder1', 'Folder', 'Video.Video', 'None'],
  file: ['MediaContent1', 'File', 'Video.Video', 'None'],
  opacity: ['Dimmer', 'Dim', 'Dimmer.Dimmer', 'LuminousIntensity'],
};

const FEATURE_GROUPS = [
  ['Dimmer', 'Dimmer'],
  ['Video', 'Video'],
  ['Control', 'Control'],
];

/** The file name GDTF Share would give it: Manufacturer@Name@Revision. */
export function gdtfName(kind, version) {
  return `${MANUFACTURER}@${FIXTURES[kind].name.replace(/\s+/g, '_')}@v${version}.gdtf`;
}

/** `description.xml` for one fixture type. */
export function descriptionXml(kind, { version = '1' } = {}) {
  const ft = FIXTURES[kind];
  const used = new Set();
  for (const mode of Object.keys(ft.modes)) for (const c of ft.modes[mode]) used.add(c.attr);
  const attrs = [...used].map((a) => ATTRIBUTES[a]);
  const features = new Set(attrs.map((a) => a[2].split('.')[0]));

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push('<GDTF DataVersion="1.2">');
  out.push(`  <FixtureType Name="${x(ft.name)}" ShortName="${x(ft.short)}" LongName="LivePremier Plus ${x(ft.name.replace(/^LPP /, ''))}"`
    + ` Manufacturer="${MANUFACTURER}" Description="${x(ft.description)}" FixtureTypeID="${ft.guid}"`
    + ' Thumbnail="" RefFT="" CanHaveChildren="No">');
  out.push('    <AttributeDefinitions>');
  out.push('      <ActivationGroups/>');
  out.push('      <FeatureGroups>');
  for (const [name, pretty] of FEATURE_GROUPS.filter(([n]) => features.has(n))) {
    out.push(`        <FeatureGroup Name="${name}" Pretty="${pretty}">`);
    out.push(`          <Feature Name="${name}"/>`);
    out.push('        </FeatureGroup>');
  }
  out.push('      </FeatureGroups>');
  out.push('      <Attributes>');
  for (const [name, pretty, feature, unit] of attrs) {
    out.push(`        <Attribute Name="${name}" Pretty="${pretty}" Feature="${feature}" PhysicalUnit="${unit}"/>`);
  }
  out.push('      </Attributes>');
  out.push('    </AttributeDefinitions>');
  out.push('    <Wheels/>');
  out.push('    <PhysicalDescriptions/>');
  out.push('    <Models/>');
  out.push('    <Geometries>');
  out.push(`      <Geometry Name="${GEOMETRY}" Position="{1,0,0,0}{0,1,0,0}{0,0,1,0}{0,0,0,1}"/>`);
  out.push('    </Geometries>');
  out.push('    <DMXModes>');
  for (const [modeId, channels] of Object.entries(ft.modes)) {
    const label = (MODES.find((m) => m.id === modeId) || { label: modeId }).label;
    out.push(`      <DMXMode Name="${x(label)}" Geometry="${GEOMETRY}">`);
    out.push('        <DMXChannels>');
    let offset = 1;
    for (const c of channels) {
      const [attr] = ATTRIBUTES[c.attr];
      const bytes = c.bits === 16 ? 2 : 1;
      const offsets = bytes === 2 ? `${offset},${offset + 1}` : String(offset);
      const top = bytes === 2 ? 65535 : 255;
      out.push(`          <DMXChannel DMXBreak="1" Offset="${offsets}" InitialFunction="${GEOMETRY}_${attr}.${attr}.${attr}"`
        + ` Highlight="None" Geometry="${GEOMETRY}">`);
      const snap = c.role === 'dimmer' ? 'No' : 'Yes';
      out.push(`            <LogicalChannel Attribute="${attr}" Snap="${snap}" Master="${c.role === 'dimmer' ? 'Grand' : 'None'}"`
        + ' MibFade="0" DMXChangeTimeLimit="0">');
      out.push(`              <ChannelFunction Name="${attr}" Attribute="${attr}" OriginalAttribute="" DMXFrom="0/${bytes}"`
        + ` Default="0/${bytes}" PhysicalFrom="0" PhysicalTo="${c.role === 'dimmer' ? 1 : top}" RealFade="0" RealAcceleration="0">`);
      for (const set of c.sets) {
        out.push(`                <ChannelSet Name="${x(set.name)}" DMXFrom="${set.from}/${bytes}" WheelSlotIndex="0"/>`);
      }
      out.push('              </ChannelFunction>');
      out.push('            </LogicalChannel>');
      out.push('          </DMXChannel>');
      offset += bytes;
    }
    out.push('        </DMXChannels>');
    out.push('        <Relations/>');
    out.push('        <FTMacros/>');
    out.push('      </DMXMode>');
  }
  out.push('    </DMXModes>');
  out.push('    <Revisions>');
  out.push(`      <Revision Text="LivePremier Plus ${x(version)}" Date="${REVISION_DATE}" UserID="0" ModifiedBy="LivePremier Plus"/>`);
  out.push('    </Revisions>');
  out.push('    <FTPresets/>');
  out.push('    <Protocols/>');
  out.push('  </FixtureType>');
  out.push('</GDTF>');
  return out.join('\n') + '\n';
}

/** One `.gdtf` file: a zip with `description.xml` in it. */
export function gdtfFile(kind, { version = '1' } = {}) {
  return zipStore([{ name: 'description.xml', data: descriptionXml(kind, { version }) }], { date: ZIP_DATE });
}

export const FIXTURE_KINDS = Object.freeze(Object.keys(FIXTURES));

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
