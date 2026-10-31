/*
 * Every panel renders — against an empty store, which is how every panel
 * first renders before the switcher has answered, and against a store built
 * from the simulator's own captures.
 *
 * Found the hard way, 2026-09-23: the Timeline panel took an option called
 * `actions`, and a function of its own called `actions()` shadowed it, so the
 * first cue with a plugin's action in it threw on every render and left an
 * empty tab. Nothing caught it because nothing rendered the panel. The plugin
 * work is moving every panel into a folder of its own, which is exactly the
 * kind of change that breaks a render without breaking an import — so each
 * one is drawn here, twice (a first render, then a repaint), with the
 * dependencies `main.js` gives it.
 *
 * What this does not catch: anything that goes wrong only in a real browser —
 * layout, the vendor's stylesheet, a failed fetch's handler. It is a smoke
 * test, and the browser check is still the proof.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { install } from './helpers/fake-dom.js';
import { DeviceStore } from '../src/core/device-store.js';
import { CueStack } from '../src/core/cuestack.js';
import { detectPlatform } from '../src/core/platform.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));

/** Deep-merge the simulator's capture slices into one device store. */
function merged(...names) {
  const merge = (a, b) => {
    if (!a || typeof a !== 'object' || Array.isArray(a) || !b || typeof b !== 'object' || Array.isArray(b)) return b;
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  };
  return names.map(fixture).reduce(merge, {});
}

const STORES = {
  empty: () => new DeviceStore(),
  /* `sim-6.2.73-memory.json` was in this list until the Variables panel
     needed a real catalogue: it is a memory-export capture, not a store
     slice, and its top-level `device: "NLC_CMAX"` replaced the whole merged
     tree with a string — so every panel here drew an empty store twice. */
  simulator: () => {
    const s = new DeviceStore();
    s.hydrate(merged('sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
      'sim-6.2.73-connectors.json', 'sim-6.2.73-outputs.json', 'sim-6.2.73-resources.json'));
    return s;
  }
};

function sessionOver(store) {
  const session = new EventTarget();
  session.store = store;
  session.state = 'live';
  session.send = () => true;
  return session;
}

/* A fetch that answers nothing useful, as a launcher that has not started would. */
const quietFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

async function withDom(fn) {
  const dom = install();
  const before = globalThis.fetch;
  const setIntervalBefore = globalThis.setInterval;
  globalThis.fetch = quietFetch;
  /* A page half may start a clock the way a page would — the Edit page's
     snapshot refresh does — and a page is never closed here, so the clock
     must not be what keeps this process alive after the test. */
  globalThis.setInterval = (...a) => { const t = setIntervalBefore(...a); if (t && t.unref) t.unref(); return t; };
  try {
    await fn(dom);
  } finally {
    globalThis.fetch = before;
    globalThis.setInterval = setIntervalBefore;
    dom.uninstall();
  }
}

/** Render twice, and say which panel threw if one does. */
function renders(name, panel) {
  let first;
  assert.doesNotThrow(() => { first = panel.render(); }, `${name} threw on its first render`);
  assert.ok(first && typeof first === 'object', `${name} rendered nothing`);
  assert.doesNotThrow(() => panel.render(), `${name} threw on a repaint`);
  return first;
}

const noStorage = { load: async () => null, save: async () => {} };

/** Page halves that put nothing in the sidebar or on a strip. */
const DECORATIONS = new Set(['arithmetic', 'layer-names', 'send-to', 'edid-mosaic', 'edid-names', 'edid', 'aux-backgrounds', 'aoi-format', 'image-library', 'test-card', 'control']);

for (const [storeName, makeStore] of Object.entries(STORES)) {
  test(`every panel in src/ui renders against ${storeName === 'empty' ? 'an empty store' : 'the simulator’s store'}`, async () => {
    await withDom(async () => {
      const store = makeStore();
      const session = sessionOver(store);
      const platform = () => detectPlatform(store);

      const { createTimelinePanel } = await import('../plugins/timeline/panel.js');
      const { createPropertiesPanel } = await import('../src/ui/properties-panel.js');
      const { createSettingsPanel } = await import('../src/ui/settings-panel.js');

      const stack = new CueStack({ send: () => true });
      /* A plugin's action, one whose plugin is off, and a built-in one. */
      stack.add({
        number: '1', label: 'Mixed',
        actions: [
          { kind: 'matrixFeed', connector: 'input:IN_1', source: 3 },
          { kind: 'gone:away' },
          { kind: 'take', targets: ['S1'] }
        ]
      });
      const cueActions = () => [{ kind: 'matrixFeed', label: 'Route', describe: (a) => `route ${a.source}`, run() {} }];
      const timeline = createTimelinePanel({ session, stack, storage: noStorage, onRefresh() {}, cueActions });
      const drawn = renders('timeline', timeline);
      if (store.ready) {
        const cells = drawn.querySelectorAll('.wru-cue-actions').map((td) => td.textContent);
        assert.deepEqual(cells, ['route 3 · gone:away · take S1'], 'a plugin’s action in its own words, a missing one by name');
      } else {
        assert.match(drawn.textContent, /Waiting for the device store/, 'before the store arrives it says so, and lists nothing');
      }

      const names = () => ({});
      const properties = createPropertiesPanel({ session, onRefresh() {}, names, onRename: null });
      renders('properties', properties);
      renders('settings', createSettingsPanel({ session, platform, onRefresh() {}, sections: () => [] }));
    });
  });

  test(`every built-in plugin’s page half renders against ${storeName === 'empty' ? 'an empty store' : 'the simulator’s store'}`, async () => {
    await withDom(async () => {
      const store = makeStore();
      const session = sessionOver(store);
      const platform = () => detectPlatform(store);
      const { KIT } = await import('../src/ui/plugin-host.js');

      const { createVpuPanel } = await import('../plugins/vpu-map/panel.js');
      const { createPitchPanel } = await import('../plugins/pitch/panel.js');
      const { createCompanionPanel } = await import('../plugins/companion/panel.js');
      renders('vpu-map', createVpuPanel({ session, platform, onRefresh() {} }));
      renders('pitch', createPitchPanel({ session, onRefresh() {} }));
      renders('companion', createCompanionPanel({
        kit: KIT, url: (p) => `/__lpp/companion${p === '/' ? '' : p}`,
        settings: { get: () => ({}), set: async () => ({}) }, onRefresh() {}
      }));

      /* The page halves themselves, through a stand-in ctx: what each
         registers must render too. Every built-in with a page half is here —
         read off the manifests, so a plugin that moves cannot be missed. */
      const { BUILTINS } = await import('../src/core/plugins.js');
      const halves = BUILTINS.filter((b) => b.client).map((b) => b.id);
      assert.ok(halves.includes('console') && halves.includes('memories'), halves.join(', '));
      for (const id of halves) {
        const { default: activate } = await import(`../plugins/${id}/client.js`);
        const registered = [];
        const ctx = {
          id, session, platform, can: () => true, refresh() {}, kit: KIT,
          url: (p = '/') => `/__lpp/${id}${p === '/' ? '' : p}`,
          settings: { get: () => ({}), set: async () => ({}) },
          contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
          log: { info() {}, warn() {} },
          ui: {
            sidebar: (e) => registered.push(e), tab: (e) => registered.push(e),
            settingsSection: (e) => registered.push(e)
          }
        };
        await activate(ctx);
        /* Field arithmetic and the layer names decorate the vendor's own
           page, the names, Mosaic inputs and Plug names are services, and the
           Control API's only face is its routes: none of them registers an
           entry. */
        if (!DECORATIONS.has(id)) assert.ok(registered.length, `${id} registered nothing`);
        for (const entry of registered) renders(`${id}’s ${entry.id || 'entry'}`, entry);
      }
    });
  });
}

/*
 * On a Midra 4K the pages under Virtual RC400T have nowhere to hang, and
 * until 2026-10-16 the Plugins card still called MIDI Mapping and the Speed
 * Editor on. Now their rows carry the capability's own sentence. The Pixelhue
 * plugin keeps its card — driving a console works there — and its Mapping
 * page moves to the PLUS section rather than going missing: the entry under
 * Virtual RC400T declines, its PLUS twin is mounted and draws the page, and
 * the card says where it is. On a LivePremier, the other way round.
 */
test('on a Midra the Plugins card says why MIDI Mapping is missing, and Pixelhue Mapping is in PLUS', async () => {
  await withDom(async () => {
    const { supports, whyNot } = await import('../src/core/platform.js');
    const { manifestOf } = await import('../src/core/plugins.js');
    const { createSettingsPanel } = await import('../src/ui/settings-panel.js');
    const { KIT } = await import('../src/ui/plugin-host.js');
    const { default: activatePixelhue } = await import('../plugins/pixelhue/client.js');

    const pixelhueOn = async (store) => {
      const platform = () => detectPlatform(store);
      const registered = [];
      await activatePixelhue({
        id: 'pixelhue', session: sessionOver(store), platform, can: (cap) => supports(platform(), cap),
        refresh() {}, kit: KIT, url: (p = '/') => `/__lpp/pixelhue${p === '/' ? '' : p}`,
        /* On, so the card says where the Mapping page is. */
        settings: { get: () => ({ pixelhueEnabled: true }), set: async () => ({}) },
        contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
        log: { info() {}, warn() {} },
        ui: { sidebar: (e) => registered.push(e), tab: (e) => registered.push(e), settingsSection: (e) => registered.push(e) }
      });
      const entries = registered.filter((e) => e.label === 'Pixelhue Mapping');
      const anchored = registered.find((e) => e.id === 'pixelhue-map');
      const plus = registered.find((e) => e.id === 'pixelhue-map-plus');
      const card = registered.find((e) => e.id === 'pixelhue');
      return { entries, anchored, plus, text: renders('pixelhue card', card).textContent };
    };
    const missing = /not on this switcher/;
    const inPlus = /on the Pixelhue Mapping page, in the PLUS section of the sidebar/;
    const underRc400t = /on the Pixelhue Mapping page, under Virtual RC400T/;

    const midra = new DeviceStore();
    midra.hydrate(fixture('midra-3.2.29-pulse4k.json'));
    const platform = () => detectPlatform(midra);
    const why = whyNot(platform(), 'controlSurfaces');
    assert.ok(why, 'a Midra has no control surfaces to offer');
    const text = renders('settings', createSettingsPanel({
      session: sessionOver(midra), platform, onRefresh() {}, sections: () => []
    })).textContent;
    for (const id of ['midi', 'speed-editor']) {
      const m = manifestOf(id);
      assert.ok(text.includes(`${m.name}not on this switcher${m.description}${why}`),
        `${m.name}’s row says it is not here, and why`);
    }
    const ph = manifestOf('pixelhue');
    assert.ok(text.includes(`${ph.name}${ph.description}${ph.where}`), 'the Pixelhue panel is on, with no reason against it');

    const onMidra = await pixelhueOn(midra);
    assert.equal(onMidra.entries.length, 2, 'one page, two places to put it');
    assert.equal(onMidra.anchored.after, 'Virtual RC400T');
    assert.equal(onMidra.anchored.enabled(), false, 'the entry under Virtual RC400T declines');
    assert.equal(onMidra.plus.enabled(), true, 'its PLUS twin is mounted instead');
    assert.ok(!onMidra.plus.after && !onMidra.plus.submenuOf, 'in the PLUS section, anchored to nothing');
    assert.equal(onMidra.entries.filter((e) => e.enabled()).length, 1, 'exactly one of them');
    assert.match(renders('Pixelhue Mapping on a Midra', onMidra.plus).textContent, /Pick a control/);
    assert.doesNotMatch(onMidra.text, missing);
    assert.match(onMidra.text, inPlus);
    assert.doesNotMatch(onMidra.text, underRc400t);

    const onLivePremier = await pixelhueOn(STORES.simulator());
    assert.equal(onLivePremier.anchored.enabled(), true);
    assert.equal(onLivePremier.plus.enabled(), false);
    assert.match(onLivePremier.text, underRc400t);
    assert.doesNotMatch(onLivePremier.text, inPlus);
  });
});

/*
 * Every sidebar entry and tab draws a glyph, out of the sprite of each
 * switcher it is offered on. A `<use>` of an id the sprite lacks draws
 * nothing and says nothing, and the two families' sprites differ: until
 * 2026-10-16 Edit, Layer Groups and the Groups tab were blank on a Midra 4K.
 *
 * `sprite-ids.json` is the `<symbol>` ids in each simulator's web client,
 * read off its bundle; the Midra's matched `#__SVG_SPRITE_NODE__` on the
 * running page id for id. What is offered on a Midra is what the Pulse 4K's
 * store offers, and the Alta, the same platform with no store here, is held
 * to the same list. A LivePremier is offered everything.
 */
test('every sidebar entry and tab has a glyph in the sprite of each switcher it is offered on', async () => {
  await withDom(async () => {
    const { supports } = await import('../src/core/platform.js');
    const { BUILTINS, status } = await import('../src/core/plugins.js');
    const { KIT } = await import('../src/ui/plugin-host.js');
    const { spriteId } = await import('../src/ui/dom.js');

    const allOn = Object.fromEntries(BUILTINS.map((b) => [b.id, { enabled: true }]));
    const entriesOn = async (store, can) => {
      const entries = [];
      for (const b of BUILTINS.filter((m) => m.client && status(allOn, m.id, can).on)) {
        const { default: activate } = await import(`../plugins/${b.id}/client.js`);
        await activate({
          id: b.id, session: sessionOver(store), platform: () => detectPlatform(store), can, refresh() {}, kit: KIT,
          url: (p = '/') => `/__lpp/${b.id}${p === '/' ? '' : p}`,
          settings: { get: () => ({}), set: async () => ({}) },
          contribute() {}, contributions: () => [], provide() {}, use: () => null, share() {},
          log: { info() {}, warn() {} },
          ui: {
            sidebar: (e) => entries.push({ plugin: b.id, ...e }), tab: (e) => entries.push({ plugin: b.id, ...e }),
            settingsSection() {}
          }
        });
      }
      /* A flyout item carries no icon, and an entry that declines is not drawn. */
      return entries.filter((e) => !e.submenuOf && (!e.enabled || e.enabled()));
    };

    const midra = new DeviceStore();
    midra.hydrate(fixture('midra-3.2.29-pulse4k.json'));
    const onMng = await entriesOn(midra, (cap) => supports(detectPlatform(midra), cap));
    const onNlc = await entriesOn(STORES.simulator(), () => true);
    assert.ok(onMng.some((e) => e.id === 'edit') && onMng.some((e) => e.id === 'groups'), 'Edit and Layer Groups are offered on a Midra');

    const offered = {
      'livepremier-6.1.60': onNlc, 'livepremier-6.2.73': onNlc,
      'midra-3.2.29': onMng, 'alta-1.3.7': onMng
    };
    for (const [sprite, { ids }] of Object.entries(fixture('sprite-ids.json'))) {
      const has = new Set(ids);
      document.getElementById = (id) => (has.has(id) ? {} : null);
      const blank = offered[sprite]
        .filter((e) => !e.icon || !has.has(spriteId(e.icon)))
        .map((e) => `${e.plugin}: ${e.label} [${[].concat(e.icon || []).join(', ')}]`);
      assert.deepEqual(blank, [], `drawn blank on ${sprite}`);
    }
  });
});

/**
 * Every literal list of sprite ids in some source: what follows an `iconId:`,
 * an `icon(`, a `spriteId(` or an `…ICON =`, up to the end of that one
 * expression. A bracketed list is one set of candidates and a string on its
 * own another, so `locked ? ['locked-12'] : ['unlocked-12']` is two. An id
 * worked out at run time (`icon(tab.icon)`) has nothing literal and is left out.
 */
function glyphLists(src) {
  const out = [];
  for (const m of src.matchAll(/\biconId:|\bicon\(|\bspriteId\(|\b[A-Z_]*ICON\b\s*=(?!=)/g)) {
    let i = m.index + m[0].length;
    while (/\s/.test(src[i])) i++;
    const start = i;
    for (let depth = 0, quote = null; i < src.length; i++) {
      const c = src[i];
      if (quote) { if (c === quote && src[i - 1] !== '\\') quote = null; continue; }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) { if (depth-- === 0) break; }
      else if (depth === 0 && ',;\n'.includes(c)) break;
    }
    const expr = src.slice(start, i);
    const strings = (text) => [...text.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map((s) => s[1] ?? s[2]);
    const line = src.slice(0, m.index).split('\n').length;
    for (const list of expr.matchAll(/\[([^\]]*)\]/g)) out.push({ line, ids: strings(list[1]) });
    for (const id of strings(expr.replace(/\[[^\]]*\]/g, ''))) out.push({ line, ids: [id] });
  }
  return out.filter((l) => l.ids.length);
}

/*
 * And every glyph a panel draws inside itself — a button's `iconId`, an
 * `icon(…)`, a `spriteId(…)`, an `…ICON = […]` — read out of the source,
 * because a button is only drawn on the path that reaches it and no render
 * here reaches them all. Six were blank on 2026-10-16: Refresh and Add on a
 * Midra (`refresh-14`, `add-18` are LivePremier's), and Pitch's Confirm,
 * Layer Groups' Delete and Send to's close on every switcher, because
 * `check-14`, `trash-12` and `close-14` were never in any sprite.
 *
 * A list passes on a sprite if any id in it is there, as `spriteId` picks. A
 * plugin's folder is held to the sprites of the switchers it is offered on —
 * the Midra's store decides mng, as above — and `src/` to all four.
 */
test('every literal glyph a panel draws is in the sprite of each switcher it is offered on', async () => {
  const { supports } = await import('../src/core/platform.js');
  const { BUILTINS, status } = await import('../src/core/plugins.js');
  const sprites = fixture('sprite-ids.json');
  const everywhere = Object.keys(sprites);
  const livePremier = everywhere.filter((s) => s.startsWith('livepremier-'));

  const midra = new DeviceStore();
  midra.hydrate(fixture('midra-3.2.29-pulse4k.json'));
  const allOn = Object.fromEntries(BUILTINS.map((b) => [b.id, { enabled: true }]));
  const offeredOnMng = (id) => status(allOn, id, (cap) => supports(detectPlatform(midra), cap)).on;

  const root = join(here, '..');
  const walk = (dir) => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return p === join('src', 'vendor') ? [] : walk(p);
    return e.name.endsWith('.js') ? [p] : [];
  });

  const seen = [];
  const blank = [];
  for (const file of [...walk('src'), ...walk('plugins')]) {
    const plugin = file.startsWith('plugins') ? file.split(/[\\/]/)[1] : null;
    const on = plugin && BUILTINS.some((b) => b.id === plugin) && !offeredOnMng(plugin) ? livePremier : everywhere;
    for (const { line, ids } of glyphLists(readFileSync(join(root, file), 'utf8'))) {
      seen.push(`${file}:${line}`);
      const missing = on.filter((s) => !ids.some((id) => sprites[s].ids.includes(id)));
      if (missing.length) blank.push(`${file}:${line} [${ids.join(', ')}] on ${missing.join(', ')}`);
    }
  }
  assert.ok(seen.length > 20, `the scan found ${seen.length} glyph lists`);
  assert.ok(seen.some((s) => s.startsWith(join('plugins', 'layer-lock', 'panel.js'))), 'a glyph chosen by a ternary is seen');
  assert.deepEqual(blank, [], 'drawn blank');
});

/*
 * The Variables panel with something in it: the user's own — one that
 * evaluates, one over a system variable, two in a cycle — over the
 * simulator's catalogue, and a search. The page-half pass above draws it
 * with nothing loaded; this is the panel an operator actually looks at.
 */
test('the Variables panel draws definitions, a cycle and the catalogue', async () => {
  await withDom(async () => {
    const store = STORES.simulator();
    const { createVariables } = await import('../plugins/variables/service.js');
    const { createVariablesPanel } = await import('../plugins/variables/panel.js');
    const variables = createVariables({
      store: () => store,
      load: async () => ({ variables: [
        { id: 'g', name: 'gap', value: '40' },
        { id: 'h', name: 'half', value: '$S1.width / 2' },
        { id: 'a', name: 'a', value: '@b' },
        { id: 'b', name: 'b', value: '@a' }
      ] }),
      save: async () => {}
    });
    await variables.start();
    const panel = createVariablesPanel({ variables, session: sessionOver(store), onRefresh() {} });
    const root = renders('variables panel', panel);
    const text = root.textContent;
    const listed = (el) => el.querySelectorAll('button.lpp-var-copy').map((b) => b.textContent);
    assert.match(text, /Cycle: @a → @b → @a/);
    assert.match(text, /960/, '@half is half of S1');
    assert.ok(listed(root).includes('$S1.PGM.L1.x'), 'the catalogue lists an allocated layer');
    assert.ok(listed(root).includes('$S1.width'));
    assert.equal(root.querySelectorAll('input[data-lpp-key="var-value-h"]').length, 1, 'each definition is a keyed field');
    panel.view.filter = 'IN3';
    const narrowed = listed(renders('variables panel, searched', panel));
    assert.ok(narrowed.includes('$IN3.width'));
    assert.equal(narrowed.includes('$S1.width'), false);
  });
});

/*
 * The VPU Map with nothing to draw says what the device is.
 *
 * Found 2026-10-16: an Aquilon RS4 on 6.1.60, screens on air, reports the
 * simulator's mapping exactly — 32 scalers all off, no vpuMixerList — and the
 * panel told its operator the box was a simulator. The shape cannot tell
 * them apart; the device's own `isSimulated` can.
 */
test('the VPU Map’s empty state names a simulator as one and hardware as hardware', async () => {
  await withDom(async () => {
    const { createVpuPanel } = await import('../plugins/vpu-map/panel.js');
    const draw = (store, { platform = () => detectPlatform(store), which = 'current' } = {}) => {
      const panel = createVpuPanel({ session: sessionOver(store), platform, onRefresh() {} });
      panel.view.which = which;
      return renders('vpu-map', panel).textContent;
    };

    const sim = draw(STORES.simulator());
    assert.match(sim, /No VPU on this simulator/);
    assert.match(sim, /says it is a simulator.*32 scalers/);
    assert.match(sim, /AQUILON · NLC_CMAX · 6\.2\.73 · simulator/);

    const rs4 = () => {
      const s = new DeviceStore();
      s.hydrate(fixture('aquilon-rs4-6.1.60-resources.json'));
      return s;
    };
    for (const which of ['current', 'new']) {
      const hw = draw(rs4(), { which });
      assert.match(hw, /This firmware does not report its VPU allocation/, which);
      assert.match(hw, /AQUILON NLC_RS4 on firmware 6\.1\.60 reports 32 scalers/, which);
      assert.doesNotMatch(hw, /simulator/i, `${which}: hardware is never called a simulator`);
      /* No mixer map is not nothing to show: the screens' own figures follow. */
      assert.match(hw, /each screen’s share, below/, which);
      assert.match(hw, /S1FREESTYLE.*4K ×2/, which);
      assert.match(hw, /S3FREESTYLE.*DUAL/, which);
      assert.doesNotMatch(hw, /DISABLED/, `${which}: a DISABLED screen is left out`);
    }
    assert.doesNotMatch(draw(rs4()), /Room/, 'room is a staged figure');
    /* Every screen reports the same room: it is said once, as the box's. */
    const staged = draw(rs4(), { which: 'new' });
    assert.match(staged,
      /Room left on the box, shared by every screen: 15 DUAL · 7 4K · 3 5K \(with a mask: 7 DUAL · 3 4K · 0 5K\)/);
    assert.doesNotMatch(staged, /Room for/, 'no column repeating it on every row');
    /* Screens that disagree keep it screen by screen. */
    const apart = rs4();
    apart.set(['device', 'preconfig', 'resources', 'new', 'screenList', 'items', 'S3', 'layerCapabilityList',
      'items', 'DUAL', 'status', 'pp', 'remainingLayerCapabilities'], 14);
    const split = draw(apart, { which: 'new' });
    assert.match(split, /Room for/);
    assert.match(split, /S1FREESTYLE.*15 DUAL · 7 4K · 3 5K.*S3FREESTYLE.*14 DUAL · 7 4K · 3 5K/);
    assert.doesNotMatch(split, /Room left on the box/);

    /* No identity to go on: say what the mapping holds, and accuse nobody. */
    const unknown = draw(rs4(), { platform: null });
    assert.match(unknown, /No VPU allocation reported/);
    assert.doesNotMatch(unknown, /is a simulator|this simulator/i);
  });
});

/*
 * Renaming a memory opens its field without a repaint.
 *
 * Found 2026-09-30: clicking a name set `editing` and asked for a repaint, but
 * the page holds every repaint off while any panel says it is busy — and the
 * Memories panel is busy from the moment editing starts. The field never
 * appeared, and the page stopped repainting until it was reloaded. So the
 * refresh here is the page's own gate: it repaints nothing while busy.
 */
test('clicking a memory’s name opens the field with repaints held off', async () => {
  await withDom(async () => {
    const store = new DeviceStore();
    store.hydrate(fixture('aquilon-6.2.73-memories.json'));
    const { createMemoriesPanel } = await import('../plugins/memories/panel.js');
    let panel;
    let root;
    const onRefresh = () => { if (!panel.busy()) root = panel.render(); };
    panel = createMemoriesPanel({ session: sessionOver(store), onRefresh, popoutEnabled: false });
    root = panel.render();
    const name = root.querySelector('button.lpp-name');
    assert.ok(name, 'there is a memory to rename');
    name.click();
    assert.equal(panel.busy(), true);
    const field = root.querySelector('input.wru-input[data-lpp-focus]');
    assert.ok(field, 'the name became a field without waiting for a repaint');
    assert.equal(root.querySelector('button.lpp-name') === name, false);
  });
});

/*
 * Preview lock: Recall in the Memories panel waits while the hold says a take
 * is in flight, sends when it lands, and sends nothing if it never does.
 */
test('Memories: a recall into a preview mid-take waits for the hold, then goes', async () => {
  await withDom(async () => {
    const store = new DeviceStore();
    store.hydrate(fixture('aquilon-6.2.73-memories.json'));
    const sent = [];
    const session = sessionOver(store);
    session.send = (cmd) => { sent.push(cmd); return true; };
    const settles = [];
    const hold = () => new Promise((resolve) => settles.push(resolve));
    const { createMemoriesPanel } = await import('../plugins/memories/panel.js');
    let root;
    const panel = createMemoriesPanel({ session, onRefresh: () => { root = panel.render(); }, popoutEnabled: false, hold });
    root = panel.render();
    const recall = () => [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Recall');
    assert.ok(recall(), 'there is a memory to recall');

    recall().click();
    assert.equal(sent.length, 0, 'held while the take is in flight');
    assert.match(root.textContent, /waiting for the take to land/);
    settles[0]({ ok: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].path.at(-1), 'xRequest');

    recall().click();
    settles[1]({ ok: false, message: 'S1 still mid-take after 4.0 s' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sent.length, 1, 'a hold that gave up sends nothing');
    assert.match(root.textContent, /not recalled — S1 still mid-take/);
  });
});

/*
 * The Dante panel with a network in it — the generic pass above draws it
 * waiting for its server half, which says nothing about the grid. This one
 * hands it the devices the simulator network reads as, over a store with the
 * switcher's own Dante card in it, and opens a receiver and a transmitter.
 */
test('the Dante panel draws its grid, marks the switcher’s card and opens into channels', async () => {
  await withDom(async () => {
    const store = new DeviceStore();
    const tree = merged('sim-6.2.73-identity.json', 'sim-6.2.73-dante.json', 'sim-6.2.73-audio.json');
    /* The simulator's card labels nothing; one label is put in by hand, to see it drawn. */
    tree.device.system.deviceList.items['1'].dante.channelList.items.DANTE_1_CHANNEL_1.source.status.pp.label = 'Desk L';
    store.hydrate(tree);
    const { createDantePanel } = await import('../plugins/dante/panel.js');
    const status = (code, rx) => ({ code, name: code === 9 ? 'DYNAMIC' : 'NONE', state: code === 9 ? 'connected' : 'none', label: code === 9 ? 'Subscribed (unicast)' : 'Not subscribed' });
    const device = (name, tx, rx, extra = {}) => ({
      id: name, name, address: '127.0.0.1', port: 4440, source: 'mdns', status: 'ok', writable: true, form: 'modern', protocol: '2.8.9', inventory: 'modern',
      sampleRate: 48000, latencyNs: 1000000, txCount: tx.length, rxCount: rx.length,
      tx: tx.map((label, i) => ({ number: i + 1, label })),
      rx: rx.map(([label, sub], i) => ({ number: i + 1, label, sub, status: status(sub ? 9 : 0) })),
      ...extra
    });
    const data = {
      devices: [
        device('AQL-Simulator', ['01', '02'], [['01', { channel: 'Mix L', device: 'FOH-Desk' }], ['02', null]]),
        device('FOH-Desk', ['Mix L', 'Mix R'], [['Ch 1', null]])
      ],
      discovery: { running: true, multicast: true, asking: ['192.0.2.1'], lastBrowse: Date.now(), error: null },
      interfaces: [], snapshots: [{ name: 'Show A', savedAt: '2026-10-06T10:00:00Z', devices: ['AQL-Simulator'], routes: 1 }]
    };
    let applied = null;
    const model = {
      state: { data, error: null, note: null, result: null, version: 1 },
      want() {}, onChange() {}, isPending: () => false, note() {}, exportUrl: () => '/__lpp/dante/preset',
      apply: async (routes) => { applied = routes; return { ok: true, results: [], summary: '' }; }
    };
    const panel = createDantePanel({ session: sessionOver(store), model, popoutEnabled: false });
    const root = renders('dante', panel);
    assert.match(root.textContent, /this switcher/, 'the switcher’s card is marked');
    assert.match(root.textContent, /AQL-Simulator.*matched by name/s);
    /* Open the switcher's receiver and the desk's transmitters. */
    root.querySelectorAll('th.lpp-dn-rh--group').find((th) => /AQL-Simulator/.test(th.textContent)).click();
    root.querySelectorAll('th.lpp-dn-gh').find((th) => /FOH-Desk/.test(th.textContent)).click();
    panel.render();
    const channelRow = root.querySelectorAll('th.lpp-dn-rh--ch')[0];
    assert.match(channelRow.getAttribute('title'), /Audio Matrix: Dante 1 feeds Output 1 ch 1/);
    assert.match(channelRow.textContent, /\(Desk L\)/, 'the switcher’s own label for the channel, beside Dante’s');
    const lit = root.querySelectorAll('td.lpp-dn-x--connected');
    assert.equal(lit.length, 1, 'one subscription, one lit cell');
    lit[0].click();
    assert.equal(applied, null, 'the grid opens locked');
    root.querySelectorAll('button.lpp-chip').find((b) => b.textContent === 'Locked').click();
    panel.render();
    root.querySelectorAll('td.lpp-dn-x--connected')[0].click();
    assert.deepEqual(applied, [{ rx: { device: 'AQL-Simulator', channel: 1 }, tx: null }], 'unlocked, a lit cell clears');
  });
});

/*
 * The Background Slicer drawn with a job under way — a screen chosen, a
 * content size, each mode — not just its empty first state, which is all the
 * loop above reaches because the panel shows nothing more until a screen is
 * picked.
 */
test('the Background Slicer renders a job in each mode against the simulator’s store', async () => {
  await withDom(async () => {
    /* The simulator's store slices, as STORES.simulator has them, with the
       background sets, stills and library this panel reads. */
    const store = new DeviceStore();
    store.hydrate(merged('sim-6.2.73-identity.json', 'sim-6.2.73-screens.json', 'sim-6.2.73-destinations.json',
      'sim-6.2.73-connectors.json', 'sim-6.2.73-outputs.json', 'sim-6.2.73-resources.json', 'sim-6.2.73-backgrounds.json'));
    const { createBgSlicerPanel } = await import('../plugins/bg-slicer/panel.js');
    const { createJob } = await import('../plugins/bg-slicer/job.js');
    for (const source of ['stills', 'live']) {
      const job = createJob();
      job.source = source;
      job.content = { width: 6400, height: 1440 };
      job.screens = ['S1'];
      const view = createBgSlicerPanel({ session: sessionOver(store), job, onRefresh() {}, popoutEnabled: false });
      const root = renders(`bg-slicer (${source})`, view);
      const text = root.textContent;
      assert.match(text, /Placement/, `${source}: the placement view is drawn`);
      assert.match(text, /Plan — nothing is written yet/);
      assert.match(text, /Out 1/);
      assert.match(text, source === 'live' ? /IN 1/ : /slot 1/);
      assert.ok(root.querySelectorAll('.lpp-bgs-out').length >= 3, 'every output is drawn on the canvas');
      assert.ok(root.querySelectorAll('input[step]').length >= 4, 'the placement fields take arithmetic');
      /* Stills only: the choice to fill an empty slot a still points at. */
      if (source === 'stills') assert.match(text, /Use empty library slots a still points at/);
      else assert.doesNotMatch(text, /Use empty library slots a still points at/);
      job.mode = 'span';
      renders(`bg-slicer (${source}, span)`, view);
    }
  });
});

/*
 * The same panel on a Midra 4K: the model is `mng.js`, the plan is one canvas
 * image per screen through a Background Image (and how each output crops it),
 * or a Custom set — drawn against the Midra 4K simulator's store, where the
 * plan has to refuse because S1's Background Image 1 points at the slot an
 * upload would take.
 */
test('the Background Slicer renders a Midra job in each mode', async () => {
  await withDom(async () => {
    const store = new DeviceStore();
    store.hydrate(fixture('midra-3.2.29-backgrounds.json'));
    const { createBgSlicerPanel } = await import('../plugins/bg-slicer/panel.js');
    const { createJob } = await import('../plugins/bg-slicer/job.js');
    for (const source of ['stills', 'live']) {
      const job = createJob();
      job.source = source;
      job.content = { width: 2944, height: 1080 };
      job.screens = ['S2'];
      const view = createBgSlicerPanel({ session: sessionOver(store), job, onRefresh() {}, popoutEnabled: false });
      const root = renders(`bg-slicer midra (${source})`, view);
      const text = root.textContent;
      assert.match(text, /Plan — nothing is written yet/);
      assert.match(text, /canvas 1024 × 640/);
      if (source === 'stills') {
        assert.match(text, /the switcher’s choice: its first empty slot/);
        assert.match(text, /How the switcher crops it/);
        assert.match(text, /S1 BKG1 already points at it/, 'the slot-1 refusal is shown');
        assert.ok(root.querySelectorAll('select').length >= 2, 'a set and a Background Image to choose');
      } else {
        assert.match(text, /as Custom — an input per output/);
        assert.match(text, /INPUT 1/);
      }
      job.screens = ['S1', 'S2'];
      job.mode = 'span';
      renders(`bg-slicer midra (${source}, span)`, view);
    }
  });
});
