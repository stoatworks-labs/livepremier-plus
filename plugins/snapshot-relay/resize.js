/*
 * Shrink an RGBA image by averaging the source pixels each output pixel
 * covers, fractional edges weighted by how much of them it covers.
 *
 * Down only. A thumbnail wider than the switcher made it has nothing more to
 * say, and an upscale here would be bytes on the wire for the browser to do
 * better itself.
 */

/**
 * @param {{width: number, height: number, data: Uint8Array}} img
 * @param {number} maxWidth  0 or anything at least the width leaves it alone
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function fitWidth(img, maxWidth) {
  if (!maxWidth || img.width <= maxWidth) return img;
  const width = Math.max(1, Math.round(maxWidth));
  const height = Math.max(1, Math.round((img.height * width) / img.width));
  return { width, height, data: area(img, width, height) };
}

function area({ width: sw, height: sh, data: src }, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const sx = sw / dw;
  const sy = sh / dh;
  const acc = new Float64Array(4);
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy; const y1 = y0 + sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx; const x1 = x0 + sx;
      acc.fill(0);
      let total = 0;
      for (let yy = Math.floor(y0); yy < Math.min(sh, Math.ceil(y1)); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        for (let xx = Math.floor(x0); xx < Math.min(sw, Math.ceil(x1)); xx++) {
          const wgt = wy * (Math.min(xx + 1, x1) - Math.max(xx, x0));
          const p = (yy * sw + xx) * 4;
          acc[0] += src[p] * wgt; acc[1] += src[p + 1] * wgt;
          acc[2] += src[p + 2] * wgt; acc[3] += src[p + 3] * wgt;
          total += wgt;
        }
      }
      const o = (y * dw + x) * 4;
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(acc[c] / total);
    }
  }
  return out;
}
