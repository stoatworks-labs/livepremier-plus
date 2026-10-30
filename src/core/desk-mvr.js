/*
 * The desk's patch as an MVR file — no I/O.
 *
 * MVR (My Virtual Rig, DIN SPEC 15800; 1.6 here) is the patch a desk can
 * import rather than have typed in: grandMA3 imports it, as do MagicQ,
 * Vectorworks and Capture. Titan has no MVR at all, and takes the CSV. An
 * `.mvr` is a zip holding `GeneralSceneDescription.xml` and the GDTF files it
 * names, so a desk that has never seen these fixture types gets them with the
 * patch.
 *
 * What it says, per fixture: the GDTF file and DMX mode (the mode's name is
 * the DMXMode's own, `desk-gdtf.js`), the absolute DMX address, Art-Net or
 * sACN as the protocol, and a fixture ID.
 *
 * - **Fixture IDs follow the switcher, not the patch order**: the Master is 1,
 *   screen Sn is n×100 and its layers n×100 + 1…, aux An 5000 + n×100. Adding
 *   a layer or a screen then renumbers nothing that was already patched.
 * - **UUIDs are the same every time** for the same fixture on the same
 *   switcher, so a second import updates the first rather than doubling it.
 *   They are made from the host and the fixture's id, not drawn at random.
 * - **One MVR layer per screen**, holding its Screen fixture and its layers;
 *   the Master sits in a layer of its own. A desk that shows MVR layers (MA3's
 *   patch does) then groups them as the switcher does.
 * - **Positions are a tidy row**, a metre and a bit apart, layers stacked
 *   above their screen. A video layer has no place on a stage; this only
 *   keeps them from landing on top of one another in a 3D view.
 */

import { FIXTURES, MODES } from './dmx-personality.js';
import { gdtfFile, gdtfName } from './desk-gdtf.js';
import { zipStore, crc32 } from './zip.js';

export const MVR_VERSION = Object.freeze({ major: 1, minor: 6 });
export const PROVIDER = 'LivePremier Plus';
const ZIP_DATE = new Date(2026, 9, 30, 0, 0, 0);

const SCREEN_SPACING_MM = 1500;
const LAYER_SPACING_MM = 250;

/** A fixture's ID on the desk: see the head of this file. */
export function fixtureNumber(fixture) {
  if (fixture.kind === 'master') return 1;
  const m = /^([SA])(\d+)$/.exec(String(fixture.destination || ''));
  if (!m) return null;
  const base = (m[1] === 'A' ? 5000 : 0) + Number(m[2]) * 100;
  return fixture.kind === 'layer' ? base + Number(fixture.layer) : base;
}

/**
 * A UUID that is always the same for the same parts: four CRC-32s of the key,
 * each salted, with the version (8, RFC 9562's own-scheme) and variant set.
 * Not cryptographic, nor meant to be; unique enough for one rig's fixtures.
 */
export function stableUuid(...parts) {
  const key = parts.map(String).join('\u0000');
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 4; i++) view.setUint32(i * 4, crc32(new TextEncoder().encode(`${i}\u0000${key}`)));
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** MVR's absolute address: universe 1 address 1 is 1, universe 2 address 1 is 513. */
export const absoluteAddress = (universe, address) => (universe - 1) * 512 + address;

const PROTOCOL_TYPES = { artnet: ['Art-Net'], sacn: ['sACN'], both: ['Art-Net', 'sACN'] };

/**
 * `GeneralSceneDescription.xml` for a patch (`layout()`'s fixtures).
 *
 * @param {object[]} fixtures
 * @param {object} o
 * @param {string} o.version          the GDTF files' revision (`GDTF_VERSION`)
 * @param {string} [o.host]           the switcher, which the UUIDs are made from
 * @param {string} [o.providerVersion] this app's version
 * @param {'both'|'artnet'|'sacn'} [o.protocol]
 */
export function sceneXml(fixtures, { version, host = '', providerVersion = '', protocol = 'both' }) {
  const groups = new Map();
  for (const f of fixtures) {
    const key = f.destination || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const columns = [...groups.keys()].filter(Boolean);
  const protocols = PROTOCOL_TYPES[protocol] || PROTOCOL_TYPES.both;

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(`<GeneralSceneDescription verMajor="${MVR_VERSION.major}" verMinor="${MVR_VERSION.minor}"`
    + ` provider="${x(PROVIDER)}" providerVersion="${x(providerVersion)}">`);
  out.push('  <Scene>');
  out.push('    <Layers>');
  for (const [destination, list] of groups) {
    /* The Screen fixture is already named for the screen, "S1 Main". */
    const name = destination ? (list.find((f) => f.kind === 'screen') || { name: destination }).name : PROVIDER;
    out.push(`      <Layer uuid="${stableUuid(host, 'layer', destination || 'master')}" name="${x(name)}">`);
    out.push('        <ChildList>');
    const column = destination ? columns.indexOf(destination) : -1;
    for (const f of list) {
      const number = fixtureNumber(f);
      const mode = (MODES.find((m) => m.id === f.mode) || { label: f.mode }).label;
      const z = f.kind === 'layer' ? Number(f.layer) * LAYER_SPACING_MM : 0;
      out.push(`          <Fixture uuid="${stableUuid(host, 'fixture', f.id)}" name="${x(f.name)}">`);
      out.push(`            <Matrix>{1,0,0}{0,1,0}{0,0,1}{${column * SCREEN_SPACING_MM},0,${z}}</Matrix>`);
      out.push(`            <GDTFSpec>${x(gdtfName(f.kind, version))}</GDTFSpec>`);
      out.push(`            <GDTFMode>${x(mode)}</GDTFMode>`);
      out.push(`            <FixtureID>${number ?? ''}</FixtureID>`);
      if (number !== null) out.push(`            <FixtureIDNumeric>${number}</FixtureIDNumeric>`);
      out.push(`            <UnitNumber>${f.kind === 'layer' ? Number(f.layer) : 0}</UnitNumber>`);
      out.push('            <Addresses>');
      out.push(`              <Address break="0">${absoluteAddress(f.universe, f.address)}</Address>`);
      out.push('            </Addresses>');
      out.push('            <Protocols>');
      for (const type of protocols) out.push(`              <Protocol type="${type}"/>`);
      out.push('            </Protocols>');
      out.push('          </Fixture>');
    }
    out.push('        </ChildList>');
    out.push('      </Layer>');
  }
  out.push('    </Layers>');
  out.push('  </Scene>');
  out.push('</GeneralSceneDescription>');
  return out.join('\n') + '\n';
}

/** The `.mvr`: the scene and every GDTF file it names, at the archive's root. */
export function mvrFile(fixtures, options) {
  const kinds = [...new Set(fixtures.map((f) => f.kind))].filter((k) => FIXTURES[k]);
  return zipStore([
    { name: 'GeneralSceneDescription.xml', data: sceneXml(fixtures, options) },
    ...kinds.map((kind) => ({ name: gdtfName(kind, options.version), data: gdtfFile(kind, { version: options.version }) })),
  ], { date: ZIP_DATE });
}

const x = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
