/*
 * Background Slicer — the plugin's server half: turning a deck into a PDF.
 *
 * Everything else the slicer does happens in the page (`client.js`). A PDF
 * is opened there too; only a PowerPoint or OpenDocument deck comes here,
 * because drawing one takes an application on this machine (`convert.js`).
 *
 *   GET  /__lpp/bg-slicer/engines         what can convert what, here
 *   POST /__lpp/bg-slicer/convert?name=…  the deck's bytes in, a PDF out
 *
 * ⚠️ This route makes the machine LivePremier Plus runs on open a file
 * somebody sent it in PowerPoint or LibreOffice — so it is held to more than
 * the app's other routes, which share the app's open exposure (README, "On
 * binding wide"):
 *
 *   - **No cross-site POST.** The body must be `application/octet-stream`,
 *     which a page on another site cannot send without a CORS preflight, and
 *     this server answers no preflight — so a browser never sends it. (Not
 *     an `Origin` check: behind `tailscale serve` the Host the app sees is
 *     not the one the browser used, and the page's own request would fail.)
 *   - **A deck type only**, by extension, and only to an engine that takes
 *     it. Never a macro-enabled one (`.pptm`): PowerPoint would stop on its
 *     macro warning with nobody there, and nobody wants its macros run.
 *   - **Streamed to a temporary file, up to 1 GB**, and deleted after.
 */

import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { probeAll, convertDeck, DECK_TYPES, MAX_BYTES, extOf } from './convert.js';

export default function activate(ctx, { convert = convertDeck, probe = probeAll } = {}) {
  ctx.route('GET', '/engines', async (req, res, h) => {
    const engines = await probe();
    h.json(200, {
      types: DECK_TYPES,
      engines: engines.map(({ id, label, formats, available, reason }) => ({ id, label, formats, available, reason: reason || null }))
    });
  });

  ctx.route('POST', '/convert', async (req, res, h) => {
    if (!/^application\/octet-stream\b/i.test(String(req.headers['content-type'] || ''))) {
      throw new ctx.HttpError(415, 'send the deck as application/octet-stream');
    }
    const name = String(h.url.searchParams.get('name') || '');
    const ext = extOf(name);
    if (!DECK_TYPES[ext]) throw new ctx.HttpError(415, `a .${ext || '?'} file is not a deck this can convert — open a PDF, or a PowerPoint or OpenDocument deck`);
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BYTES) throw new ctx.HttpError(413, `the deck is over ${MAX_BYTES / 1024 / 1024 / 1024} GB`);

    const dir = await mkdtemp(join(tmpdir(), 'lpp-deck-'));
    const input = join(dir, `deck.${ext}`);
    let out;
    let size = 0;
    const started = Date.now();
    try {
      const cap = new Transform({
        transform(chunk, _enc, done) {
          size += chunk.length;
          if (size > MAX_BYTES) done(new ctx.HttpError(413, `the deck is over ${MAX_BYTES / 1024 / 1024 / 1024} GB`));
          else done(null, chunk);
        }
      });
      await pipeline(req, cap, createWriteStream(input));
      if (!size) throw new ctx.HttpError(400, 'no deck arrived');
      try {
        out = await convert({ input, ext, engine: h.url.searchParams.get('engine') || null });
      } catch (err) {
        throw new ctx.HttpError(err.status || 502, err.message);
      }
    } finally {
      /* Gone before the answer: nobody's deck sits in a temporary folder. */
      await rm(dir, { recursive: true, force: true });
    }
    ctx.log(`${name}: ${Math.round(size / 1024)} KB → PDF ${Math.round(out.pdf.length / 1024)} KB by ${out.label} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': out.pdf.length,
      'cache-control': 'no-store',
      'x-lpp-engine': out.engine,
      /* The slide numbers its pages are, hidden slides being left out of the PDF. */
      ...(out.slides ? { 'x-lpp-slides': out.slides.join(',') } : {})
    });
    res.end(out.pdf);
  });
}
