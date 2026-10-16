/*
 * UMD Generator — drawing a layout (`core.layout`) into pixels.
 *
 * Into any 2D context, so the panel's preview and the PNG are the same
 * drawing and a test can hand it a recorder. Borders and tabs are filled
 * rectangles on whole pixels — a stroked line on a half pixel is two grey
 * lines on a switcher's output — and the text is the one thing antialiased.
 */

import { borderBands } from './core.js';

export const FONT_STACK = '"Helvetica Neue", Helvetica, Arial, sans-serif';
export const font = (px) => `600 ${px}px ${FONT_STACK}`;

/** A text measurer for `core.layout`, off a real context. */
export function measurer(ctx) {
  return (text, px) => {
    ctx.font = font(px);
    return ctx.measureText(String(text)).width;
  };
}

/** A context to measure with, when there is a browser; null in Node. */
export function measuringContext() {
  try {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(1, 1).getContext('2d');
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      return c.getContext ? c.getContext('2d') : null;
    }
  } catch { /* no canvas here */ }
  return null;
}

/** Draw the UMD: transparent everywhere but its lines and tabs. */
export function draw(ctx, plan) {
  ctx.clearRect(0, 0, plan.width, plan.height);
  ctx.fillStyle = plan.colour;
  for (const item of plan.items) for (const b of item.borders) ctx.fillRect(b.left, b.top, b.width, b.height);
  drawTabs(ctx, plan);
}

function drawTabs(ctx, plan) {
  for (const item of plan.items) {
    const t = item.tab;
    if (!t) continue;
    ctx.fillStyle = `rgba(0, 0, 0, ${plan.tabOpacity})`;
    ctx.fillRect(t.left, t.top, t.width, t.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = font(t.px);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    /* A cap-height nudge: `middle` centres on the em box, which sits text a
       touch high in a tab this short. */
    ctx.fillText(t.text, t.left + t.width / 2, t.top + t.height / 2 + Math.round(t.px * 0.06));
  }
}

function surface(width, height) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** The layout as a PNG blob, at the canvas's own size. */
export async function renderPng(plan) {
  const c = surface(plan.width, plan.height);
  draw(c.getContext('2d'), plan);
  if (typeof c.convertToBlob === 'function') return c.convertToBlob({ type: 'image/png' });
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser made no PNG'))), 'image/png'));
}

/**
 * The panel's preview: the boxes as grey stand-ins for their pictures, the
 * UMD over them (or under, for a background), scaled to `scale`. Its lines
 * are drawn at least a preview pixel wide — at a sixth of the canvas a 2 px
 * line is a third of a pixel and would not show at all.
 */
export function drawPreview(ctx, plan, { scale = 1, target = 'layer', boxes = [] } = {}) {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, Math.round(plan.width * scale), Math.round(plan.height * scale));
  ctx.scale(scale, scale);
  const bw = plan.border ? Math.max(plan.border, 1 / scale) : 0;
  const pictures = () => {
    /* Two shades, so boxes that touch are not one grey block. */
    boxes.forEach((b, i) => {
      ctx.fillStyle = i % 2 ? '#2f353c' : '#3d444d';
      ctx.fillRect(b.rect.left, b.rect.top, b.rect.width, b.rect.height);
    });
  };
  const umd = () => {
    ctx.fillStyle = plan.colour;
    for (const item of plan.items) {
      for (const b of (bw ? borderBands(item.rect, bw, target, plan) : [])) ctx.fillRect(b.left, b.top, b.width, b.height);
    }
    drawTabs(ctx, plan);
  };
  if (target === 'background') { umd(); pictures(); } else { pictures(); umd(); }
  ctx.restore();
}
