/*
 * UMD Generator — the plugin's page half.
 *
 * A tab on the Screens / Aux. strip, beside the cards it describes: pick a
 * destination, and the panel draws a UMD (borders and name tabs) over where
 * its layers are, named after what they show. Download it as a PNG, or put it on the
 * switcher — an aux's top layer, through a still; a screen's background,
 * through the Background Slicer, which cuts it per output. A template lays
 * the aux's layers out first, in 1, 3, 5 or 7 boxes. See `core.js` for why
 * each of those is the way it is, and `apply.js` for the writes.
 *
 * With the Experimental features plugin on (its `experimental` service), an
 * aux may put its UMD on its own background instead of its top layer — taken
 * by the switcher, never seen drawn by a frame. Without it, nothing here
 * changes.
 *
 * Everything is worked out from the mirror on every frame — a layer moved on
 * the vendor's page is a moved box in the preview a second later — and the
 * panel says when the UMD on the switcher no longer matches the layers.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { listDestinations, readLayers, presetBanks } from '../../src/core/screens.js';
import { bankLetter } from '../../src/core/properties.js';
import { readLibrary, readStills } from '../../src/core/stills.js';
import {
  normalise, normaliseDest, withDest, targetOf, labelsFor, layerPlan, readBoxes, layout, fingerprint,
  templatesFor, templateById, fileName, roughMeasure, sourceNames, boxText, layerPath
} from './core.js';
import { renderPng, measurer, measuringContext } from './render.js';
import { putOnLayer, applyTemplate, revert } from './apply.js';
import { createUmdPanel } from './panel.js';

export default function activate(ctx) {
  const store = ctx.session.store;
  let doc = normalise(null);
  let selected = null;
  const run = { running: false, steps: [], journal: null, error: null };
  const mctx = measuringContext();
  const measure = mctx ? measurer(mctx) : roughMeasure;

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the UMD settings', err);
    }
  }

  async function save() {
    try {
      await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
    } catch (err) {
      ctx.log.warn('could not save the UMD settings', err);
    }
  }

  const change = (next, { persist = true } = {}) => {
    doc = normalise(next);
    if (persist) void save();
    ctx.refresh();
  };

  const destinations = () => (store.ready ? listDestinations(store) : []);
  const isLivePremier = () => {
    const d = dialectFor(store);
    return !!d && d.id === 'nlc';
  };
  /* An aux's background as a target is experimental, and LivePremier's only. */
  const experimental = () => isLivePremier() && Boolean(ctx.use('experimental'));

  /** Everything the panel shows about one destination, from the mirror as it is now. */
  function model(id) {
    const dest = destinations().find((d) => d.id === id);
    if (!dest) return null;
    const entry = doc.dests[id] || normaliseDest(null);
    const exp = experimental();
    const isAux = dest.kind === 'aux' || String(id).startsWith('A');
    const target = targetOf(id, entry, exp);
    const auxBackground = isAux && target === 'background';
    const labels = labelsFor(id, entry, exp);
    const lp = layerPlan(store, id, target);
    const bank = bankLetter(store, id, entry.buffer === 'program' ? 'PROGRAM' : 'PREVIEW');
    const namesService = ctx.use('names');
    const layerNames = namesService ? namesService.get() : {};
    const boxes = readBoxes(store, dest, bank.letter, {
      umd: target === 'layer' ? lp.umd : null, names: entry.names, layerNames, labelFrom: doc.style.labelFrom
    });
    const plan = layout(boxes, dest.canvas, doc.style, { target, labels, measure });
    const print = fingerprint(plan);

    /* Every box layer, with or without a source, so one can be named first. */
    const sources = sourceNames(store);
    const byKey = new Map(readLayers(store, dest, bank.letter).map((l) => [l.key, l]));
    const rows = lp.boxes.map((key) => {
      const l = byKey.get(key);
      const source = l ? l.source : 'NONE';
      return {
        key, source,
        shows: l && l.hasSource,
        auto: boxText({ key, source }, { id, names: {}, layerNames, sources, labelFrom: doc.style.labelFrom, store }),
        name: entry.names[key] || ''
      };
    });

    return {
      dest, entry, target, labels, layers: lp, bank, boxes, plan, print, rows,
      auxChoice: isAux && exp, auxBackground,
      templates: templatesFor(lp.boxes.length, { even: auxBackground }),
      template: templateById(entry.template),
      placed: placedState(dest, entry, bank, print)
    };
  }

  /** Where the last UMD put on this destination is now, and whether it still matches. */
  function placedState(dest, entry, bank, print) {
    const p = entry.placed;
    if (!p) return null;
    const dialect = dialectFor(store);
    const lib = readLibrary(store).slots.find((s) => s.slot === p.slot);
    const still = readStills(store).find((s) => s.key === String(p.still));
    const stillStatus = (store.get(['device', 'stillList', 'items', String(p.still), 'status', 'pp'])) || {};
    /* Which buffers show it: after a take it is program's, not preview's. */
    const banks = presetBanks(store, dest.id);
    const shows = (letter) => {
      const path = p.layer && dialect && layerPath(store, dest.id, letter, p.layer, dialect.sourceParam);
      return !!path && store.get(path) === `STILL_${p.still}`;
    };
    return {
      ...p,
      file: !!lib && !lib.free && lib.fileName === fileName(dest.id),
      stillShows: !!still && still.mode === 'IMAGE' && Number(still.source) === p.slot,
      inPreview: shows(banks.preview),
      inProgram: shows(banks.program),
      onLayer: shows(bank.letter),
      onProgram: stillStatus.isOnProgram === true,
      current: p.fingerprint === print
    };
  }

  const step = (text, state = 'done') => {
    run.steps.push({ text, state });
    ctx.refresh();
  };

  async function guarded(fn) {
    if (run.running) return;
    run.running = true;
    run.steps = [];
    run.error = null;
    ctx.refresh();
    try {
      await fn();
    } catch (err) {
      run.error = err.message;
      step(err.message, 'failed');
    } finally {
      run.running = false;
      ctx.refresh();
    }
  }

  /* Whether a put may use an empty library slot a still points at. Off with
     every page load: that still shows the UMD too, maybe on air. */
  let assignedSlots = false;

  const actions = {
    select(id) { selected = id; run.steps = []; run.error = null; ctx.refresh(); },
    assignedSlots: () => assignedSlots,
    setAssignedSlots(on) { assignedSlots = Boolean(on); ctx.refresh(); },

    async download(id) {
      const m = model(id);
      if (!m) return;
      const blob = await renderPng(m.plan);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fileName(id);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },

    put(id) {
      return guarded(async () => {
        const m = model(id);
        if (!m) throw new Error(`${id} is not in service`);
        if (m.target !== 'layer' && !m.auxBackground) throw new Error('A screen’s UMD goes on its background, through the Background Slicer');
        const carrier = m.auxBackground ? 'NATIVE' : m.layers.umd;
        if (!carrier) throw new Error(`${id} has no layer to carry the UMD`);
        if (!m.bank.reported || !m.bank.settled) throw new Error(`${id} is mid-take — wait for it to land`);
        const blob = await renderPng(m.plan);
        const res = await putOnLayer({
          session: ctx.session, dest: m.dest, letter: m.bank.letter, layer: carrier, blob,
          placed: m.entry.placed, assignedSlots, onStep: step
        });
        if (res.journal.uploads.length || res.journal.stills.length || res.journal.writes.length) run.journal = res.journal;
        if (!res.ok) throw new Error(res.error);
        change(withDest(doc, id, { placed: { ...res.placed, fingerprint: m.print } }));
      });
    },

    layOut(id) {
      return guarded(async () => {
        const m = model(id);
        if (!m || !m.template) throw new Error('Choose a template first');
        if (!m.bank.reported || !m.bank.settled) throw new Error(`${id} is mid-take — wait for it to land`);
        const res = await applyTemplate({
          session: ctx.session, dest: m.dest, letter: m.bank.letter, template: m.template,
          boxLayers: m.layers.boxes, gap: m.entry.gap, onStep: step
        });
        run.journal = res.journal;
        if (!res.ok) throw new Error(res.error);
      });
    },

    async offer(id) {
      const service = ctx.use('backgrounds');
      const m = model(id);
      if (!service || !m) return;
      return guarded(async () => {
        const blob = await renderPng(m.plan);
        const file = new File([blob], fileName(id), { type: 'image/png' });
        const size = await service.offer({ file, screens: [id] });
        step(`The Background Slicer has the UMD (${size.width}×${size.height}) for ${id}. Open PLUS ▸ Background Slicer to cut it per output and write the set.`);
      });
    },

    undo() {
      const journal = run.journal;
      if (!journal) return;
      return guarded(async () => {
        const res = await revert({ session: ctx.session, journal, onStep: step });
        run.journal = null;
        if (journal.stills.length || journal.uploads.length) change(withDest(doc, journal.id, { placed: null }));
        if (!res.ok) throw new Error(`Not everything went back: ${res.problems.join(', ')}`);
      });
    }
  };

  const view = createUmdPanel({
    ready: () => Boolean(store.ready),
    doc: () => doc,
    change,
    destinations,
    selected: () => {
      const dests = destinations();
      if (!dests.some((d) => d.id === selected)) {
        selected = (dests.find((d) => d.kind === 'aux') || dests[0] || {}).id || null;
      }
      return selected;
    },
    model,
    run: () => run,
    canWrite: () => isLivePremier() && ctx.can('imageLibrary'),
    backgrounds: () => ctx.use('backgrounds'),
    actions
  });

  ctx.ui.tab({
    id: 'umd',
    label: 'UMD',
    short: 'UMD',
    icon: ['outputs-multiviewer-14', 'grid-3-14'],
    order: 60,
    render: () => view.render(),
    busy: () => view.busy()
  });

  void load().then(() => ctx.refresh());
}
