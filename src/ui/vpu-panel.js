/*
 * The VPU map.
 *
 * A LivePremier configuration either fits in the mixing resources the chassis
 * has, or it does not, and the stock UI tells you which only by refusing the
 * configuration. This draws the budget instead.
 *
 * The main view is the **link grid**, which is how Analog Way's own manual
 * draws a VPU (§5.5): an 8x8 field of links, layer links in from the left,
 * output links out through the top and bottom. A layer occupies a block; the
 * columns are the output links the device itself reports, and the rows are
 * packed, because nothing in the object model names the layer link. The
 * vertical rule at four columns is the scaling-engine boundary — and it is
 * deliberately not drawn on a VPU in Optimized mode, which removes it.
 *
 * All of the derivation is the shared model in `core/vpu.js`; this file only
 * draws. Nothing here writes to the device — every property involved is
 * readOnly in the device's own model.
 */

import { h, button, readout, sectionTitle } from './dom.js';
import { panel } from './shell.js';
import { whyNot } from '../core/platform.js';
import { screenColour } from './theme.js';
import {
  readSide, diffSides, inspectMapping, layerLabel, layerShort,
  LINKS_PER_VPU, SCALING_ENGINE_BOUNDARY
} from '../core/vpu.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

const CELL = 26;
const FIELD = LINKS_PER_VPU * CELL;
const PAD_L = 30;
const PAD_T = 20;
const HEAD = 13;      // the screen bar over the output links
const BAND_GAP = 10;  // between the field and the native-layer band

function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const c of children) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

export function createVpuPanel({ session, platform = null, onRefresh }) {
  const view = { which: 'current', device: null, detail: false };

  function render() {
    const store = session.store;
    if (!store.ready) {
      return panel({ toolbar: title(), body: h('div', { class: 'wru-empty', text: 'Waiting for the device store…' }) });
    }

    /*
     * A switcher with no VPU at all is a different statement from a switcher
     * whose VPU we cannot read. Midra 4K and Alta 4K allocate nothing — their
     * processing is fixed — so say that, rather than reaching for one of the
     * "we looked and the map was missing" explanations below, which would
     * invite someone to go hunting for a path that was never there.
     *
     * The sidebar entry is normally gone by now anyway; this covers the moment
     * before the store lands and any route that opens the panel directly.
     */
    const here = platform ? platform() : null;
    const why = here ? whyNot(here, 'vpuMap') : null;
    if (why) {
      return panel({
        toolbar: title(),
        body: h('div', { class: 'wru-empty' },
          h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: 'No VPU on this switcher' }),
          h('div', { style: { maxWidth: '46rem', margin: '0 auto' }, text: why }),
          h('div', { class: 'aw-font-caption aw-text-tertiary aw-margin-top-medium',
            text: `${here.name}${here.model ? ' · ' + here.model : ''}` }))
      });
    }

    const side = readSide(store, view.which);
    if (!side) return panel({ toolbar: title(), body: unavailable(store) });

    const diffs = diffSides(store);
    const changed = new Set(
      diffs.flatMap((d) => d.changes.map((c) => d.device + '/' + c.mixer)));

    if (!view.device || !side.devices.some((d) => d.key === view.device)) {
      view.device = side.devices[0].key;
    }
    const device = side.devices.find((d) => d.key === view.device);

    return panel({
      toolbar: title(side, diffs),
      body: h('div', {},
        summary(device, side),
        grids(device, changed),
        screenTable(store, side),
        diffs.length ? changeList(diffs) : null,
        view.detail ? detail(device) : null)
    });
  }

  /**
   * A device with no mixer map is not the same as a device with an empty one,
   * and the difference is worth spelling out rather than drawing 64 grey boxes.
   */
  function unavailable(store) {
    const info = inspectMapping(store, view.which);
    const messages = {
      simulator: [
        'No VPU mixer map on this device',
        'This box reports a vpuLayerList collection and no vpuMixerList. That is what a ' +
        'LivePremier simulator looks like: the collection exists but is permanently empty, ' +
        'and $vpuLayer answers E12 on real hardware. There is no allocation here to draw — ' +
        'the panel is working, the simulator simply has no VPU.'
      ],
      'no-mixer-collection': [
        'No VPU mixer map on this device',
        'The resource mapping is present but carries no vpuMixerList. Either this firmware ' +
        'reports the allocation somewhere else, or the chassis has no VPU fitted.'
      ],
      'no-mapping': [
        'No resource mapping reported',
        'Nothing at preconfig/resources/' + view.which + '/status/mapping. On a firmware ' +
        'this build does not know, that path may have moved.'
      ]
    };
    const [heading, body] = messages[info.reason] || messages['no-mapping'];
    return h('div', { class: 'wru-empty' },
      h('div', { class: 'aw-font-subtitle-1 aw-margin-bottom-medium', text: heading }),
      h('div', { style: { maxWidth: '46rem', margin: '0 auto' }, text: body }));
  }

  function title(side, diffs) {
    const devices = side ? side.devices : [];
    return [
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-large' },
        h('div', { class: 'aw-font-subtitle-1', text: 'VPU Resources' }),
        diffs && diffs.length
          ? h('span', {
              class: 'wru-tag wru-warn',
              text: diffs.reduce((n, d) => n + d.changes.length, 0) + ' staged change'
                + (diffs.reduce((n, d) => n + d.changes.length, 0) === 1 ? '' : 's')
            })
          : null),
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
        devices.length > 1
          ? devices.map((d) => button(d.role, {
              onClick: () => { view.device = d.key; onRefresh(); },
              active: view.device === d.key, variant: 'ghost'
            }))
          : null,
        button('Current', { onClick: () => { view.which = 'current'; onRefresh(); }, active: view.which === 'current' }),
        button('Staged', { onClick: () => { view.which = 'new'; onRefresh(); }, active: view.which === 'new' }),
        button('Detail', { onClick: () => { view.detail = !view.detail; onRefresh(); }, active: view.detail, variant: 'ghost' }))
    ];
  }

  function summary(device, side) {
    const sum = device.summary;
    const bar = h('div', { class: 'wru-bar aw-margin-top-small' });
    for (const a of sum.allocations) {
      bar.append(h('span', {
        style: { width: (a.mixers.length / Math.max(1, sum.fitted) * 100) + '%', background: screenColour(a.screen) },
        title: `${a.screen} ${layerLabel(a.layer)}: ${a.mixers.length} mixer${a.mixers.length === 1 ? '' : 's'}`
      }));
    }
    if (sum.spare > 0) {
      bar.append(h('span', {
        style: { width: (sum.spare / Math.max(1, sum.fitted) * 100) + '%', background: '#283239' },
        title: sum.spare + ' spare'
      }));
    }

    return h('div', { class: 'aw-margin-bottom-large' },
      h('div', { class: 'aw-flex-row aw-gap-col-massive aw-margin-bottom-small aw-flex-wrap' },
        readout('Fitted', `${sum.fitted} of ${sum.max}`),
        readout('Allocated', sum.enabled),
        readout('Spare', sum.spare, { tone: sum.spare > 0 ? 'green' : 'red' }),
        readout('Screens', sum.screens),
        readout('Layer runs', sum.allocations.length),
        side.devices.length > 1 ? readout('Device', device.role) : null),
      bar,
      h('div', { class: 'wru-legend aw-margin-top-medium' },
        ...[...new Set(sum.allocations.map((a) => a.screen))].map((screen) =>
          h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
            h('span', { class: 'wru-swatch', style: { background: screenColour(screen) } }),
            h('span', { class: 'aw-font-body-2', text: String(screen) }))),
        h('span', { class: 'aw-flex-row-center-v aw-gap-col-mini' },
          h('span', { class: 'wru-swatch', style: { background: '#283239', border: '0.1rem solid #49535B' } }),
          h('span', { class: 'aw-font-body-2', text: 'spare' })),
        h('span', { class: 'aw-font-body-2 aw-text-tertiary', text: '· hatched block = an added layer, not the native one' })));
  }

  function grids(device, changed) {
    const drawn = device.grids.filter((g) => g.fitted || g.blocks.length);
    if (!drawn.length) {
      return h('div', { class: 'wru-empty', text: 'No VPU fitted on ' + device.role + '.' });
    }
    return h('div', { class: 'aw-margin-bottom-large' },
      sectionTitle('Link grid',
        h('span', {
          class: 'aw-font-body-2 aw-text-tertiary',
          text: drawn[0].placement === 'derived'
            ? 'columns derived — this capture reports no output links'
            : 'a row is one layer link, carrying one layer; columns are each screen’s own output links'
        })),
      h('div', { class: 'aw-flex-row aw-flex-wrap aw-gap-col-large aw-gap-row-large' },
        ...drawn.map((g) => vpuBlock(g, device, changed))));
  }

  function vpuBlock(grid, device, changed) {
    const optimized = device.optimized.has(grid.vpu);
    return h('div', { class: 'wru-vpu-device' },
      h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium aw-margin-bottom-small' },
        h('div', { class: 'aw-font-body-1-bold', text: 'VPU ' + grid.vpu }),
        grid.fitted
          ? h('span', {
              class: 'wru-tag',
              text: grid.rowsUsed + '/' + LINKS_PER_VPU + ' layer links' +
                (grid.backgroundRows ? ', ' + grid.backgroundRows + ' native' : '') +
                (grid.spare ? ', ' + grid.spare + ' spare' : '')
            })
          : h('span', { class: 'wru-tag', text: 'not fitted' }),
        optimized ? h('span', { class: 'wru-tag wru-tag--good', text: 'optimized' }) : null,
        grid.overflow ? h('span', { class: 'wru-tag wru-warn', text: 'overflows 8 links' }) : null),
      vpuSvg(grid, optimized, device, changed));
  }

  function vpuSvg(grid, optimized, device, changed) {
    /* Native layers spend output capacity but not layer capacity, so they are laid
       out in a band under the eight links rather than inside them, and the screen
       bar over the top says which output links belong to which screen. */
    const bandRows = grid.backgroundRows || 0;
    const screens = grid.screens || [];
    const head = screens.length ? HEAD + 3 : 0;
    const bandTop = head + PAD_T + FIELD + (bandRows ? BAND_GAP : 0);
    const bandH = bandRows * CELL;

    const W = PAD_L + FIELD + 12;
    const H = bandTop + bandH + PAD_T;
    const x0 = PAD_L;
    const y0 = head + PAD_T;
    const yOf = (row) =>
      row >= LINKS_PER_VPU ? bandTop + (row - LINKS_PER_VPU) * CELL : y0 + row * CELL;

    const root = s('svg', {
      class: 'wru-vpu-svg' + (grid.fitted ? '' : ' wru-vpu-svg--unfitted'),
      viewBox: `0 0 ${W} ${H}`,
      role: 'img',
      'aria-label': `VPU ${grid.vpu}, ${grid.blocks.length} layer blocks`
    });

    /* A screen owns a contiguous run of output links (manual 5.5.4), and all of
       its layers start at the same one. Without this bar the columns are unreadable. */
    for (const sc of screens) {
      const sx = x0 + sc.col * CELL;
      const sw = sc.width * CELL;
      const g = s('g', { class: 'wru-screen-bar', style: `color:${screenColour(sc.screen)}` });
      g.append(s('title', {}, `${sc.screen} · output link${sc.width === 1 ? '' : 's'} 1-${sc.width}`));
      g.append(s('rect', { x: sx + 1, y: 2, width: sw - 2, height: HEAD, rx: 2 }));
      g.append(s('text', { x: sx + sw / 2, y: 2 + HEAD - 3 }, String(sc.screen)));
      root.append(g);
    }

    root.append(s('rect', { class: 'wru-field', x: x0, y: y0, width: FIELD, height: FIELD, rx: 2 }));
    if (bandRows) {
      root.append(
        s('rect', { class: 'wru-field wru-band', x: x0, y: bandTop, width: FIELD, height: bandH, rx: 2 }),
        s('text', { class: 'wru-band-label', x: x0 - 4, y: bandTop + bandH / 2 + 3 }, 'bg'));
    }

    for (let i = 1; i < LINKS_PER_VPU; i++) {
      root.append(
        s('line', { class: 'wru-lattice', x1: x0 + i * CELL, y1: y0, x2: x0 + i * CELL, y2: y0 + FIELD }),
        s('line', { class: 'wru-lattice', x1: x0, y1: y0 + i * CELL, x2: x0 + FIELD, y2: y0 + i * CELL }));
      if (bandRows) {
        root.append(s('line', {
          class: 'wru-lattice', x1: x0 + i * CELL, y1: bandTop, x2: x0 + i * CELL, y2: bandTop + bandH }));
      }
    }
    for (let i = 1; i < bandRows; i++) {
      root.append(s('line', {
        class: 'wru-lattice', x1: x0, y1: bandTop + i * CELL, x2: x0 + FIELD, y2: bandTop + i * CELL }));
    }

    /* Layer links in from the left, output links out top and bottom — the
       manual's own orientation, and the reason the grid reads as a VPU. There are
       eight layer links and they belong to the field, not to the band. */
    for (let i = 0; i < LINKS_PER_VPU; i++) {
      const cy = y0 + i * CELL + CELL / 2;
      root.append(s('line', { class: 'wru-link-in', x1: x0 - 22, y1: cy, x2: x0 - 4, y2: cy }));
      const cx = x0 + i * CELL + CELL / 2;
      root.append(
        s('line', { class: 'wru-link-out', x1: cx, y1: y0 - 13, x2: cx, y2: y0 - 3 }),
        s('line', {
          class: 'wru-link-out',
          x1: cx, y1: bandTop + bandH + 3, x2: cx, y2: bandTop + bandH + 13 }),
        s('text', { class: 'wru-link-no', x: cx, y: y0 - 16 }, String(i + 1)));
    }

    for (const b of grid.blocks) {
      const colour = screenColour(b.screen);
      const cols = b.cols && b.cols.length ? b.cols : [b.col || 0];
      const span = b.size || 1;
      const rows = b.height || span;
      const by = yOf(b.row);
      const bh = rows * CELL;
      const isNative = b.background || b.layer === 'NATIVE';
      const mixers = b.mixers || [b.mixer];
      const slices = b.slices || [b.slice];
      const isChanged = mixers.some((m) => changed.has(device.key + '/' + m));

      const first = cols[0];
      const last = cols[cols.length - 1];
      const bx = x0 + first * CELL;
      const bw = (last - first + span) * CELL;

      const g = s('g', { class: 'wru-blk', style: `color:${colour}` });
      g.append(s('title', {},
        `${mixers.join(', ')}\n${b.screen} · ${layerLabel(b.layer)}` +
        `\nslice${slices.length === 1 ? '' : 's'} ${slices.join(', ')}` +
        `\ncapability ${b.capability}` +
        (isNative
          ? '\nnative layer — spends output capacity, not layer capacity'
          : `\n${rows} layer-capacity link${rows === 1 ? '' : 's'}`) +
        (b.cutnfill && b.cutnfill !== 'OFF' ? `\ncut & fill ${b.cutnfill}` : '') +
        `\n${b.screen} output link${(b.outputs || cols).length === 1 ? '' : 's'} ` +
        `${(b.outputs || cols.map((c) => c + 1)).join(', ')}` +
        (b.wrapped ? '\nwrapped onto another layer link at the centre line' : '') +
        (isChanged ? '\nCHANGED in the staged configuration' : '')));

      /* Adjacent links are one continuous crosspoint; only a gap in what the
         device reports breaks the block. Nothing gapped survives the model as it
         stands, but a firmware that reports differently should still draw. */
      const runs = [];
      for (const c of cols) {
        const tail = runs[runs.length - 1];
        if (tail && c === tail[1] + 1) tail[1] = c;
        else runs.push([c, c]);
      }
      if (runs.length > 1) {
        g.append(s('rect', {
          class: 'wru-span', x: bx + 1.5, y: by + 1.5, width: bw - 3, height: bh - 3, rx: 2 }));
      }
      for (const [from, to] of runs) {
        g.append(s('rect', {
          class: 'wru-cell' + (isNative ? '' : ' wru-cell--layered') + (isChanged ? ' wru-cell--changed' : ''),
          x: x0 + from * CELL + 1.5,
          y: by + 1.5,
          width: (to - from + span) * CELL - 3,
          height: bh - 3,
          rx: 2
        }));
      }

      if (bh >= 34) {
        g.append(s('text', { class: 'wru-cell-label', x: bx + CELL / 2, y: by + bh / 2 - 2 }, String(b.screen)));
        g.append(s('text', { class: 'wru-cell-sub', x: bx + CELL / 2, y: by + bh / 2 + 8 }, layerShort(b.layer)));
      } else {
        g.append(s('text', {
          class: 'wru-cell-label wru-cell-label--sm', x: bx + 4, y: by + bh / 2 + 3
        }, `${b.screen} ${layerShort(b.layer)}`));
      }
      if (slices.length > 1 && bh >= 20) {
        g.append(s('text', { class: 'wru-cell-sub wru-cell-count', x: bx + bw - 3, y: by + bh - 3 },
          '×' + slices.length));
      }

      /* The manual's hook: this piece took another layer link because the layer
         reached past the centre line (5.5.4). */
      if (b.wrapped) {
        const hx = bx - 8;
        g.append(s('path', {
          class: 'wru-hook',
          d: `M${hx},${by - 8} L${hx},${by + bh / 2 - 4} q0,4 4,4 L${bx - 1},${by + bh / 2}`
        }));
      }
      root.append(g);
    }

    /* The scaling-engine boundary at four output links. Drawn on every VPU: a
       layer-capacity link cannot cross it, which is why layers reaching both
       halves are split in two. Optimized mode lifts it for capacity-2 layers
       only (5.5.6), so there it is drawn quieter rather than hidden. */
    const bcls = 'wru-boundary' + (optimized ? ' wru-boundary--soft' : '');
    const bnd = x0 + SCALING_ENGINE_BOUNDARY * CELL;
    root.append(s('line', { class: bcls, x1: bnd, y1: y0, x2: bnd, y2: y0 + FIELD }));
    if (bandRows) {
      root.append(s('line', { class: bcls, x1: bnd, y1: bandTop, x2: bnd, y2: bandTop + bandH }));
    }
    return root;
  }

  /**
   * The device's own answer to "does this fit".
   *
   * The remaining and exceeding figures exist only on the staged side, because
   * that is the side the question is about.
   */
  function screenTable(store, side) {
    const entries = Object.entries(side.screenStatus);
    if (!entries.length) return null;
    const staged = view.which === 'new';

    return h('div', { class: 'aw-margin-bottom-large' },
      sectionTitle('Screens', h('span', {
        class: 'aw-font-body-2 aw-text-tertiary',
        text: staged ? 'staged configuration' : 'running configuration'
      })),
      h('table', { class: 'wru-cuelist' },
        h('thead', {}, h('tr', {}, ...['Screen', 'Mode', 'Outputs', 'Used', 'Remaining', 'Layers', 'Optimized', '']
          .map((t) => h('th', { text: t })))),
        h('tbody', {}, ...entries.map(([id, st]) => {
          const exceeding = Number(st.exceedingOutputCapabilities || 0)
            + Number(st.exceedingLayerCapabilities || 0);
          return h('tr', { class: 'wru-cue' },
            h('td', {}, h('span', { class: 'wru-swatch aw-margin-right-small', style: { background: screenColour(id) } }), id),
            h('td', { class: 'aw-text-secondary', text: st.mode ?? '—' }),
            h('td', { text: st.outputCount ?? '—' }),
            h('td', { text: st.usedOutputCapabilities ?? '—' }),
            h('td', { text: st.remainingOutputCapabilities ?? '—' }),
            h('td', { text: st.layerCount ?? '—' }),
            h('td', { text: st.isOptimized ? 'yes' : 'no' }),
            h('td', {}, exceeding
              ? h('span', { class: 'wru-tag wru-warn', text: 'exceeds by ' + exceeding })
              : (st.remainingOutputCapabilities !== undefined
                  ? h('span', { class: 'wru-tag wru-tag--good', text: 'fits' })
                  : null)));
        }))));
  }

  function changeList(diffs) {
    return h('div', { class: 'aw-margin-bottom-large' },
      sectionTitle('Staged against running'),
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        ...diffs.flatMap((d) => d.changes.slice(0, 40).map((c) =>
          h('div', { class: 'aw-font-body-2' },
            h('span', { class: 'aw-font-body-1-bold', text: (diffs.length > 1 ? d.device + '/' : '') + c.mixer + ' ' }),
            h('span', {
              class: 'aw-text-secondary',
              text: c.changed.map((ch) => `${ch.prop}: ${fmt(ch.from)} → ${fmt(ch.to)}`).join(', ')
            })))),
        h('div', {
          class: 'aw-text-tertiary aw-margin-top-small',
          text: 'Output links count as changes: a staged configuration can move a layer onto different links with every other value identical.'
        })));
  }

  const fmt = (v) => (v === undefined || v === null ? '—' : String(v));

  function detail(device) {
    const rows = Object.entries(device.mixers)
      .filter(([, r]) => r && r.isAvailable)
      .map(([id, r]) => h('tr', { class: 'wru-cue' },
        h('td', { class: 'wru-cue-number', text: id.replace(/^PROC_(\d+)_MIXER_(\d+)$/, 'P$1·$2') }),
        h('td', { text: r.isEnabled ? String(r.usedInScreen) : '—' }),
        h('td', { text: r.isEnabled ? layerLabel(r.usedInLayer) : 'spare' }),
        h('td', { text: r.slice ?? '—' }),
        h('td', { text: r.capability ?? '—' }),
        h('td', { text: r.cutnfillCapa ?? '—' }),
        h('td', { text: r.seamlessCapa ? 'yes' : 'no' }),
        h('td', {
          text: Object.entries(r.mixerAllocation || {})
            .filter(([, v]) => v && v !== 'NONE')
            .map(([k, v]) => k.replace('usedOnOutPipe', '') + '→' + v).join(' ') || '—'
        })));

    return h('div', {},
      sectionTitle('Every fitted mixer'),
      h('table', { class: 'wru-cuelist' },
        h('thead', {}, h('tr', {}, ...['Mixer', 'Screen', 'Layer', 'Slice', 'Capability', 'Cut & fill', 'Seamless', 'Links']
          .map((t) => h('th', { text: t })))),
        h('tbody', {}, ...rows)));
  }

  return { render, view };
}
