/*
 * The portable configuration file.
 *
 * The properties worth pinning are not "does JSON round-trip" — they are the
 * three judgements `server/config-file.js` makes, each of which would be easy
 * to undo by accident:
 *
 *  1. **An absent section is not an empty one.** "This export had no patch"
 *     must stay distinguishable from "this export had an empty patch", or a
 *     restore wipes a cable schedule it was never asked to touch.
 *  2. **`settings` is not in the default import.** It carries the OSC port and
 *     bind address, so applying it can close a port a lighting desk is sending
 *     to. Someone tidying `DEFAULT_IMPORT` into "all of them" should fail here.
 *  3. **Device-keyed sections land under the key they are given**, not the one
 *     they were exported from — that is what makes a restore onto a backup
 *     frame work at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { StackStore } from '../server/storage.js';
import {
  buildConfig, applyConfig, summarise, validate, sectionsIn, isEmpty,
  FORMAT, VERSION, SECTIONS, DEFAULT_IMPORT
} from '../server/config-file.js';

const DEV = '192.168.2.140:80';

async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'lpp-config-'));
  return { dir, store: new StackStore(dir), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A store with something in every section. */
async function furnished(deviceKey = DEV) {
  const s = await store();
  await s.store.saveSettings({ consoleLanguage: 'all', oscPort: 8000, oscBind: '127.0.0.1' });
  await s.store.saveMatrices([{ id: 'm1', kind: 'videohub', host: '10.0.0.5' }]);
  await s.store.save(deviceKey, { version: 1, name: 'Act One', cues: [{ n: 1 }, { n: 2 }] });
  await s.store.saveGroups(deviceKey, { version: 1, groups: { g1: { members: ['S1/1'] } } });
  await s.store.saveNames(deviceKey, { version: 1, names: { 'S1/1': 'Keynote' } });
  await s.store.savePatch(deviceKey, [{ from: 'IN_1', to: 'm1/3' }]);
  return s;
}

test('an export carries every section, filed under the right group', async () => {
  const s = await furnished();
  try {
    const doc = await buildConfig({ storage: s.store, deviceKey: DEV, appVersion: '0.9.0' });

    assert.equal(doc.format, FORMAT);
    assert.equal(doc.version, VERSION);
    assert.equal(doc.device.address, DEV);
    assert.equal(doc.app.version, '0.9.0');

    // Each section sits in the group storage.js files it under.
    assert.ok(doc.installation.settings, 'settings are installation-level');
    assert.ok(doc.installation.matrices, 'routers are installation-level');
    assert.ok(doc.show.stack, 'the cue stack is show-level');
    assert.ok(doc.show.groups);
    assert.ok(doc.show.names);
    assert.ok(doc.rig.patch, 'the patch is rig-level');
    assert.deepEqual(sectionsIn(doc).sort(), Object.keys(SECTIONS).sort());
  } finally {
    await s.cleanup();
  }
});

test('a section with nothing in it is left out, not written as empty', async () => {
  const s = await store();
  try {
    const doc = await buildConfig({ storage: s.store, deviceKey: DEV });
    assert.deepEqual(sectionsIn(doc), [], 'an untouched install exports no sections');
    assert.ok(isEmpty(doc));
    assert.equal('patch' in doc.rig, false, 'absent, not null — a restore must not read this as "wipe it"');
  } finally {
    await s.cleanup();
  }
});

test('the default import leaves app settings alone', async () => {
  // The OSC port lives in settings; a restore must not re-plumb this machine.
  assert.equal(DEFAULT_IMPORT.includes('settings'), false);
  assert.ok(DEFAULT_IMPORT.includes('stack'));
  assert.ok(DEFAULT_IMPORT.includes('groups'));
  assert.ok(DEFAULT_IMPORT.includes('names'));
  assert.ok(DEFAULT_IMPORT.includes('patch'));
});

test('an import applies the default sections and reports the rest as skipped', async () => {
  const src = await furnished();
  const dst = await store();
  try {
    const doc = await buildConfig({ storage: src.store, deviceKey: DEV });
    const report = await applyConfig({ storage: dst.store, deviceKey: DEV, doc });

    assert.deepEqual(report.applied.sort(), ['groups', 'matrices', 'names', 'patch', 'stack']);
    assert.deepEqual(report.skipped, ['settings'], 'present in the file, deliberately not applied');
    assert.equal(report.remapped, false);

    assert.deepEqual(await dst.store.load(DEV), await src.store.load(DEV));
    assert.deepEqual(await dst.store.loadNames(DEV), await src.store.loadNames(DEV));
    assert.deepEqual(await dst.store.loadSettings(), {}, 'settings untouched');
  } finally {
    await src.cleanup();
    await dst.cleanup();
  }
});

test('settings are applied only when asked, and merged rather than replaced', async () => {
  const src = await furnished();
  const dst = await store();
  try {
    await dst.store.saveSettings({ oscPort: 9999, somethingThisBuildKnows: true });
    const doc = await buildConfig({ storage: src.store, deviceKey: DEV });
    const report = await applyConfig({ storage: dst.store, deviceKey: DEV, doc, sections: ['settings'] });

    assert.deepEqual(report.applied, ['settings']);
    const out = await dst.store.loadSettings();
    assert.equal(out.oscPort, 8000, 'the imported value wins');
    assert.equal(out.somethingThisBuildKnows, true, 'a key the export predates survives');
  } finally {
    await src.cleanup();
    await dst.cleanup();
  }
});

test('a restore onto a different frame re-keys the device sections', async () => {
  const src = await furnished();
  const dst = await store();
  const BACKUP = '192.168.2.141:80';
  try {
    const doc = await buildConfig({ storage: src.store, deviceKey: DEV });
    const report = await applyConfig({ storage: dst.store, deviceKey: BACKUP, doc });

    assert.equal(report.remapped, true, 'the report says the show moved frames');
    assert.deepEqual((await dst.store.load(BACKUP)).cues.length, 2, 'the stack landed on the backup frame');
    assert.equal(await dst.store.load(DEV), null, 'and not under the address it came from');
  } finally {
    await src.cleanup();
    await dst.cleanup();
  }
});

test('the file names the device it was written against', async () => {
  const s = await furnished();
  try {
    const doc = await buildConfig({ storage: s.store, deviceKey: DEV });
    // Without this an importer cannot tell it is remapping, only that it is writing.
    assert.equal(doc.device.address, DEV);
  } finally {
    await s.cleanup();
  }
});

test('validate refuses what is not ours', async () => {
  assert.match(validate(null), /not a JSON object/);
  assert.match(validate({ format: 'something/else', version: 1 }), /not a LivePremier Plus configuration/);
  assert.match(validate({ format: FORMAT }), /no version/);
  assert.match(validate({ format: FORMAT, version: VERSION + 5 }), /newer LivePremier Plus/);
  assert.match(validate({ format: FORMAT, version: VERSION }), /empty/);
});

test('an empty configuration is refused rather than silently applied', async () => {
  const dst = await store();
  try {
    await assert.rejects(
      () => applyConfig({ storage: dst.store, deviceKey: DEV, doc: { format: FORMAT, version: VERSION } }),
      /empty/
    );
  } finally {
    await dst.cleanup();
  }
});

test('the summary counts without claiming to understand a cue', async () => {
  const s = await furnished();
  try {
    const sum = summarise(await buildConfig({ storage: s.store, deviceKey: DEV, appVersion: '0.9.0' }));
    assert.equal(sum.cues, 2);
    assert.equal(sum.stackName, 'Act One');
    assert.equal(sum.groups, 1);
    assert.equal(sum.names, 1);
    assert.equal(sum.patchEntries, 1);
    assert.equal(sum.matrices, 1);
    assert.equal(sum.hasSettings, true);
    assert.equal(sum.device, DEV);
  } finally {
    await s.cleanup();
  }
});

test('a section this build does not know about survives a round trip', async () => {
  // The envelope is ours; the contents are not. A cue that grows a field must
  // come back with it.
  const src = await furnished();
  const dst = await store();
  try {
    await src.store.save(DEV, { version: 1, name: 'Act One', cues: [{ n: 1, somethingNew: { deep: [1, 2] } }] });
    const doc = await buildConfig({ storage: src.store, deviceKey: DEV });
    const text = JSON.stringify(doc);
    await applyConfig({ storage: dst.store, deviceKey: DEV, doc: JSON.parse(text) });
    assert.deepEqual((await dst.store.load(DEV)).cues[0].somethingNew, { deep: [1, 2] });
  } finally {
    await src.cleanup();
    await dst.cleanup();
  }
});

test('an export is written as a file anyone can read', async () => {
  const s = await furnished();
  try {
    const doc = await buildConfig({ storage: s.store, deviceKey: DEV });
    const file = join(s.dir, 'livepremier-plus.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(file, JSON.stringify(doc, null, 2), 'utf8');
    const back = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(validate(back), null);
    assert.deepEqual(back, doc);
  } finally {
    await s.cleanup();
  }
});
