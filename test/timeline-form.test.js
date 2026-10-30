/*
 * The Timeline's two forms keep what was typed across a repaint.
 *
 * The panel repaints on every frame the switcher sends, and `keep-focus.js`
 * carries over only the field that has focus. On an Aquilon C mini
 * (2026-10-30), whose timers send a frame a second, a cue typed as slot 990,
 * take, 2 s was back to slot 1, no take, no fade by the time Add was pressed:
 * every field the operator had moved on from was redrawn from its default.
 * The simulator's timers do not run, so nothing there repainted often enough
 * to show it. Each test here types, repaints, and checks the new DOM and then
 * what Add or Save actually stored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import { CueStack, ACTION_KINDS } from '../src/core/cuestack.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

function simulatorStore() {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  const s = new DeviceStore();
  s.hydrate(['sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json']
    .map(fixture).reduce(merge, {}));
  /* The capture has S1 alone in use; the C mini had S1 and S2, and a second
     target is what an unticked box needs to be told apart from the first. */
  s.set(['device', 'screenAuxGroupList', 'items', 'S2', 'status', 'pp', 'isUsed'], true);
  return s;
}

async function withPanel(fn) {
  const dom = install();
  try {
    const store = simulatorStore();
    const session = new EventTarget();
    session.store = store;
    session.state = 'live';
    session.send = () => true;
    const { createTimelinePanel } = await import('../plugins/timeline/panel.js');
    const stack = new CueStack({ send: () => true });
    const panel = createTimelinePanel({
      session, stack, storage: { load: async () => null, save: async () => {} }, onRefresh() {}
    });
    await fn({ panel, stack });
  } finally {
    dom.uninstall();
  }
}

const press = (root, title) => {
  const b = root.querySelectorAll('button').find((x) => x.getAttribute('title') === title);
  assert.ok(b, `a ${title} button`);
  b.click();
};
const type = (el, text) => { el.value = text; el.dispatchEvent({ type: 'input' }); };
const pick = (el, value) => { el.value = value; el.dispatchEvent({ type: 'change' }); };
const tick = (el, on) => { el.checked = on; el.dispatchEvent({ type: 'change' }); };

/** The New cue form's controls, in the order the form draws them. */
function newCueFields(root) {
  const selects = root.querySelectorAll('select');
  const inputs = root.querySelectorAll('input');
  return {
    kind: selects[0], mode: selects[1], take: selects[2],
    slot: inputs.find((i) => i.getAttribute('type') === 'number' && i.getAttribute('min') === '1'),
    fade: inputs.find((i) => i.getAttribute('placeholder') === 's'),
    label: inputs.find((i) => i.getAttribute('placeholder') === 'Cue label'),
    boxes: inputs.filter((i) => i.getAttribute('type') === 'checkbox' && /^[SA]\d+$/.test(i.getAttribute('value') || ''))
  };
}

test('New cue keeps slot, take, fade, label and targets across a repaint', async () => {
  await withPanel(async ({ panel, stack }) => {
    press(panel.render(), 'Add cue');
    const f = newCueFields(panel.render());
    assert.ok(f.boxes.length >= 2, 'the simulator store has at least two destinations in use');
    const dropped = f.boxes[1].getAttribute('value');

    type(f.slot, '990');
    pick(f.take, ACTION_KINDS.TAKE);
    type(f.fade, '2');
    type(f.label, 'hw GO');
    tick(f.boxes[1], false);

    const again = panel.render();
    const g = newCueFields(again);
    assert.equal(g.slot.value, '990', 'slot redrawn as typed, not as 1');
    assert.equal(g.take.value, ACTION_KINDS.TAKE, 'take redrawn as picked');
    assert.equal(g.fade.value, '2');
    assert.equal(g.label.value, 'hw GO');
    /* The attribute, which is what a freshly drawn box starts from in a
       browser; the stand-in DOM does not derive `checked` from it. */
    assert.equal(g.boxes[1].getAttribute('checked'), null, 'an unticked target stays unticked');
    assert.equal(g.boxes[0].getAttribute('checked'), 'checked');

    press(again, 'Add');
    assert.equal(stack.cues.length, 1);
    const [cue] = stack.cues;
    assert.equal(cue.label, 'hw GO');
    assert.equal(cue.fade, 2);
    assert.equal(cue.actions[0].slot, 990);
    assert.ok(!cue.actions[0].targets.includes(dropped), 'the unticked target is not recalled');
    assert.deepEqual(cue.actions[1].kind, ACTION_KINDS.TAKE);
    assert.ok(!cue.actions[1].targets.includes(dropped), 'nor taken');

    press(panel.render(), 'Add cue');
    assert.equal(newCueFields(panel.render()).slot.value, '1', 'the next New cue starts from the defaults again');
  });
});

test('Cancel throws the New cue draft away', async () => {
  await withPanel(async ({ panel }) => {
    press(panel.render(), 'Add cue');
    type(newCueFields(panel.render()).slot, '42');
    press(panel.render(), 'Cancel');
    press(panel.render(), 'Add cue');
    assert.equal(newCueFields(panel.render()).slot.value, '1');
  });
});

test('a cue being edited in its row keeps what was typed across a repaint', async () => {
  await withPanel(async ({ panel, stack }) => {
    stack.add({ number: '1', label: 'Walk-in', fade: 1, actions: [{ kind: ACTION_KINDS.TAKE, targets: ['S1'] }] });
    press(panel.render(), 'Edit');
    const row = () => panel.render().querySelectorAll('tr').find((tr) => tr.querySelectorAll('input').length > 3);
    const label = (r) => r.querySelectorAll('input').find((i) => i.className === 'wru-input');
    const numbers = (r) => r.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'number');

    type(label(row()), 'Walk-out');
    type(numbers(row())[0], '3.5');

    const r = row();
    assert.equal(label(r).value, 'Walk-out', 'label redrawn as typed');
    assert.equal(numbers(r)[0].value, '3.5', 'fade redrawn as typed');

    press(r, 'Save');
    assert.equal(stack.cues[0].label, 'Walk-out');
    assert.equal(stack.cues[0].fade, 3.5);
  });
});
