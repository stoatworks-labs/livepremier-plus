/*
 * Resolume Mapping — the map and the plan. No DOM, no I/O: the panel, the
 * write and the tests import this.
 *
 * ## What it makes
 *
 * Resolume Arena plays one composition. Here the composition is the chosen
 * screens' canvases, side by side or one above another, each at its own
 * pixels. Every output of those screens is fed by one Arena output — an
 * Advanced Output "Screen" — the size of the output's raster, cabled into a
 * switcher input; each of the output's slices (its connectors) is an Arena
 * Slice that reads the output's rectangle of the composition and writes it
 * to the part of the raster the switcher shows there. So whatever Arena plays
 * across the composition lands on the LED or projectors exactly where it
 * would if the composition were the switcher's canvas.
 *
 * Where an output sits on its canvas — slices, rotation, pitch, groups,
 * clones — is `src/core/backgrounds.js`, the model the Background Slicer cuts
 * pictures against; this is that model with Arena standing where the picture
 * was. A region is `outputBlits` of the screen's whole canvas at 1:1, so the
 * input rectangle is the canvas rectangle, moved to where the screen sits in
 * the composition, and the output quad is the raster rectangle, turned for a
 * rotated output with corner 0 where the content's top-left lands (Arena's
 * `orientation` is derived from corner 0 → 1).
 *
 * ## The background set, optionally
 *
 * Each Arena output arrives at a switcher input. Naming that input names the
 * Arena output after the cable (`IN 5 → S1 Out 1`), and — if the operator
 * asks — writes each output's background in a set to that input (`LIVE_5`),
 * with the claim bookkeeping the Web RCS does (`contentWrites`), and can load
 * each input plug with the switcher's own EDID for its output's format, so
 * the Arena machine's graphics card is offered exactly the mode a live
 * background must match ("same format (resolution, rate and blanking)",
 * Aquilon manual p.101).
 *
 * An output with no input chosen keeps whatever its set holds. Nothing here
 * writes; `apply.js` does, from the plan this builds.
 */

import {
  readScreens, screenTopology, outputBlits, isExact, assumptionsFor, blitTransform,
  nativeLayer, edidChoice, plugTemplates
} from '../../src/core/backgrounds.js';
import { readSets, firstFreeSet, LABEL_MAX } from '../../src/core/stills.js';
import { exportResolumeXml, exportFilename } from '../../src/vendor/output-map/resolume.js';

export { LABEL_MAX };

/** How the screens sit in the composition. */
export const ARRANGEMENTS = [
  { id: 'row', label: 'Side by side', what: 'Each screen to the right of the one before, tops aligned.' },
  { id: 'column', label: 'One above another', what: 'Each screen under the one before, left edges aligned.' }
];

/**
 * What about an output is assumed rather than proven, in this tool's words —
 * the keys are `assumptionsFor`'s. Each says what it means for the Arena map.
 */
export const NOTES = {
  slices: { proven: false, text: 'An output’s slices are its connectors, read off the switcher: where each sits in the output’s raster and how much it carries. Only a single full-raster slice has been seen on a device; more than one follows the Web RCS’s own arithmetic.' },
  pitch: { proven: false, text: 'A pitch ratio other than 1.000 means the output covers more or less canvas than it has pixels: Arena scales that rectangle of the composition to the raster.' },
  rotation: { proven: false, text: 'A rotated output’s slice is turned the way the switcher turns its layers. Whether it turns a live background as well is not established — check the first one on the display.' },
  group: { proven: false, text: 'An output group gets one background at its leader, covering the group’s whole raster, which the switcher splits across the connectors. No grouped output has been read off a device.' }
};

const round = (n) => Math.round(n * 1000) / 1000;

/** `IN_5` → `IN 5`. */
export const inputWord = (key) => String(key || '').replace(/^IN_/, 'IN ');

/**
 * The name of the Arena output that feeds one switcher output: after the
 * cable it goes down when there is one (`IN 5 → S1 Out 1`), else after the
 * output. The Background Slicer names its media outputs the same way.
 */
export function arenaName(screenId, outKey, input) {
  const where = `${screenId} Out ${outKey}`;
  return input ? `${inputWord(input)} → ${where}` : where;
}

/**
 * The screens' places in the composition, in the order given, and the
 * composition's size: `{ screens: [{ id, at: {x,y}, w, h }], width, height }`.
 */
export function compose(screens, arrange = 'row') {
  let x = 0;
  let y = 0;
  const placed = screens.map((s) => {
    const at = { x, y };
    if (arrange === 'column') y += s.canvas.height; else x += s.canvas.width;
    return { id: s.id, at, w: s.canvas.width, h: s.canvas.height };
  });
  return {
    screens: placed,
    width: Math.max(0, ...placed.map((p) => p.at.x + p.w)),
    height: Math.max(0, ...placed.map((p) => p.at.y + p.h))
  };
}

/**
 * A blit's output quad in Arena's corner order: corner 0 is where the
 * content's top-left lands, so a turned region is a turned quad.
 */
export function outputQuad(blit) {
  const [a, b, c, d, e, f] = blitTransform(blit);
  const at = (u, v) => ({ x: round(a * u + c * v + e), y: round(b * u + d * v + f) });
  return [at(0, 0), at(blit.lw, 0), at(blit.lw, blit.lh), at(0, blit.lh)];
}

const rectQuad = (r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];

/**
 * One output's regions: what each of its slices reads from the composition
 * and where it writes it on the raster. `at` is the screen's place in the
 * composition; the place is the whole canvas at 1:1, so a footprint off the
 * canvas reads nothing from beside it — another screen's content.
 */
export function outputRegions(output, canvas, at) {
  const whole = { x: 0, y: 0, w: canvas.width, h: canvas.height };
  return outputBlits(output, whole, { width: canvas.width, height: canvas.height }).map((b) => ({
    slice: b.region,
    rotation: b.rotation,
    input: { x: round(b.src.x + at.x), y: round(b.src.y + at.y), w: round(b.src.w), h: round(b.src.h) },
    raster: { x: round(b.dst.x), y: round(b.dst.y), w: round(b.dst.w), h: round(b.dst.h) },
    output: outputQuad(b),
    exact: isExact(b)
  }));
}

/**
 * Everything that would be written, and the Arena map, worked out before
 * anything is.
 *
 * `job`: `{ screens: [ids], arrange: 'row'|'column', inputs: { '<screen>/<out>':
 * 'IN_5' }, name, set: { on, index: { S1: 3 }, label, edids, preview,
 * allowProgram } }`.
 *
 * `xml` says whether there is a map to download; `write` whether the set can
 * be written. Problems block; warnings are read before writing.
 */
export function buildPlan(store, job, cands = []) {
  const xml = [];
  const write = [];
  const warnings = [];
  const setOn = !!(job.set && job.set.on);
  const inService = readScreens(store);
  const chosen = (job.screens || []).map((id) => inService.find((s) => s.id === id)).filter(Boolean);
  if (!chosen.length) xml.push('Choose the screens to map.');
  const comp = compose(chosen, job.arrange);
  const byKey = new Map(cands.map((c) => [c.key, c]));

  const screens = [];
  for (const s of chosen) {
    const topo = screenTopology(store, s.id);
    if (!topo) continue;
    const at = comp.screens.find((p) => p.id === s.id).at;
    const sets = setOn ? readSets(store, s.id) : [];
    const outputs = topo.outputs.map((o) => {
      const k = `${s.id}/${o.key}`;
      const input = (job.inputs || {})[k] || null;
      const regions = outputRegions(o, s.canvas, at);
      const inside = (r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= s.canvas.width && r.y + r.h <= s.canvas.height;
      if (!regions.length) warnings.push(`${s.id} Out ${o.key} is off its screen’s canvas: its Arena output has nothing to show.`);
      else if (!o.regions.every((r) => inside(r.canvas))) warnings.push(`${s.id} Out ${o.key} is partly off its screen’s canvas: Arena feeds only the part on it.`);
      const cand = input ? byKey.get(input) : null;
      return {
        key: o.key,
        name: o.name,
        label: o.label,
        raster: o.raster,
        format: o.format,
        rate: o.rate,
        total: o.total,
        plugs: o.plugs,
        group: o.group,
        members: o.members,
        rotation: o.rotation,
        device: o.device,
        assumptions: assumptionsFor(o),
        footprint: o.footprint,
        regions,
        exact: regions.length > 0 && regions.every((r) => r.exact),
        input,
        candidate: cand || null,
        arena: arenaName(s.id, o.key, input),
        edid: input ? edidChoice(o, plugTemplates(store, input)) : null,
        content: input ? `LIVE_${String(input).replace(/^IN_/, '')}` : null,
        previous: 'NONE'
      };
    });
    if (!outputs.length) xml.push(`${s.id} has no output to feed.`);
    for (const x of topo.skipped) warnings.push(`${s.id} Out ${x.key}: no Arena output — ${x.why}.`);

    const entry = { id: s.id, label: s.label, canvas: s.canvas, at, outputs, assign: false, set: null, setIndex: null, native: null, display: null };
    if (setOn) {
      const fed = outputs.filter((o) => o.input);
      if (!fed.length) {
        warnings.push(`${s.id}: no input chosen, so its background sets are left alone.`);
      } else {
        const setIndex = Number((job.set.index || {})[s.id]) || (firstFreeSet(sets) || {}).index || null;
        const set = sets.find((x) => x.index === setIndex) || null;
        entry.assign = true;
        entry.set = set;
        entry.setIndex = setIndex;
        if (!set) write.push(`${s.id}: no free background set — choose one to overwrite.`);
        else if (set.onProgram && !job.set.allowProgram) write.push(`${s.id}: background set ${set.index} is on program — confirm to write it live.`);
        for (const o of outputs) {
          o.previous = set ? set.contents[o.key] || 'NONE' : 'NONE';
          if (!o.input) {
            if (o.previous !== 'NONE') warnings.push(`${s.id} set ${setIndex} Out ${o.key}: no input chosen — keeps ${o.previous}.`);
            continue;
          }
          if (o.previous !== 'NONE' && o.previous !== o.content) warnings.push(`${s.id} set ${setIndex} Out ${o.key}: replaces ${o.previous}.`);
        }
        const native = nativeLayer(store, s.id);
        entry.native = native;
        entry.display = native.fitted ? null : 'NATIVE layer not allocated — the set can be written, not shown, until it is (Preconfig ▸ Resources)';
      }
    }
    screens.push(entry);
  }

  /* One input per output: two Arena outputs cannot share a cable. */
  const used = new Map();
  for (const s of screens) for (const o of s.outputs) {
    if (!o.input) continue;
    if (used.has(o.input)) xml.push(`${inputWord(o.input)} is chosen for ${used.get(o.input)} and ${s.id} ${o.name} — one input per output.`);
    else used.set(o.input, `${s.id} ${o.name}`);
  }

  if (setOn) {
    if (!screens.some((s) => s.assign)) write.push('Choose the input each Arena output is cabled into, for the outputs whose background should be it.');
    for (const s of screens) {
      if (!s.assign) continue;
      for (const o of s.outputs) {
        const c = o.candidate;
        if (!o.input) continue;
        if (!c) { write.push(`${s.id} ${o.name}: ${inputWord(o.input)} is not a fitted input that can be a background.`); continue; }
        /* The Web RCS offers no background from another frame
           (`canUseOnBackgroundSetOutput`). */
        if (o.device != null && c.device != null && String(o.device) !== String(c.device)) {
          write.push(`${s.id} ${o.name}: ${inputWord(o.input)} is on frame ${c.device} and the output on frame ${o.device} — a background comes from its own frame.`);
        }
        if (c.compatibility.length && !c.compatibility.includes(String(o.key))) warnings.push(`${s.id} ${o.name}: the switcher does not list ${inputWord(o.input)} as compatible with this output.`);
        if (c.usedOnOutput && c.usedOnOutput !== String(o.key)) warnings.push(`${s.id} ${o.name}: ${inputWord(o.input)} is Out ${c.usedOnOutput}’s background now — writing it here moves its claim to Out ${o.key}.`);
        if (job.set.edids && o.edid && o.edid.kind && c.onAir) warnings.push(`${s.id} ${o.name}: ${inputWord(o.input)} is on air in a layer — loading its EDID makes the source behind it renegotiate.`);
        if (job.set.edids && o.edid && !o.edid.kind) warnings.push(`${s.id} ${o.name}: ${o.edid.why} — set the Arena output’s mode by hand.`);
      }
    }
  }

  const name = String(job.name || '').trim() || defaultName(chosen.map((s) => s.id));
  return {
    composition: { width: comp.width, height: comp.height },
    name,
    screens,
    xml: { ok: xml.length === 0, problems: xml },
    write: { ok: setOn && xml.length === 0 && write.length === 0, problems: [...xml, ...write] },
    warnings
  };
}

/** The preset's name when the operator gives none: `LivePremier S1 S2`. */
export const defaultName = (ids) => `LivePremier ${ids.join(' ')}`.trim();

/** The Arena outputs, in composition order: one per switcher output. */
export function arenaOutputs(plan) {
  return plan.screens.flatMap((s) => s.outputs.map((o) => ({ screen: s.id, output: o.key, name: o.arena, width: o.raster.width, height: o.raster.height, regions: o.regions })));
}

/**
 * The plan as an output-map project — Arena's vocabulary: a Screen per
 * switcher output, Virtual, laid left to right on Arena's desktop; a Slice
 * per region, InputRect the composition rectangle, OutputRect the raster
 * quad.
 */
export function arenaProject(plan) {
  const outs = arenaOutputs(plan);
  let x = 0;
  const connectors = outs.map((m, i) => {
    const c = { id: `c${i + 1}`, name: m.name, width: m.width, height: m.height, device: 'virtual', enabled: true, hidden: false, desktop: { x, y: 0 } };
    x += m.width;
    return c;
  });
  const slices = [];
  outs.forEach((m, i) => {
    for (const r of m.regions) {
      slices.push({
        id: `s${slices.length + 1}`,
        connectorId: connectors[i].id,
        name: `${m.screen} Out ${m.output}${m.regions.length > 1 ? ` s${r.slice}` : ''}`,
        enabled: true,
        output: r.output,
        lattice: null,
        input: rectQuad(r.input),
        inputMode: 'manual'
      });
    }
  });
  return {
    name: plan.name,
    composition: { ...plan.composition },
    autoSizeComposition: false,
    layout: { mode: 'pack', gutter: 0, packWidth: plan.composition.width },
    connectors,
    slices
  };
}

/**
 * The Arena preset and the name to save it under. Load it from Output ▸
 * Advanced Output ▸ Presets after copying it into `Documents/Resolume
 * Arena/Presets/Advanced Output/`. Every screen is Virtual: a real display's
 * id is a fact about the playback machine (output-map's resolume-export.md,
 * "Real display outputs"), so each is bound to its connector once, in Arena.
 */
export function arenaPreset(plan) {
  const project = arenaProject(plan);
  return { name: exportFilename(project, 'preset'), xml: exportResolumeXml(project, { target: 'preset' }) };
}

/** How to load it, for the panel and the guide — kept beside the writer so the two agree. */
export const HOW = [
  'Copy the .xml into Documents/Resolume Arena/Presets/Advanced Output/ on the Arena machine.',
  'In Arena, Output ▸ Advanced Output, choose the preset from the Presets list.',
  'Bind each screen to the graphics output cabled into the input its name gives (Device, per screen) — the file has them Virtual.',
  'Set the composition to the size above (Composition ▸ Settings), or the slices read the wrong part of it.'
];

/** What has not been seen working. */
export const UNVERIFIED = 'Written by output-map’s writer, whose every element and parameter was read off files a real Arena 7.27 wrote; no generated preset has yet been opened in Arena.';
