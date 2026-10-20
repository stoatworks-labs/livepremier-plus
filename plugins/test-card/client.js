/*
 * Test Card — the plugin's page half.
 *
 * A **Test Card** tab beside the vendor's own Pattern tab, on Setup ▸ Outputs
 * ▸ an output and on Preconfig ▸ Canvas (`decorate.js`). Pick one of Test
 * Card's patterns, see it drawn for that output or canvas from the switcher's
 * own geometry, and Enable puts it on the destination's top layer through a
 * still (`core.js` says why a still, `src/core/still-layer.js` how).
 *
 * **On the fly.** While a card is on, it follows: a new pattern, a changed
 * option, an output that changes format or moves on the canvas, and the card
 * is drawn again and uploaded into the same library slot, which the still
 * follows by itself. The geometry is checked every couple of seconds off the
 * mirror; nothing is written unless what would be drawn has changed.
 *
 * **Off puts back what was there**, from a journal kept per switcher on disk
 * — and only what is still the card's (`core.trimJournal`).
 *
 * ## The document is on disk, and only one thing touches it at a time
 *
 * Two pages can be open on one switcher, and each has its own copy of the
 * document. So every action and every follower pass runs in one queue
 * (`serial`), reads the document from disk first, and awaits its own save
 * before the next starts; the journal is saved before each group of writes
 * goes out (`persist`), so a page closed half way still leaves on disk what
 * Off needs. A card's wanted state (`mode`) is saved before its writes, so a
 * put that fails half way still shows as on, with Off there to take back
 * what landed; an Off that fails stays on, so Off can be pressed again.
 */

import { dialectFor } from '../../src/core/dialect.js';
import { presetBanks } from '../../src/core/screens.js';
import { bankLetter } from '../../src/core/properties.js';
import { readCanvases, canvasTopology } from '../../src/core/backgrounds.js';
import { putStillOnLayer, revertStillLayer, stillLayerWrites, layerPath } from '../../src/core/still-layer.js';
import { readLibrary, readStills } from '../../src/core/stills.js';
import {
  KINDS, OPTIONS, COMMON, STILL_AT, LAYOUTS, PATTERN_LABELS, moves, scaled, normalise, normaliseDest, withDest, withSettings,
  setPath, cardPlan, layerFor, mergeJournal, trimJournal, fingerprint, fileName, stillLabel, homeOf, toggleOutput
} from './core.js';
import { renderPng, drawPreview, thumbnail } from './render.js';
import { installTestCardTab } from './decorate.js';
import { buildPanel } from './panel.js';

const SYNC_MS = 2000;
const PREVIEW_WIDTH = 560;
const THUMB = { width: 128, height: 72 };
/* A card something keeps changing back is let go, not fought: more than
   FIGHT redraws of one destination inside a minute, none of them asked for
   here, and the follower stops for it until the operator does something. */
const FIGHT = 6;

const pageKey = (page) => (page ? (page.kind === 'output' ? `output:${page.key}` : `canvas:${page.id}`) : null);

export default function activate(ctx) {
  createTestCard(ctx);
}

/**
 * Everything the page half is, without the tab, so a test can drive it:
 * `render(page)` is the tab's body, `actions` what its controls call,
 * `sync()` one follower pass, `idle()` resolves when the queue is empty.
 */
export function createTestCard(ctx, { tab: withTab = true } = {}) {
  const store = ctx.session.store;
  let doc = normalise(null);
  const run = { busy: false, steps: [], error: null, dest: null };
  /* Page state, off at every load: program is on air at once, and an empty
     slot a still points at shows the card on that still too. */
  let program = false;
  let assigned = false;
  /* Enable that would write program asks once more, as the UMD Generator's
     Put on does: the page it was asked on, until confirmed or abandoned. */
  let confirming = null;

  /* -------------------------------------------------------------- document */

  async function load() {
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (res.ok) doc = normalise((await res.json()).data);
    } catch (err) {
      ctx.log.warn('could not load the Test Card settings', err);
    }
  }

  async function save() {
    try {
      const res = await fetch(ctx.url('/'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: doc })
      });
      if (res && res.ok === false) ctx.log.warn(`could not save the Test Card settings: ${res.status}`);
    } catch (err) {
      ctx.log.warn('could not save the Test Card settings', err);
    }
  }

  /** The document becomes `next`, on disk before this resolves. Inside `serial` only. */
  async function commit(next) {
    doc = normalise(next);
    await save();
    repaint();
  }

  /* One thing at a time: the operator's own clicks and the follower share it. */
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  /** A change to the document, made to the copy on disk as it is now. */
  const edit = (fn) => serial(async () => {
    await load();
    await commit(fn(doc));
  });

  /* ------------------------------------------------------------ the mirror */

  const isLivePremier = () => {
    const d = dialectFor(store);
    return !!d && d.id === 'nlc';
  };
  const topologies = () => (store.ready ? readCanvases(store).map((d) => canvasTopology(store, d.id)).filter(Boolean) : []);
  const entryOf = (id) => doc.dests[id] || normaliseDest(null);

  /** Which destination and entry a page is about, and the entry it would have with its card on. */
  function resolve(page) {
    if (page.kind === 'output') {
      const home = homeOf(topologies(), page.key);
      if (!home.dest) return { reason: home.reason };
      const entry = entryOf(home.dest.id);
      const on = entry.mode === 'outputs' && entry.outputs.includes(page.key);
      return {
        topo: home.dest, out: home.out, entry, on,
        next: on ? entry : toggleOutput(entry, page.key, true),
        off: toggleOutput(entry, page.key, false),
        preview: { ...entry, mode: 'outputs', outputs: [page.key] }
      };
    }
    const id = page.id;
    if (!id) return { reason: 'Choose a screen or an aux on the left.' };
    const topo = canvasTopology(store, id);
    if (!topo) return { reason: `${id} is not in service.` };
    const entry = entryOf(id);
    const on = entry.mode === 'canvas';
    const next = { ...entry, mode: 'canvas' };
    return { topo, entry, on, next, off: { ...entry, mode: null, outputs: [] }, preview: next };
  }

  /** Where a placed card is now: which buffer it is in, whether it is still ours, and whether it is current. */
  function whereIs(id, entry) {
    const p = entry.placed;
    if (!p || !entry.mode) return null;
    const dialect = dialectFor(store);
    const path = dialect && layerPath(store, id, p.letter, p.layer, dialect.sourceParam);
    const shows = !!path && store.get(path) === `STILL_${p.still}`;
    const banks = presetBanks(store, id);
    const buffer = p.letter === banks.program ? 'program' : p.letter === banks.preview ? 'preview' : `buffer ${p.letter}`;
    const plan = cardPlan(canvasTopology(store, id), entry);
    const current = !plan.problem && p.fingerprint === fingerprint(doc.settings, plan);
    return { ...p, shows, buffer, current, problem: plan.problem || null };
  }

  /** Whether Enable on this destination would write program: a card up stays in its buffer, else the tick says. */
  function writesProgram(id, entry) {
    if (entry.placed) return entry.placed.letter === presetBanks(store, id).program;
    return program;
  }

  /* --------------------------------------------------------------- caches */

  const thumbs = new Map();
  const thumbFor = (kind) => {
    const key = `${kind}|${fingerprint({ ...doc.settings, kind: null }, { kind: 'thumb', rect: THUMB, outputs: [] })}`;
    if (!thumbs.has(key)) {
      if (thumbs.size > 256) thumbs.clear();
      thumbs.set(key, thumbnail(doc.settings, kind, THUMB.width, THUMB.height));
    }
    return thumbs.get(key);
  };

  let preview = { key: null, el: null };
  const previewFor = (plan) => {
    const key = `${fingerprint(doc.settings, plan)}|${PREVIEW_WIDTH}`;
    if (preview.key !== key) {
      const el = typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (el) {
        try { drawPreview(el, plan, doc.settings, PREVIEW_WIDTH); } catch (err) { ctx.log.warn('preview failed', err); }
      }
      preview = { key, el };
    }
    return preview.el;
  };

  /* ---------------------------------------------------------------- model */

  function model(page) {
    const m = { page, ready: Boolean(store.ready), steps: run.steps, error: run.error, busy: run.busy, program, assigned };
    if (!m.ready) return m;
    if (!isLivePremier()) return { ...m, unavailable: 'Test Card puts its pictures on a LivePremier’s layers through a still. On this switcher, use the Pattern tab, or download a PNG from Test Card itself.' };
    const r = resolve(page);
    if (r.reason) return { ...m, unavailable: r.reason };
    const { topo, entry, on } = r;
    const settings = doc.settings;
    const shown = cardPlan(topo, r.preview);
    const wanted = cardPlan(topo, r.next);
    const lf = wanted.rect ? layerFor(store, topo.id, wanted.rect) : null;
    const banks = presetBanks(store, topo.id);
    let blocked = null;
    if (!ctx.can('imageLibrary')) blocked = 'This switcher has no image library this app can reach.';
    else if (wanted.problem) blocked = wanted.problem;
    else if (lf && !lf.fits) blocked = lf.reason;
    else if (!banks.reported || !banks.settled) blocked = `${topo.id} is mid-take — wait for it to land.`;

    const placed = whereIs(topo.id, entry);
    const where = whereText(page, topo, entry, on, placed);
    if (confirming && confirming !== pageKey(page)) confirming = null;
    const kind = settings.kind;
    const options = [...(OPTIONS[kind] || []), ...(moves(kind) ? [STILL_AT] : []), ...COMMON];
    const notes = [];
    if (shown.inexact && shown.inexact.length) notes.push(`Out ${shown.inexact.join(', ')}: a pitch ratio scales the footprint, so the switcher resamples the card on its way to the raster — not pixel for pixel.`);
    const rotated = (page.kind === 'output' ? [r.out] : topo.outputs).filter((o) => o && o.rotation);
    if (rotated.length) notes.push(`Out ${rotated.map((o) => o.key).join(', ')} ${rotated.length > 1 ? 'are' : 'is'} turned: the card is drawn upright on the canvas, and the switcher turns it into the raster as it turns every layer.`);
    if (topo.skipped.length && page.kind === 'canvas') notes.push(topo.skipped.map((s) => `Out ${s.key}: ${s.why}.`).join(' '));
    if (moves(kind)) notes.push(`${PATTERN_LABELS[kind]} moves in Test Card. A switcher has no player, so this is one still frame of it — choose which with “Frame at”.`);

    return {
      ...m,
      destId: topo.id,
      title: page.kind === 'output' ? `Out ${page.key} on ${topo.id}` : `${topo.id}${topo.label ? ` · ${topo.label}` : ''} · ${topo.canvas.width}×${topo.canvas.height}`,
      on,
      /* Something of this destination's is on the switcher that this page's
         switch does not stand for: another output's card, a card whose output
         has moved, what a failed put left. */
      elsewhere: !on && Boolean(entry.mode || entry.journal),
      blocked,
      where,
      onAir: writesProgram(topo.id, entry),
      adding: !on && Boolean(entry.placed),
      buffer: placed ? placed.buffer : null,
      confirming: confirming === pageKey(page),
      settings,
      layouts: LAYOUTS,
      layout: entry.layout,
      kinds: KINDS.map((k) => ({ kind: k, label: PATTERN_LABELS[k], moves: moves(k), active: k === kind, thumb: thumbFor(k) })),
      kindLabel: PATTERN_LABELS[kind],
      options,
      scaledNote: scaled(kind) ? 'Drawn at real size from the pixel pitch, which the switcher does not know: the image says “pitch assumed” until you set it.' : null,
      preview: shown.problem ? null : previewFor(shown),
      planProblem: shown.problem || null,
      planNotes: notes,
      size: shown.rect ? `${shown.rect.width}×${shown.rect.height}` : '',
      slicer: page.kind === 'canvas' && topo.kind === 'screen' && Boolean(ctx.use('backgrounds')),
      how: lf && lf.layer
        ? `It goes on L${lf.layer} (${lf.capability}), ${topo.id}’s top layer, as a still: a free library slot and a free still are taken and given back when it goes off. While it is on, a change here is drawn again and uploaded into the same slot.`
        : null
    };
  }

  function whereText(page, topo, entry, on, placed) {
    const at = placed ? `${topo.id} L${placed.layer}, in ${placed.buffer} — still ${placed.still}, library slot ${placed.slot}` : null;
    if (page.kind === 'output') {
      if (entry.mode === 'canvas') return { text: `${topo.id} shows its canvas card (Preconfig ▸ Canvas). Enable here puts this output’s card on instead.`, tone: 'warn' };
      if (!on) {
        const others = entry.mode === 'outputs' ? entry.outputs : [];
        if (others.length) return { text: `Off here. On for Out ${others.join(', ')} of ${topo.id}${at ? ` (${at})` : ''}. Enable adds this output to that card, in the buffer it is in.`, tone: '' };
        return { text: entry.journal ? `Off here, but ${topo.id} has writes of a card to take back.` : 'Off.', tone: entry.journal ? 'warn' : '' };
      }
    } else if (!on) {
      if (entry.mode === 'outputs') return { text: `Off for the canvas. Cards are on for Out ${entry.outputs.join(', ')}${at ? ` (${at})` : ''} — Enable here replaces them.`, tone: 'warn' };
      return { text: entry.journal ? `Off, but ${topo.id} has writes of a card to take back.` : 'Off.', tone: entry.journal ? 'warn' : '' };
    }
    if (run.busy && run.dest === topo.id) return { text: 'Working on it…', tone: '' };
    if (!placed) return { text: entry.journal ? 'On, but the last attempt did not finish. Off takes back whatever of it landed.' : 'On, but not on the switcher yet.', tone: 'warn' };
    if (placed.problem) return { text: `On at ${at}, but ${placed.problem.toLowerCase()}.`, tone: 'warn' };
    if (!placed.shows) return { text: `On, but ${topo.id} L${placed.layer} no longer shows still ${placed.still} — someone changed it, so the card has stopped following. Off leaves the layer as they made it and gives back the still and the slot.`, tone: 'warn' };
    return { text: `On: ${at}${placed.current ? '' : ' — drawing the change'}.`, tone: placed.buffer === 'program' ? 'warn' : 'ok' };
  }

  /* -------------------------------------------------------------- writing */

  const step = (text, state = 'done') => {
    run.steps.push({ text, state });
    if (run.steps.length > 40) run.steps.splice(0, run.steps.length - 40);
    repaint();
  };

  /** Run one write job, inside `serial`, with the steps shown and a failure said. */
  async function running(id, fn, { quiet = false } = {}) {
    run.busy = true;
    run.dest = id;
    if (!quiet) { run.steps = []; run.error = null; }
    repaint();
    try {
      await fn();
    } catch (err) {
      run.error = err.message;
      step(err.message, 'failed');
    } finally {
      run.busy = false;
      run.dest = null;
      repaint();
    }
  }

  /** A write job from the operator: the document read first, the fight limit reset. */
  const guarded = (id, fn) => {
    redraws.clear();
    halted.clear();
    return serial(async () => {
      await load();
      await running(id, fn);
    });
  };

  /** The placements of every other destination, so two never share a slot or a still. */
  const othersOf = (id) => {
    const slots = [];
    const stills = [];
    for (const [k, e] of Object.entries(doc.dests)) {
      if (k === id || !e.placed) continue;
      slots.push(e.placed.slot);
      stills.push(e.placed.still);
    }
    return { slots, stills };
  };

  /** What the switcher holds now, for `trimJournal`. */
  const holding = () => ({
    get: (path) => store.get(path),
    stills: readStills(store).map((s) => ({ key: s.key, mode: s.mode, source: s.source, rescale: s.rescale, label: s.label })),
    library: readLibrary(store).slots.map((s) => ({ slot: s.slot, fileName: s.fileName, free: s.free }))
  });

  /** Take back what is still the card's of a journal. Resolves whether all of it went. */
  async function takeBack(id, entry) {
    if (!entry.journal) return true;
    const { journal, left } = trimJournal(entry.journal, entry.placed, fileName(id), holding(), { label: stillLabel(id) });
    for (const text of left) step(text, 'note');
    const res = await revertStillLayer({ session: ctx.session, journal, onStep: step });
    if (!res.ok) step(`Not everything went back: ${res.problems.join(', ')}`, 'failed');
    return res.ok;
  }

  /**
   * Bring one destination to `next`: its card drawn and on its top layer, or,
   * with no `mode`, taken off and what was there put back.
   */
  async function bring(id, next) {
    const entry = entryOf(id);
    if (!next.mode) {
      if (!(await takeBack(id, entry))) {
        /* Still on, with its journal, so Off can be pressed again. */
        throw new Error(`${id}: not everything went back — press Off again to retry.`);
      }
      await commit(withDest(doc, id, { ...next, placed: null, journal: null }));
      step(`${id}: the card is off and the layer is as it was`);
      return;
    }
    const topo = canvasTopology(store, id);
    const plan = cardPlan(topo, next);
    if (plan.problem) throw new Error(plan.problem);
    const lf = layerFor(store, id, plan.rect);
    if (!lf.fits) throw new Error(lf.reason);
    const layer = lf.layer;

    /* A card already up stays in its buffer — program after a take — and on
       its layer, unless the top layer has changed: then it comes off the old
       one first and goes on the new one in the same buffer. */
    let letter;
    if (entry.placed) {
      letter = entry.placed.letter;
      if (entry.placed.layer !== layer) {
        step(`${id}'s top layer is now L${layer}: taking the card off L${entry.placed.layer} first`, 'note');
        if (!(await takeBack(id, entry))) throw new Error(`${id}: could not take the card off L${entry.placed.layer}`);
        await commit(withDest(doc, id, { placed: null, journal: null }));
      }
    } else {
      const role = program ? 'PROGRAM' : 'PREVIEW';
      const bank = bankLetter(store, id, role);
      if (!bank.reported || !bank.settled) throw new Error(`${id} is mid-take — wait for it to land`);
      /* Read again at the layer write: a take that lands during the upload
         must not turn preview into program under the card. */
      letter = () => {
        const now = bankLetter(store, id, role);
        if (!now.reported || !now.settled) throw new Error(`${id} went mid-take during the upload — nothing was put on its layer; Off takes back the still and the slot`);
        return now.letter;
      };
    }

    /* The wanted state goes to disk before anything is written: a put that
       fails half way shows as on, and Off can take back what landed. */
    const base = entryOf(id);
    await commit(withDest(doc, id, { mode: next.mode, outputs: next.outputs, layout: next.layout }));
    const persist = (journal) => commit(withDest(doc, id, { journal: mergeJournal(base.journal, journal) }));

    const print = fingerprint(doc.settings, plan);
    step(`Drawing ${PATTERN_LABELS[doc.settings.kind]} at ${plan.rect.width}×${plan.rect.height}`, 'running');
    const blob = await renderPng(plan, doc.settings);
    const res = await putStillOnLayer({
      session: ctx.session,
      dest: { id, canvas: topo.canvas },
      letter, layer, blob,
      name: fileName(id),
      label: stillLabel(id),
      size: { width: plan.rect.width, height: plan.rect.height },
      layerWrites: (still, at) => stillLayerWrites(store, id, at, layer, still, plan.rect),
      placed: base.placed,
      assignedSlots: assigned,
      skip: othersOf(id),
      what: 'the test card',
      persist,
      onStep: step
    });
    const journal = mergeJournal(base.journal, res.journal);
    if (!res.ok) {
      await commit(withDest(doc, id, { journal }));
      throw new Error(res.error);
    }
    await commit(withDest(doc, id, { placed: { ...res.placed, rect: plan.rect, fingerprint: print }, journal }));
    step(`${id} L${layer} in ${res.placed.letter} shows the card at ${plan.rect.left},${plan.rect.top} ${plan.rect.width}×${plan.rect.height}`);
  }

  /* ------------------------------------------------------------ following */

  let syncTimer = null;
  let syncQueued = false;
  let lastCheck = 0;
  const redraws = new Map();
  const halted = new Set();

  /** The cards that are on and no longer match what would be drawn — and are still on their layer. */
  function stale() {
    const out = [];
    for (const [id, entry] of Object.entries(doc.dests)) {
      if (!entry.mode || !entry.placed || halted.has(id)) continue;
      const plan = cardPlan(canvasTopology(store, id), entry);
      if (plan.problem) continue;
      if (entry.placed.fingerprint === fingerprint(doc.settings, plan)) continue;
      /* Someone has put something else on that layer: it is theirs now, and
         a redraw would take it back. The panel says so. */
      const where = whereIs(id, entry);
      if (!where || !where.shows) continue;
      out.push(id);
    }
    return out;
  }

  /**
   * One follower pass: in the queue, after anything already in it, with the
   * document read from disk — another page may have changed the settings or
   * taken the card down, and two pages acting on different copies would
   * redraw each other's card for ever.
   */
  function sync() {
    syncTimer = null;
    lastCheck = Date.now();
    if (!store.ready || !isLivePremier() || syncQueued || !stale().length) return Promise.resolve();
    syncQueued = true;
    return serial(async () => {
      syncQueued = false;
      await load();
      for (const id of stale()) {
        const now = Date.now();
        const times = (redraws.get(id) || []).filter((t) => now - t < 60000);
        times.push(now);
        redraws.set(id, times);
        if (times.length > FIGHT) {
          halted.add(id);
          step(`${id}: the card has been drawn again ${FIGHT} times in a minute without being asked to here — something keeps changing it. Not following it any more; change anything here to start again.`, 'note');
          continue;
        }
        await running(id, () => bring(id, entryOf(id)), { quiet: true });
      }
    });
  }
  const soon = (ms = 400) => {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { void sync(); }, ms);
  };

  /** An edit the operator made here: it is asked for, so it is not a fight. */
  const asked = () => { redraws.clear(); halted.clear(); };

  /* --------------------------------------------------------------- actions */

  let tab = null;
  let lastPage = null;
  const pageNow = () => lastPage;

  const actions = {
    setOn(on, { confirmed = false } = {}) {
      const page = pageNow();
      if (!page) return;
      const r = resolve(page);
      if (r.reason) return;
      const id = r.topo.id;
      if (on && writesProgram(id, r.entry) && !confirmed) {
        confirming = pageKey(page);
        repaint();
        return;
      }
      confirming = null;
      /* Worked out again inside, from the document as it is on disk then. */
      return guarded(id, () => {
        const fresh = resolve(page);
        if (fresh.reason) throw new Error(fresh.reason);
        return bring(id, on ? fresh.next : fresh.off);
      });
    },
    /** Everything of this page's destination off: other outputs' cards, a card whose output moved, a failed put. */
    allOff() {
      const page = pageNow();
      const r = page && resolve(page);
      if (!r || r.reason) return;
      const id = r.topo.id;
      confirming = null;
      return guarded(id, () => bring(id, { ...entryOf(id), mode: null, outputs: [] }));
    },
    pickKind(kind) {
      if (!KINDS.includes(kind)) return;
      asked();
      return edit((d) => withSettings(d, { ...d.settings, kind })).then(() => soon());
    },
    setOption(path, value) {
      asked();
      return edit((d) => withSettings(d, setPath(d.settings, path, value))).then(() => soon(600));
    },
    setLayout(layout) {
      const page = pageNow();
      if (!page || page.kind !== 'canvas' || !page.id) return;
      asked();
      return edit((d) => withDest(d, page.id, { layout })).then(() => soon());
    },
    setProgram(on) { program = Boolean(on); confirming = null; repaint(); },
    confirm() { return actions.setOn(true, { confirmed: true }); },
    cancel() { confirming = null; repaint(); },
    setAssigned(on) { assigned = Boolean(on); repaint(); },

    async download() {
      const page = pageNow();
      const r = page && resolve(page);
      if (!r || r.reason) return;
      const plan = cardPlan(r.topo, r.preview);
      if (plan.problem) return;
      const blob = await renderPng(plan, doc.settings);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = page.kind === 'output' ? `testcard-out${page.key}.png` : fileName(r.topo.id);
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    },

    offer() {
      const page = pageNow();
      const service = ctx.use('backgrounds');
      const r = page && resolve(page);
      if (!service || !r || r.reason || page.kind !== 'canvas') return;
      const id = r.topo.id;
      return serial(() => running(id, async () => {
        const plan = cardPlan(r.topo, r.preview);
        if (plan.problem) throw new Error(plan.problem);
        const blob = await renderPng(plan, doc.settings);
        const file = new File([blob], fileName(id), { type: 'image/png' });
        const size = await service.offer({ file, screens: [id] });
        step(`The Background Slicer has the card (${size.width}×${size.height}) for ${id}. Open PLUS ▸ Background Slicer to cut it per output into a background set, under the layers.`);
      }));
    }
  };

  /* ---------------------------------------------------------------- paint */

  let cached = { sig: null, el: null };
  function render(page) {
    lastPage = page;
    const m = model(page);
    const sig = JSON.stringify({
      ...m,
      preview: preview.key,
      kinds: m.kinds && m.kinds.map((k) => [k.kind, k.active]),
      settings: m.settings ? fingerprint(m.settings, { kind: 'sig', rect: null, outputs: [] }) : null,
      thumbs: thumbs.size
    });
    if (cached.sig !== sig || !cached.el) cached = { sig, el: buildPanel(m, actions) };
    return cached.el;
  }

  const repaint = () => { if (tab) tab.refresh(); };

  if (withTab) tab = installTestCardTab({ enabled: () => true, render });

  /* The mirror moves about once a second; check the cards and the tab's
     status at most every couple of seconds. */
  let lastPaint = 0;
  ctx.session.addEventListener('frame', () => {
    const now = Date.now();
    if (now - lastPaint > 1000) { lastPaint = now; repaint(); }
    if (now - lastCheck > SYNC_MS && !syncTimer) soon(0);
  });
  if (store.addEventListener) store.addEventListener('ready', () => { repaint(); soon(); });

  if (ctx.provide) ctx.provide('test-card', Object.freeze({ describe: () => (tab ? tab.describe() : null), model: () => (lastPage ? model(lastPage) : null) }));

  const loaded = serial(load).then(() => { repaint(); soon(); });

  return {
    render, actions, model, sync,
    loaded,
    document: () => doc,
    run: () => run,
    /** Resolves once everything queued so far has finished. */
    idle: () => chain
  };
}
