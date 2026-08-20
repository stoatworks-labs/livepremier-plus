/*
 * A static file server for testing the panels without packing the extension.
 *
 * Load the two content scripts into an already-open Web RCS tab from the
 * console and the whole UI runs, minus the MV3 plumbing:
 *
 *   await import('http://127.0.0.1:8765/src/hook/ws-hook.js');
 *   await import('http://127.0.0.1:8765/src/main.js');
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
const TYPES = { '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.html': 'text/html' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    res.end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log('serving ' + root + ' on http://127.0.0.1:' + port));
