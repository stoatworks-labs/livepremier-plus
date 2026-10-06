/*
 * Background Slicer — what a media server needs to feed the backgrounds.
 *
 * In the live-input mode each output's background is an input, and whatever
 * plays into that input has to put exactly the right part of the content on
 * exactly the right pixels — which is the cut the stills mode makes, done by
 * the media server instead. So a plan's blits ARE the media server's output
 * map: one media-server output per switcher input (sized to the switcher
 * output it backs), one slice per blit, reading a rectangle of the content
 * and writing it to a rectangle of that output.
 *
 * Built here, as strings, with no DOM and no I/O:
 *
 *   - `regionRows`      the map as rows — the source of every file below
 *   - `toCsv`/`toJson`  the universal pixel map, for any server and for people
 *   - `templateShapes`  rectangles and labels for the SVG and PNG templates;
 *     `templateSvg` draws them as SVG (the panel paints the same shapes into
 *     a canvas for the PNG, so the two cannot differ)
 *   - `toResolume`      a Resolume Arena Advanced Output preset, written by
 *     output-map's own writer (`src/vendor/output-map/resolume.js`), which is
 *     held to files a real Arena 7.27 wrote
 *   - `TARGETS`         per media server: what it can import, and how to set
 *     it up from the pack where it cannot
 *
 * Which formats are real imports and which are a manual recipe is the
 * research written up in docs/BACKGROUNDS.md; nothing here invents a format a
 * server has not been seen to read.
 */

import { blitTransform, isExact } from './core.js';
import { exportResolumeXml } from '../../src/vendor/output-map/resolume.js';

const round = (n) => Math.round(n * 1000) / 1000;
const r4 = (r) => ({ x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) });

/**
 * The name of the media-server output that backs one switcher output. In
 * the live mode it is named after the input it plugs into, because that is
 * the cable an operator follows; in the stills mode after the output.
 */
export function mediaOutputName(screen, output) {
  const where = `${screen.id} ${outWord(output.key)}`;
  if (output.input) return `IN ${String(output.input).replace(/^(?:IN|INPUT)_/, '')} → ${where}`;
  return where;
}

/**
 * How an output is named in a file: `Out 3`, or `canvas` for the one image a
 * Midra or Alta screen takes (`mng.js`, `CANVAS_KEY`). `tight` drops the
 * space, for identifiers.
 */
const outWord = (key, tight = false) => (key === 'canvas' ? 'canvas' : `Out${tight ? '' : ' '}${key}`);

/**
 * One row per blit: which content rectangle lands where on which
 * media-server output. Rows are the single source the CSV, JSON, templates
 * and Arena preset are all built from.
 */
export function regionRows(plan) {
  const rows = [];
  for (const s of plan.screens) {
    for (const o of s.outputs) {
      o.blits.forEach((b, i) => {
        rows.push({
          screen: s.id,
          set: s.setIndex,
          output: o.key,
          outputName: o.name,
          mediaOutput: mediaOutputName(s, o),
          input: o.input || null,
          still: o.still || null,
          width: o.raster.width,
          height: o.raster.height,
          format: o.format || '',
          rateHz: o.rate ? o.rate / 1000 : null,
          slice: b.region,
          part: i + 1,
          rotation: b.rotation,
          content: r4(b.src),
          raster: r4(b.dst),
          exact: isExact(b),
          blit: b
        });
      });
    }
  }
  return rows;
}

/** The media-server outputs: one per switcher output that carries any content. */
export function mediaOutputs(plan) {
  const out = [];
  for (const s of plan.screens) {
    for (const o of s.outputs) {
      out.push({
        name: mediaOutputName(s, o),
        screen: s.id,
        output: o.key,
        input: o.input || null,
        width: o.raster.width,
        height: o.raster.height,
        format: o.format || '',
        rateHz: o.rate ? o.rate / 1000 : null,
        rotation: o.rotation
      });
    }
  }
  return out;
}

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The universal pixel map as CSV: one line per region, every number in pixels. */
export function toCsv(plan, content) {
  const head = ['media_output', 'switcher_input', 'screen', 'background_set', 'switcher_output', 'output_width', 'output_height',
    'format', 'rate_hz', 'slice', 'part', 'rotation_ccw', 'content_x', 'content_y', 'content_w', 'content_h',
    'output_x', 'output_y', 'output_w', 'output_h', 'pixel_exact', 'content_width', 'content_height'];
  const lines = [head.join(',')];
  for (const r of regionRows(plan)) {
    lines.push([
      r.mediaOutput, r.input || '', r.screen, r.set ?? '', r.output, r.width, r.height, r.format, r.rateHz ?? '',
      r.slice, r.part, r.rotation, r.content.x, r.content.y, r.content.w, r.content.h,
      r.raster.x, r.raster.y, r.raster.w, r.raster.h, r.exact ? 'yes' : 'no', content.width, content.height
    ].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** The universal pixel map as JSON — the same rows, grouped per media-server output. */
export function toJson(plan, content, meta = {}) {
  const rows = regionRows(plan);
  return JSON.stringify({
    generator: 'LivePremier Plus — Background Slicer',
    version: 1,
    note: 'Every rectangle is in pixels. A region copies content[x,y,w,h] to output[x,y,w,h] of its media output; rotation is counter-clockwise, as the switcher states its output rotation.',
    ...meta,
    content: { width: content.width, height: content.height },
    mediaOutputs: mediaOutputs(plan).map((m) => ({
      ...m,
      regions: rows.filter((r) => r.screen === m.screen && r.output === m.output).map((r) => ({
        slice: r.slice, part: r.part, rotation: r.rotation, content: r.content, output: r.raster, pixelExact: r.exact
      }))
    }))
  }, null, 2) + '\n';
}

/* ------------------------------------------------------------ templates */

const PALETTE = ['#2185D0', '#F39910', '#00B5AD', '#A333C8', '#E03997', '#21BA45', '#FBBD08', '#DB2828'];

/**
 * What a template draws: `which` is `content` (the whole content canvas with
 * every region marked) or a media-output name (that output's raster with the
 * content each region carries). `{ width, height, title, rects: [{ x, y, w, h,
 * color, label, sub }] }`.
 */
export function templateShapes(plan, content, which = 'content') {
  const rows = regionRows(plan);
  const outs = mediaOutputs(plan);
  const colourOf = (name) => PALETTE[outs.findIndex((o) => o.name === name) % PALETTE.length];
  if (which === 'content') {
    return {
      width: content.width,
      height: content.height,
      title: `Content ${content.width} × ${content.height}`,
      rects: rows.map((r) => ({
        ...r.content,
        color: colourOf(r.mediaOutput),
        label: `${r.screen} ${outWord(r.output)}${r.slice > 1 || rows.some((x) => x.output === r.output && x.screen === r.screen && x !== r) ? ` · slice ${r.slice}` : ''}`,
        sub: `${Math.round(r.content.w)} × ${Math.round(r.content.h)} → ${r.mediaOutput}${r.rotation ? ` · turned ${r.rotation}°` : ''}`
      }))
    };
  }
  const m = outs.find((o) => o.name === which);
  if (!m) return null;
  return {
    width: m.width,
    height: m.height,
    title: `${m.name} · ${m.width} × ${m.height}${m.rateHz ? ` @ ${m.rateHz} Hz` : ''}`,
    rects: rows.filter((r) => r.mediaOutput === m.name).map((r) => ({
      ...r.raster,
      color: colourOf(r.mediaOutput),
      label: `content ${Math.round(r.content.x)},${Math.round(r.content.y)}`,
      sub: `${Math.round(r.raster.w)} × ${Math.round(r.raster.h)}${r.rotation ? ` · turned ${r.rotation}°` : ''}`
    }))
  };
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A template as SVG: the canvas, each rectangle outlined and labelled with its size. */
export function templateSvg(shapes) {
  const { width, height } = shapes;
  const font = Math.max(12, Math.round(Math.min(width, height) / 40));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#101418"/>`,
    `<text x="${font / 2}" y="${height - font / 2}" fill="#7f8a93" font-family="Helvetica, Arial, sans-serif" font-size="${font}">${xml(shapes.title)}</text>`
  ];
  for (const r of shapes.rects) {
    const f = Math.max(10, Math.min(font, Math.round(Math.min(r.w, r.h) / 8)));
    parts.push(
      `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.color}" fill-opacity="0.18" stroke="${r.color}" stroke-width="2"/>`,
      `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2}" fill="#ffffff" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${f}" font-weight="bold">${xml(r.label)}</text>`,
      `<text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + f * 1.3}" fill="#d0d6db" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(f * 0.75)}">${xml(r.sub)}</text>`
    );
  }
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

/* -------------------------------------------------------------- Resolume */

/** Four corners, corner 0 first then clockwise, of a rectangle. */
const rectQuad = (r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }];

/**
 * A blit's output quad in Arena's own corner order: corner 0 is where the
 * content's top-left lands, so a turned region is written as a turned quad
 * (output-map: `orientation` is derived from corner 0 → 1, as Arena does).
 */
export function outputQuad(blit) {
  const [a, b, c, d, e, f] = blitTransform(blit);
  const at = (u, v) => ({ x: round(a * u + c * v + e), y: round(b * u + d * v + f) });
  return [at(0, 0), at(blit.lw, 0), at(blit.lw, blit.lh), at(0, blit.lh)];
}

/** The plan as an output-map project — Arena's vocabulary: a Screen per media output, a Slice per region. */
export function resolumeProject(plan, content, name = 'LivePremier backgrounds') {
  const outs = mediaOutputs(plan);
  const rows = regionRows(plan);
  let x = 0;
  const connectors = outs.map((m, i) => {
    const c = { id: `c${i + 1}`, name: m.name, width: m.width, height: m.height, device: 'virtual', enabled: true, hidden: false, desktop: { x, y: 0 } };
    x += m.width;
    return c;
  });
  const slices = rows.map((r, i) => {
    const c = connectors[outs.findIndex((m) => m.name === r.mediaOutput)];
    return {
      id: `s${i + 1}`,
      connectorId: c.id,
      name: `${r.screen} ${outWord(r.output)}${r.slice > 1 ? ` s${r.slice}` : ''}${r.part > 1 ? ` p${r.part}` : ''}`,
      enabled: true,
      output: outputQuad(r.blit),
      lattice: null,
      input: rectQuad(r.content),
      inputMode: 'manual'
    };
  });
  return {
    name,
    composition: { width: content.width, height: content.height },
    autoSizeComposition: false,
    layout: { mode: 'pack', gutter: 0, packWidth: content.width },
    connectors,
    slices
  };
}

/**
 * The Arena preset. Load it from Output ▸ Advanced Output ▸ Presets after
 * copying it into `Documents/Resolume Arena/Presets/Advanced Output/`. Every
 * screen is a Virtual output: bind each to its real connector once, in Arena —
 * a display's id is a fact about the playback machine (output-map's
 * resolume-export.md, "Real display outputs").
 */
export function toResolume(plan, content, name) {
  return exportResolumeXml(resolumeProject(plan, content, name), { target: 'preset' });
}

/* ---------------------------------------------------------------- targets */

const fileSafe = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'output';

/**
 * disguise (designer) — a Feed Mapping table. The column names are the ones
 * disguise's own documentation shows for "Import from table" (help.disguise.
 * one, Feed Mapping). One designer screen holds the content; each head is one
 * media-server output, in the order `mediaOutputs` lists them. The rotation
 * column's unit is not documented (the scripting API's `rotationIndex` is
 * 0..3), so it is written in degrees and flagged.
 */
export function toDisguiseTable(plan, content, screenName = 'LPP content') {
  const outs = mediaOutputs(plan);
  const lines = ['screen name,head,output rect x pos,output rect y pos,output rect width,output rect height,source rect x pos,source rect y pos,source rect width,source rect height,locked,rotation'];
  for (const r of regionRows(plan)) {
    const head = outs.findIndex((m) => m.name === r.mediaOutput) + 1;
    lines.push([screenName, head, r.raster.x, r.raster.y, r.raster.w, r.raster.h, r.content.x, r.content.y, r.content.w, r.content.h, 1, r.rotation].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/**
 * Pixera — a feed-rect CSV in the column layout of AV Stumpfl's own example
 * file (help.pixera.one, "ExampleCSV.csv"), CRLF as theirs is, DMX columns
 * empty. The corner columns are written in pixels like the `_pxl_` ones;
 * whether Pixera reads them as pixels or normalised is not documented.
 */
export function toPixeraFeeds(plan) {
  const head = 'name,src_upper_left_x,src_upper_left_y,dest_upper_left_x,dest_upper_left_y,src_lower_left_x,src_lower_left_y,dest_lower_left_x,dest_lower_left_y,src_lower_right_x,src_lower_right_y,dest_lower_right_x,dest_lower_right_y,src_upper_right_x,src_upper_right_y,dest_upper_right_x,dest_upper_right_y,src_pxl_pos_x,src_pxl_pos_y,src_pxl_width,src_pxl_height,src_rot,dest_pxl_pos_x,dest_pxl_pos_y,dest_pxl_width,dest_pxl_height,dest_rot,net,subNet,universe,index,hierarchy,fixture_description,protocol,screen_name,output_path';
  const lines = [head];
  for (const r of regionRows(plan)) {
    const c = r.content;
    const q = outputQuad(r.blit);
    const name = `${r.screen}_${outWord(r.output, true)}${r.part > 1 ? `_${r.part}` : ''}`;
    lines.push([
      name,
      c.x, c.y, q[0].x, q[0].y,
      c.x, c.y + c.h, q[3].x, q[3].y,
      c.x + c.w, c.y + c.h, q[2].x, q[2].y,
      c.x + c.w, c.y, q[1].x, q[1].y,
      c.x, c.y, c.w, c.h, 0,
      r.raster.x, r.raster.y, r.raster.w, r.raster.h, r.rotation,
      '', '', '', '', '', '', '', r.mediaOutput, ''
    ].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

/**
 * Hippotizer V4 — a Video Mapper CSV: no header, one tile per line, input
 * rectangle (content), input rotation and flips, output rectangle, output
 * rotation, RGB (Green Hippo's manual, "CSV import"). Rotation's sense is not
 * stated there; written counter-clockwise as the switcher states it.
 */
export function toHippoCsv(plan) {
  return regionRows(plan).map((r) => [
    r.content.x, r.content.y, r.content.w, r.content.h, 0, 'False', 'False',
    r.raster.x, r.raster.y, r.raster.w, r.raster.h, r.rotation, 255, 255, 255
  ].join(',')).join('\n') + '\n';
}

/**
 * Millumin 5 — one SVG per media-server output, for Video Routing ▸ … ▸
 * Import as SVG: a polygon per region on the output, top-left origin, corner
 * 0 first, which is the shape Millumin's own exporter writes. It places the
 * slices on the output only; each slice's crop of the canvas is set in the
 * slice editor from pixel-map.csv.
 */
export function toMilluminSvgs(plan) {
  const rows = regionRows(plan);
  return mediaOutputs(plan).map((m) => {
    const polys = rows.filter((r) => r.mediaOutput === m.name).map((r, i) => {
      const q = outputQuad(r.blit).map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ');
      return `  <polygon id="${xml(`${r.screen}_${outWord(r.output, true)}_${i + 1}`)}" fill="${PALETTE[i % PALETTE.length]}" points="${q}"/>`;
    });
    return {
      name: `millumin-${fileSafe(m.name)}.svg`,
      data: `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="${m.height}" viewBox="0 0 ${m.width} ${m.height}">\n${polys.join('\n')}\n</svg>\n`
    };
  });
}

/**
 * TouchDesigner — a table for a Table DAT (`file` parameter), one row per
 * region with the output's size beside it. TouchDesigner's origin is the
 * bottom-left: `src_y_td` and `dst_y_td` are given flipped so a Crop TOP and
 * an Over TOP can use them as they stand.
 */
export function toTouchDesignerTable(plan, content) {
  const lines = ['name\toutput\tsrc_x\tsrc_y\tsrc_w\tsrc_h\tdst_x\tdst_y\tdst_w\tdst_h\tout_w\tout_h\trotation\tsrc_y_td\tdst_y_td'];
  for (const r of regionRows(plan)) {
    lines.push([
      `${r.screen}_${outWord(r.output, true)}_${r.part}`, r.mediaOutput,
      r.content.x, r.content.y, r.content.w, r.content.h,
      r.raster.x, r.raster.y, r.raster.w, r.raster.h,
      r.width, r.height, r.rotation,
      round(content.height - r.content.y - r.content.h), round(r.height - r.raster.y - r.raster.h)
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}

/**
 * Per media server: what this pack gives it, and how to set it up. `kind`
 * is `import` for a file the server loads as it stands, `partial` for one it
 * loads but that leaves a step by hand, and `manual` for a recipe over the
 * universal pack. `verify` is what has not been seen working. Kept beside
 * the builders so the download and docs/BACKGROUNDS.md agree.
 */
export const TARGETS = [
  {
    id: 'resolume', name: 'Resolume Arena', kind: 'import', import: 'Advanced Output preset (.xml)',
    files: (plan, content) => [{ name: 'resolume-advanced-output.xml', data: toResolume(plan, content) }],
    how: 'Copy the .xml into Documents/Resolume Arena/Presets/Advanced Output/, open Output ▸ Advanced Output and choose the preset. Each screen is Virtual: bind it to its real output once. Set the composition to the content size.',
    verify: 'Written by output-map, held to files a real Arena 7.27 wrote; no generated preset has been opened in Arena yet.'
  },
  {
    id: 'disguise', name: 'disguise (designer)', kind: 'import', import: 'Feed Mapping table (.csv)',
    files: (plan, content) => [{ name: 'disguise-feed-table.csv', data: toDisguiseTable(plan, content) }],
    how: 'Make one screen the content size named “LPP content” and one output head per media output, in pixel-map.csv order. Put the .csv in <project>/objects/Table/, then Feed Mapping ▸ Import from table.',
    verify: 'Columns from disguise’s documentation; rotation units unconfirmed — do Export to table once and compare.'
  },
  {
    id: 'pixera', name: 'Pixera', kind: 'partial', import: 'feed-rect CSV',
    files: (plan) => [{ name: 'pixera-feeds.csv', data: toPixeraFeeds(plan) }],
    how: 'Import the .csv as feed rects (Pixera 1.8+). Make one output per media output first; screen_name says which.',
    verify: 'Column layout from AV Stumpfl’s example file; whether its corner columns are pixels or normalised is not documented — export one hand-made feed and compare.'
  },
  {
    id: 'hippotizer', name: 'Hippotizer V4', kind: 'import', import: 'Video Mapper CSV',
    files: (plan) => [{ name: 'hippotizer-video-mapper.csv', data: toHippoCsv(plan) }],
    how: 'One Video Mapper per media output; import the rows whose output rectangle belongs to it (pixel-map.csv lists which).',
    verify: 'Column order from Green Hippo’s manual; rotation sense unconfirmed.'
  },
  {
    id: 'millumin', name: 'Millumin 5', kind: 'partial', import: 'SVG per output (Video Routing ▸ Import as SVG)',
    files: (plan) => toMilluminSvgs(plan),
    how: 'One routing per media output, “many canvases → 1 output”. Import its SVG to place the slices, then set each slice’s canvas crop from pixel-map.csv.',
    verify: 'SVG shape read off Millumin’s own exporter strings; build one routing by hand, export it, and compare before relying on it.'
  },
  {
    id: 'touchdesigner', name: 'TouchDesigner', kind: 'partial', import: 'table for a Table DAT (.tsv)',
    files: (plan, content) => [{ name: 'touchdesigner-slices.tsv', data: toTouchDesignerTable(plan, content) }],
    how: 'Load the .tsv in a Table DAT. Per row: a Crop TOP (pixels, using src_y_td) of the content, an Over TOP onto a black Constant of out_w × out_h at dst_x, dst_y_td, pre-fit native.',
    verify: 'No native import exists; the network is built by hand or by a script from the table.'
  },
  {
    id: 'qlab', name: 'QLab 5', kind: 'manual', import: null,
    how: 'Make a stage the content size and one route per media output. Add a region per row of pixel-map.csv: stage bounds = content rectangle; assign it to the output’s route and put its four corners on the output rectangle (Warping tab). template-content.png is a guide on the stage.',
    verify: 'QLab’s .qlabsettings can carry stages but is an undocumented archive — not written.'
  },
  {
    id: 'mitti', name: 'Mitti', kind: 'manual', import: null,
    how: 'Mitti’s outputs are an equal grid. When the media outputs are equal and side by side: render resolution = content size, rows × columns, span on. Otherwise play pre-cut media — the stills mode’s images are exactly those.',
    verify: 'No import of any output mapping.'
  },
  {
    id: 'madmapper', name: 'MadMapper', kind: 'manual', import: null,
    how: 'Load template-content.png as media; one Quad per row of pixel-map.csv with the input rectangle = content and the output = the output rectangle on that media output.',
    verify: '.mad is undocumented binary — not written.'
  },
  {
    id: 'watchout', name: 'Watchout 7', kind: 'manual', import: null,
    how: 'One virtual display per region (stage rectangle = content, resolution = region size); place it on the physical display at the output rectangle.',
    verify: 'Its REST API takes a whole show as JSON, but the schema is only on a running system — not written.'
  }
];

/** Every file of the export pack: the universal map, the templates' SVG, a readme, and each target's files. */
export function packFiles(plan, content, { targets = TARGETS } = {}) {
  const files = [
    { name: 'pixel-map.csv', data: toCsv(plan, content) },
    { name: 'pixel-map.json', data: toJson(plan, content) },
    { name: 'template-content.svg', data: templateSvg(templateShapes(plan, content, 'content')) },
    ...mediaOutputs(plan).map((m) => ({ name: `template-${fileSafe(m.name)}.svg`, data: templateSvg(templateShapes(plan, content, m.name)) })),
    { name: 'README.txt', data: readme(plan, content, targets) }
  ];
  for (const t of targets) if (t.files) files.push(...t.files(plan, content).map((f) => ({ ...f, name: `${t.id}/${f.name}` })));
  return files;
}

/** The PNG templates a pack carries, by file name: `content` and one per media output. */
export function templateList(plan) {
  return [{ name: 'template-content.png', which: 'content' },
    ...mediaOutputs(plan).map((m) => ({ name: `template-${fileSafe(m.name)}.png`, which: m.name }))];
}

/** A short text for the pack: content size, outputs, and each target's recipe. */
export function readme(plan, content, targets = TARGETS) {
  const outs = mediaOutputs(plan);
  const lines = [
    'LivePremier Plus — Background Slicer pixel map',
    '',
    `Content: ${content.width} × ${content.height} px. Every rectangle in these files is in pixels.`,
    `Media-server outputs: ${outs.length}, one per switcher ${plan.source === 'live' ? 'input' : 'output'}:`,
    ...outs.map((m) => `  - ${m.name}: ${m.width} × ${m.height}${m.rateHz ? ` @ ${m.rateHz} Hz` : ''}${m.format ? ` (${m.format})` : ''}`),
    '',
    'Files:',
    '  pixel-map.csv / pixel-map.json   every region: content rectangle → output rectangle',
    '  template-content.svg/.png        the content canvas with every region marked and sized',
    '  template-<output>.svg/.png       each media-server output with what lands where',
    '  <server>/…                       the files a media server imports, where one does',
    '',
    ...targets.flatMap((t) => [
      `${t.name}${t.import ? ` — ${t.kind === 'import' ? 'imports' : 'partly imports'}: ${t.import}` : ' — no importable format; set up by hand'}`,
      `  ${t.how}`,
      ...(t.verify ? [`  Check: ${t.verify}`] : []),
      ''
    ])
  ];
  return lines.join('\n');
}
