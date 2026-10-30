/*
 * A plugin switch on the settings page sends that switch and nothing else.
 *
 * The page reads the settings once, when it opens. It used to send its copy of
 * every plugin's entry with each switch, so a setting a plugin's own card had
 * changed since then was sent back as it had been: on an Aquilon C mini
 * (2026-10-30), Listen for OSC was switched on, then UMD Generator was switched
 * on from the same page, and OSC stopped listening.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';

test('switching a plugin restates no other plugin', async () => {
  const dom = install();
  const before = globalThis.fetch;
  const sent = [];
  const loaded = {
    plugins: {
      'osc-input': { enabled: true, settings: { oscEnabled: false, oscPort: 8000 } },
      'pixel-map': { enabled: true }
    }
  };
  globalThis.fetch = async (url, init = {}) => {
    if (url === '/__lpp/status') return { ok: true, json: async () => ({ settings: loaded }) };
    if (url === '/__lpp/plugins') return { ok: true, json: async () => ({ plugins: [] }) };
    if (url === '/__lpp/settings' && init.method === 'PUT') {
      sent.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ settings: loaded }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  try {
    const { createSettingsPanel } = await import('../src/ui/settings-panel.js');
    const session = new EventTarget();
    session.store = new DeviceStore();
    session.state = 'live';
    const panel = createSettingsPanel({ session, onRefresh() {}, sections: () => [] });
    panel.render();
    /* The status and plugin list load in the background; let them land. */
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    const root = panel.render();
    const row = root.querySelectorAll('label').find((l) => l.textContent.startsWith('Pixel Map'));
    assert.ok(row, 'a Pixel Map switch');
    const box = row.querySelectorAll('input').find((i) => i.getAttribute('type') === 'checkbox');
    box.checked = false;
    box.dispatchEvent({ type: 'change' });
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    assert.equal(sent.length, 1, 'one save');
    assert.deepEqual(sent[0], { plugins: { 'pixel-map': { enabled: false } } },
      'the switch alone — not OSC input\'s settings as the page last saw them');
  } finally {
    globalThis.fetch = before;
    dom.uninstall();
  }
});
