/*
 * `npm test` cannot reach a switcher — `helpers/offline.js`, held to what it
 * says.
 *
 * Until 2026-10-17 the suite's "no network" was a description, and one test
 * broke it every run: the OSC take test asked 127.0.0.1:10606, and a
 * simulator on the same machine took S1. Here the guard is checked to be
 * loaded for every file, to refuse the port that test reached by the route
 * it reached it, to leave a test's own pretend device alone, and to fail the
 * file that dialled.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refused, KIT_PORTS } from './helpers/offline.js';
import { exchange, AWJ_PORT } from '../server/awj.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('npm test loads the guard into every file it runs', async () => {
  const { scripts } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
  assert.match(scripts.test, /^node --import \.\/test\/helpers\/offline\.js --test /);
});

test('an AWJ exchange at the real port is refused before anything is sent', async () => {
  assert.ok(KIT_PORTS.has(AWJ_PORT));
  const before = refused.length;
  try {
    for (const host of ['127.0.0.1', 'localhost', '192.0.2.1']) {
      await assert.rejects(
        exchange({ host, messages: [{ op: 'replace', path: 'DeviceObject/$screenAuxGroup/@items/S1/control/@props/xTake', value: true }] }),
        /the offline suite refused .*:10606 \(AWJ/);
    }
    assert.deepEqual(refused.slice(before).map((a) => `${a.host}:${a.port}`),
      ['127.0.0.1:10606', 'localhost:10606', '192.0.2.1:10606']);
  } finally {
    /* Refused on purpose, so not a failure of this file. */
    refused.splice(before);
  }
});

test('a pretend device on a port of its own is reached as usual', async () => {
  const server = net.createServer((s) => s.end('hello'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const said = await new Promise((resolve, reject) => {
      const s = net.connect({ host: '127.0.0.1', port: server.address().port });
      let text = '';
      s.on('data', (d) => { text += d; });
      s.on('end', () => resolve(text));
      s.on('error', reject);
    });
    assert.equal(said, 'hello');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a file that dials a switcher fails, with the stack that dialled', async () => {
  const script = "require('node:net').connect(10606, '127.0.0.1').on('error', () => {})";
  const { code, stderr } = await new Promise((resolve) => {
    execFile(process.execPath, ['--import', './test/helpers/offline.js', '-e', script], { cwd: ROOT },
      (err, _stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }));
  });
  assert.equal(code, 1);
  assert.match(stderr, /a test dialled 127\.0\.0\.1:10606, AWJ on a switcher or simulator\. Refused\./);
  assert.match(stderr, /dialled from/);
});
