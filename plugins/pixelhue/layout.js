/*
 * Where every control sits on a Pixelhue U5 — the drawing the Pixelhue
 * Mapping page is laid out from.
 *
 * Read off PixelFlow's own virtual U5 (its Event Controller page, served
 * standalone — `pixelhue-re/tools/rig/virtual-panel.mjs`) on 2026-09-23: each
 * key's rectangle, its key code and the console's `keyMode` for it, in the
 * page's own pixels. Nothing here is guessed from photographs; where the
 * vendor's page and the console's reports disagree about a key's name, the
 * report wins (keys 121 / 122 are drawn TOP / BOTTOM and report LAYER UP /
 * DOWN, 505 / 507 — pixelhue-re `docs/console-rig.md`).
 *
 * A key is one of:
 *  - `bus`    a screen / layer / input / preset position; the console labels
 *             it from the published model, so its meaning is fixed here
 *  - `control` a mapped function key — `control` names it in `mapping.js`
 *  - `cluster` the lower-left cluster's keys, whose control depends on the
 *             cluster's page (`CLUSTER_PAGES`)
 *  - `fixed`  a key whose meaning belongs to the console or to a bus
 *             (paging, SAVE TO, DEL, CTRL, LOCK T-BAR, MEDIA), or none at all
 */

export const U5 = Object.freeze({
  model: 'u5',
  width: 1560,
  height: 820,
  keys: Object.freeze([
    ...busRow('screen', [0, 1, 2, 3, 4, 5, 6], 22, 1),
    { key: 7, x: 554, y: 22, kind: 'fixed', label: 'PAGE ▲', what: 'Pages the screen bus. The console pages itself; nothing reaches this app.' },
    ...busRow('screen', [16, 17, 18, 19, 20, 21, 22], 104, 9),
    { key: 23, x: 554, y: 104, kind: 'fixed', label: 'PAGE ▼', what: 'Pages the screen bus. The console pages itself; nothing reaches this app.' },
    ...busRow('layer', [32, 33, 34, 35, 36, 37, 38], 222, 1),
    { key: 39, x: 554, y: 222, kind: 'fixed', label: 'PAGE ▲', what: 'Pages the layer bus.' },
    ...busRow('layer', [48, 49, 50, 51, 52, 53, 54], 304, 9),
    { key: 55, x: 554, y: 304, kind: 'fixed', label: 'PAGE ▼', what: 'Pages the layer bus.' },
    ...busRow('input', [64, 65, 66, 67, 68, 69], 464, 1),
    { key: 70, x: 478, y: 464, kind: 'control', control: 'switchDevice' },
    { key: 71, x: 554, y: 464, kind: 'fixed', label: 'PAGE ▲', what: 'Pages the input bus.' },
    ...busRow('input', [80, 81, 82, 83, 84, 85], 546, 9),
    { key: 86, x: 478, y: 546, kind: 'control', control: 'signalSource' },
    { key: 87, x: 554, y: 546, kind: 'fixed', label: 'PAGE ▼', what: 'Pages the input bus.' },
    ...busRow('preset', [96, 97, 98, 99, 100, 101, 102], 663, 1),
    { key: 103, x: 554, y: 663, kind: 'fixed', label: 'PAGE ▲', what: 'Pages the preset bus.' },
    ...busRow('preset', [112, 113, 114, 115, 116, 117, 118], 745, 9),
    { key: 119, x: 554, y: 745, kind: 'fixed', label: 'PAGE ▼', what: 'Pages the preset bus.' },

    /* The function block. */
    { key: 73, x: 688, y: 523, kind: 'fixed', label: 'SAVE TO', what: 'Arms a store: the next preset key saves the active screen’s edited buffer into that memory — an empty key takes the first free slot. A mode of the preset bus, so it is not remapped.' },
    { key: 74, x: 764, y: 523, kind: 'fixed', label: 'DEL', what: 'Arms a delete: the next preset key deletes that memory. A screen key pressed while armed reports “delete screen”, which this app never acts on.' },
    { key: 75, x: 840, y: 523, kind: 'fixed', label: 'MEDIA', what: 'Reports no command — only a media-state change, and the cluster’s lamps turn into media transport. Nothing to map it to yet.' },
    { key: 76, x: 916, y: 523, kind: 'control', control: 'mvr' },
    { key: 89, x: 688, y: 597, kind: 'fixed', label: 'CTRL', what: 'A modifier. Alone it reports nothing; held with TIME it turns TIME into CTRL + TIME.' },
    { key: 90, x: 764, y: 597, kind: 'control', control: 'pgmEdit' },
    { key: 91, x: 840, y: 597, kind: 'control', control: 'matchPGM' },
    { key: 92, x: 916, y: 597, kind: 'control', control: 'lockPanel' },
    { key: 105, x: 688, y: 671, kind: 'cluster', slot: 0 },
    { key: 106, x: 764, y: 671, kind: 'cluster', slot: 1 },
    { key: 107, x: 840, y: 671, kind: 'cluster', slot: 2 },
    { key: 121, x: 688, y: 745, kind: 'cluster', slot: 3 },
    { key: 122, x: 764, y: 745, kind: 'cluster', slot: 4 },
    { key: 123, x: 840, y: 745, kind: 'fixed', label: '', what: 'Unbound on the U5’s default layout: it reports nothing, so there is nothing to map.' },
    { key: 124, x: 916, y: 685, h: 120, kind: 'clusterPage', label: 'PAGE' },
    { key: 77, x: 1022, y: 523, kind: 'control', control: 'freeze' },
    { key: 78, x: 1098, y: 523, kind: 'control', control: 'ftb' },
    { key: 79, x: 1174, y: 523, kind: 'fixed', label: 'LOCK T-BAR', what: 'The console’s own: while it is on the T-bar reports nothing.' },
    { key: 93, x: 1022, y: 597, kind: 'control', control: 'swap' },
    { key: 94, x: 1098, y: 597, kind: 'control', control: 'time', also: 'ctrlTime' },
    { key: 95, x: 1174, y: 597, kind: 'fixed', label: '', what: 'Unbound on the U5’s default layout: it reports nothing, so there is nothing to map.' },
    { key: 125, x: 1022, y: 745, w: 92, kind: 'control', control: 'cut', lamp: 'red' },
    { key: 127, x: 1144, y: 745, w: 92, kind: 'control', control: 'take', lamp: 'green' },
  ].map((k) => Object.freeze({ w: 60, h: 60, ...k }))),

  /* Bus section headings, as the console prints them across its key rows. */
  bars: Object.freeze([
    { x: 22, y: 178, w: 592, left: 'SCREEN', right: 'LAYER' },
    { x: 22, y: 620, w: 592, left: 'SIGNAL', right: 'PRESET' },
  ]),

  encoders: Object.freeze([692, 840, 988, 1136].map((x, i) => ({ id: `encoder.${i + 1}`, x, y: 31, w: 144, h: 135 }))),
  faders: Object.freeze([735, 806, 877, 948, 1020, 1091, 1162, 1233].map((x, i) => ({ id: `fader.${i + 1}`, x, y: 193, w: 30, h: 232 }))),
  tbar: Object.freeze({ x: 1312, y: 460, w: 218, h: 340 }),

  /* The lower-left cluster's five paged keys (slots 0–4 above), page by
     page. Page 2 has nothing on a U5's default layout; page 3 only SOURCE
     BACKUP, which reports no command and is read from its raw press. */
  clusterPages: Object.freeze([
    { label: 'Layer', slots: ['layerFullOutput', 'layerCopy', 'layerMirror', 'layerUp', 'layerDown'] },
    { label: 'Cue', slots: ['cuePlay', 'cueRestart', 'cueStop', 'cuePrevious', 'cueNext'] },
    { label: '—', slots: [null, null, null, null, null] },
    { label: 'Source', slots: ['sourceBackup', null, null, null, null] },
  ]),

  /* Controls a U5's default layout has no key for; they are mapped all the
     same, for a U5 Pro or a custom layout that does. */
  elsewhere: Object.freeze(['layerFullscreen', 'layerTop', 'layerBottom', 'layerCutout']),
});

/* Seven keys of a bus row, 76 px apart, numbered from `first` — the console
   skips the page key's position, so a row's second half starts at 9. */
function busRow(bus, keys, y, first) {
  return keys.map((key, i) => ({ key, x: 22 + i * 76, y, kind: 'bus', bus, position: first + i }));
}

export const BUS_WHAT = Object.freeze({
  screen: 'Selects that screen (press), makes a selected one active — its layers take the layer bus (press again), and drops it (long press).',
  layer: 'Selects that layer of the active screen, for the input bus and the encoders.',
  input: 'Puts that source on the selected layer, in the buffer the panel edits.',
  preset: 'Recalls that memory to preview on every selected screen. With SAVE TO armed it stores there; with DEL armed it deletes.',
});
