/*
 * Background Slicer — a document opened in the page, and its pages drawn.
 * Browser only; nothing runs at import.
 *
 * A PDF is read here by pdf.js (`src/vendor/pdfjs/`, Mozilla's, as PDF
 * Presenter ships it). A PowerPoint, Keynote or OpenDocument deck goes to
 * this app's server first (`server.js` → `convert.js`), which hands it to
 * PowerPoint, Keynote or LibreOffice and sends back the PDF they export;
 * from there it is the same.
 *
 * A page is drawn at the size it is wanted, never drawn once and scaled:
 * `drawPage(doc, index, width, height, { fit })` paints the page's own vector
 * content into a canvas of exactly that many pixels. That is the whole point
 * of opening the document rather than a picture of it.
 *
 * Three things pdf.js needs told, each learnt elsewhere in this fleet:
 *
 *   - **`wasmUrl`.** Its JPEG 2000, JBIG2 and ICC decoders are WebAssembly
 *     fetched at run time; with no URL an image in those formats draws as
 *     nothing and the page comes out as text on an empty background
 *     (Presentation Commander 74a0e35). The proxy serves `.wasm` as
 *     `application/wasm`, which `instantiateStreaming` insists on.
 *   - **`standardFontDataUrl` and `cMapUrl`**, for a PDF that does not embed
 *     its fonts. A PowerPoint export embeds them; other PDFs do not.
 *   - **A fresh canvas per drawing.** PDF Presenter found a reused canvas can
 *     keep pdf.js's last transform and draw the next page turned 180°.
 */

import { fitInto, documentKind, refusedWhy } from './deck.js';

const VENDOR = new URL('../../src/vendor/pdfjs/', import.meta.url);

let loading = null;
/** pdf.js, loaded the first time a document is opened, with its worker beside it. */
export function pdfjs() {
  if (!loading) {
    loading = import(new URL('pdf.min.mjs', VENDOR).href).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href;
      return lib;
    });
    loading.catch(() => { loading = null; });
  }
  return loading;
}

/**
 * Turn a deck file into PDF bytes on the server. `url` is the plugin's
 * `/convert` route. Rejects with the server's own sentence when it cannot —
 * it names the app it needed, and says to export a PDF instead.
 */
export async function convertDeck(file, { url, fetchImpl = fetch, signal } = {}) {
  const res = await fetchImpl(`${url}?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
    signal
  });
  if (!res.ok) {
    let why = '';
    try { why = (await res.json()).error || ''; } catch { why = await res.text().catch(() => ''); }
    throw new Error(why || `the server answered ${res.status}`);
  }
  const slides = (res.headers.get('x-lpp-slides') || '').split(',').filter(Boolean).map(Number);
  return { bytes: new Uint8Array(await res.arrayBuffer()), engine: res.headers.get('x-lpp-engine') || null, slides: slides.length ? slides : null };
}

/**
 * Open a PDF or a deck. Resolves `{ name, kind, engine, pdf, pages, numbers }`:
 * `pages` is every page's size in points with its rotation applied, read
 * up front so the panel can lay them out before drawing any; `numbers` the
 * slide number of each page when the server could say (a hidden slide has
 * no page), else null and pages go by their place.
 */
export async function openDocument(file, { convertUrl, fetchImpl = fetch, onStage = () => {} } = {}) {
  const kind = documentKind(file);
  if (kind === 'refused') throw new Error(refusedWhy(file));
  if (!kind) throw new Error('not a PDF, or a PowerPoint, Keynote or OpenDocument deck');
  let bytes;
  let engine = null;
  let slides = null;
  if (kind === 'deck') {
    onStage('Turning the deck into a PDF on the machine LivePremier Plus runs on…');
    ({ bytes, engine, slides } = await convertDeck(file, { url: convertUrl, fetchImpl }));
  } else {
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  onStage('Reading the pages…');
  const lib = await pdfjs();
  const pdf = await lib.getDocument({
    data: bytes,
    wasmUrl: new URL('wasm/', VENDOR).href,
    standardFontDataUrl: new URL('standard_fonts/', VENDOR).href,
    cMapUrl: new URL('cmaps/', VENDOR).href,
    cMapPacked: true,
    iccUrl: new URL('iccs/', VENDOR).href,
    enableXfa: false
  }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    pages.push({ width: vp.width, height: vp.height });
  }
  /* Slide numbers only when they account for every page; otherwise nobody can say which is which. */
  const numbers = slides && slides.length === pages.length ? slides : null;
  return { name: file.name, kind, engine, pdf, pages, numbers };
}

/** Let a document go: its worker and everything pdf.js held for it. */
export function closeDocument(doc) {
  try { if (doc && doc.pdf) doc.pdf.destroy(); } catch { /* already gone */ }
}

function canvas(width, height, doc = globalThis.document) {
  const c = doc.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** The page's own content, stretched to exactly `w × h` pixels. */
async function paint(pdf, index, w, h) {
  const page = await pdf.getPage(index + 1);
  const one = page.getViewport({ scale: 1 });
  const sx = w / one.width;
  const viewport = page.getViewport({ scale: sx });
  const c = canvas(w, h);
  const g = c.getContext('2d', { alpha: false });
  /* The viewport scales both ways by sx; the transform makes the height
     come out at h as well, which a page of another shape needs. */
  await page.render({ canvas: c, canvasContext: g, viewport, transform: [1, 0, 0, (h / one.height) / sx, 0, 0] }).promise;
  page.cleanup();
  return c;
}

/**
 * One page drawn into a `width × height` canvas: `fit` inside it with
 * `background` round it, `fill` it and lose what overhangs, or `stretch` to
 * it. The canvas is the page's own drawing at that size — a source the
 * slicer can cut 1:1 — never a scaled copy of a smaller one.
 */
export async function drawPage(doc, index, width, height, { fit = 'stretch', background = '#000000' } = {}) {
  const W = Math.max(1, Math.round(width));
  const H = Math.max(1, Math.round(height));
  const page = doc.pages[index];
  if (!page) throw new Error(`the document has no page ${index + 1}`);
  if (fit === 'stretch') return paint(doc.pdf, index, W, H);
  const r = fitInto(fit, page, { width: W, height: H });
  const w = Math.max(1, Math.round(r.w));
  const h = Math.max(1, Math.round(r.h));
  const drawn = await paint(doc.pdf, index, w, h);
  const out = canvas(W, H);
  const g = out.getContext('2d', { alpha: false });
  g.fillStyle = background;
  g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = false;
  g.drawImage(drawn, Math.round(r.x), Math.round(r.y));
  release(drawn);
  return out;
}

/** Free a canvas's pixels now rather than at the next collection: decks are many large pages. */
export function release(c) {
  try { c.width = 0; c.height = 0; } catch { /* fine */ }
}

/** A canvas as a PNG. */
export function toPng(c) {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('the browser could not encode the PNG'))), 'image/png'));
}

/** A small picture of a page for the page strip: `{ url, width, height }`. */
export async function pageThumb(doc, index, maxWidth = 192) {
  const page = doc.pages[index];
  const w = Math.max(1, Math.round(maxWidth));
  const h = Math.max(1, Math.round((maxWidth * page.height) / page.width));
  const c = await paint(doc.pdf, index, w, h);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.8));
  release(c);
  return { url: URL.createObjectURL(blob), width: w, height: h };
}
