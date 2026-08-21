/*
 * A static file server for testing the panels without packing the extension.
 *
 * Load the two content scripts into an already-open Web RCS tab from the
 * console and the whole UI runs, minus the MV3 plumbing:
 *
 *   await import('http://127.0.0.1:8765/src/hook/ws-hook.js');
 *   await import('http://127.0.0.1:8765/src/main.js');
 *
 * Against a real device, start it with HOST=0.0.0.0 and use this machine's LAN
 * address in those imports - see the note on `host` below.
 *
 * Cross-origin module imports need CORS, which is the only reason this exists
 * rather than python -m http.server. Cue-stack persistence will not work in
 * this mode: chrome.storage is brokered by the isolated-world loader, which
 * is not present, so saves time out after two seconds and are dropped.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const port = Number(process.env.PORT || 8765);

/*
 * Loopback by default, because this serves the extension's source to whatever
 * asks. Set HOST=0.0.0.0 to reach it from another machine on the LAN.
 *
 * That is not optional when testing against a real device: Chrome's local
 * network protection blocks a page served from a private address (the
 * switcher) from fetching localhost, so the modules have to come from an
 * address in the same space as the page. Bind wide, test, stop the server.
 */
const host = process.env.HOST || '127.0.0.1';
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' };

/*
 * Anything this server does not hold is fetched from a real Web RCS, when one
 * is named: DEVICE=192.168.2.142 npm run serve
 *
 * That is what makes tools/harness.html worth having. The panels are built out
 * of the vendor's own utility classes, so a harness with its own stylesheet
 * would prove nothing about how they actually look. Proxying the device's CSS,
 * fonts and icon sprite renders them in the real design system without copying
 * a single vendor asset into this repo.
 *
 * GET only, and only for assets. The proxy is a development convenience, not a
 * way to reach a device - it will not forward a write.
 */
const device = process.env.DEVICE || '';

async function proxy(path, res) {
  if (!device || !/^[\w.-]+(:\d+)?$/.test(device)) return false;
  try {
    const upstream = await fetch(`http://${device}${path}`, { redirect: 'follow' });
    if (!upstream.ok) return false;
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * The device's own application stylesheet.
 *
 * Its filename carries a per-build hash, so the only reliable way to find it
 * is to read the served index.html and take the href from there — the same
 * reason the extension never hard-codes a vendor class name.
 */
async function vendorStyle(res) {
  if (!device) return false;
  try {
    const index = await (await fetch(`http://${device}/`)).text();
    const href = [...index.matchAll(/<link[^>]+href="([^"]+\.css)"/g)]
      .map((m) => m[1]).find((h) => h.includes('app.'));
    if (!href) return false;
    const css = await (await fetch(`http://${device}${href}`)).text();
    res.writeHead(200, {
      'Content-Type': 'text/css',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(css);
    return true;
  } catch {
    return false;
  }
}

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Access-Control-Allow-Origin': '*' });
    res.end('method not allowed');
    return;
  }
  if (path === '/vendor-style.css' && await vendorStyle(res)) return;
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    if (await proxy(path, res)) return;
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
}).listen(port, host, () => console.log(`serving ${root} on http://${host}:${port}`));
