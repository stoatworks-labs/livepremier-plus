/*
 * Multiviewer slicer — a stand-in multiviewer, drawn from the switcher's own
 * layout. Page side.
 *
 * A simulator has no multiviewer output to capture, so this draws what one
 * would carry: every widget where the store says it is, a 16:9 picture
 * letterboxed inside it, the source's name in the band underneath the way an
 * on-screen label sits, and a red tally border round the whole widget. The
 * picture moves — a sweeping bar and a running frame count — so a thumbnail
 * that is live is plainly different from one that is not.
 *
 * It is drawn at 1280×720 on purpose, not at the multiviewer's raster: a
 * capture that arrives at another size than the multiviewer is the case the
 * crops must scale for, and the Midra's streamer sends exactly that.
 */

import { pictureRect, scaleRect } from './core.js';

export const TEST_SIZE = { width: 1280, height: 720 };
const FPS = 25;

/** A colour per source, stable across frames. */
function hue(source) {
  let h = 0;
  for (const c of String(source)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * @param {{layout: () => {raster: {width:number,height:number}|null, tiles: Array<{source:string, rect:object}>}}} opts
 */
export function createTestCard({ layout, doc = document, size = TEST_SIZE }) {
  const canvas = doc.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const g = canvas.getContext('2d');
  let frame = 0;

  function draw() {
    frame += 1;
    g.fillStyle = '#111';
    g.fillRect(0, 0, size.width, size.height);
    const { raster, tiles } = layout();
    if (!raster) {
      g.fillStyle = '#888';
      g.font = '28px sans-serif';
      g.fillText('No multiviewer layout in the store yet', 40, 60);
      return;
    }
    for (const t of tiles) {
      const tile = scaleRect(t.rect, raster, size);
      const pic = scaleRect(pictureRect(t.rect, { aspect: '16:9', align: 'center', insetPct: 0 }), raster, size);
      const h = hue(t.source);
      g.fillStyle = `hsl(${h} 45% 22%)`;
      g.fillRect(pic.x, pic.y, pic.w, pic.h);
      /* A bar sweeping across the picture, a different speed per source. */
      const bx = pic.x + ((frame * (2 + (h % 5))) % Math.max(1, Math.round(pic.w)));
      g.fillStyle = `hsl(${h} 80% 60%)`;
      g.fillRect(bx, pic.y, Math.max(2, pic.w / 16), pic.h);
      g.fillStyle = '#fff';
      g.font = `bold ${Math.round(pic.h / 4)}px sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(t.source, pic.x + pic.w / 2, pic.y + pic.h / 2 - pic.h / 10);
      g.font = `${Math.round(pic.h / 8)}px monospace`;
      g.fillText(String(frame).padStart(6, '0'), pic.x + pic.w / 2, pic.y + pic.h * 0.78);
      /* The on-screen label, in the band under the picture. */
      const band = tile.y + tile.h - (pic.y + pic.h);
      if (band > 6) {
        g.fillStyle = '#000';
        g.fillRect(tile.x, pic.y + pic.h, tile.w, band);
        g.fillStyle = '#ddd';
        g.font = `${Math.round(Math.min(band * 0.7, 18))}px sans-serif`;
        g.fillText(`${t.source} · LABEL`, tile.x + tile.w / 2, pic.y + pic.h + band / 2);
      }
      g.strokeStyle = '#d22';
      g.lineWidth = 2;
      g.strokeRect(tile.x + 1, tile.y + 1, tile.w - 2, tile.h - 2);
      g.textAlign = 'start';
      g.textBaseline = 'alphabetic';
    }
  }

  draw();
  /* A timer, not requestAnimationFrame: the browser stops animation frames
     for a hidden page, and a capture should not freeze because its tab did. */
  const timer = setInterval(draw, 1000 / FPS);
  const stream = canvas.captureStream(FPS);
  return {
    stream,
    canvas,
    stop() { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); }
  };
}
