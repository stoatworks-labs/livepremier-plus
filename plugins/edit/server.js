/*
 * The Edit page — the plugin's server half: a memory written into the bank
 * without a bus, and read back out of it.
 *
 * The one thing the Edit page asks of the device beyond the socket the page
 * already has. It is here and not in the page for two reasons: the browser
 * cannot open TCP 10606, and the file has to be written to a disk.
 * `memory-import.js` has the three-step conversation, and the warning about
 * whose filesystem that path is on. A GET reads slots back out, which is how a
 * real memory is loaded into the programmer — a slot's contents are not in the
 * store mirror and never have been.
 *
 * At `/__lpp/memory`, where it always was (`routeBase` in the manifest).
 */

import { readFile } from 'node:fs/promises';

import { pathOrNothing } from '../../src/core/settings.js';
import { importMemories, exportMemories } from './memory-import.js';

/**
 * One setting: where the memory file is written for the SWITCHER to read.
 *
 * Empty means a temporary directory on this machine, which is right for a
 * simulator — the device software runs here, so our disk is its disk. On a
 * real switcher the path is resolved on the switcher's own filesystem, so this
 * is the setting an installation points at a share both machines can see.
 * It was a top-level setting before the Edit page was a plugin; `legacy`
 * lifts it from there wherever it still turns up.
 */
export const settings = {
  normalise: (raw) => ({ memoryImportDir: pathOrNothing(raw.memoryImportDir) }),
  legacy: ['memoryImportDir']
};

/** A memory file can carry a whole bank's worth of layers. */
const LIMIT = 8 * 1024 * 1024;

export default function activate(ctx) {
  const dir = () => ctx.settings.get().memoryImportDir || undefined;
  const needSwitcher = () => {
    if (!ctx.device()) throw new ctx.HttpError(409, 'no switcher configured');
  };

  const save = async (req, res, h) => {
    needSwitcher();
    const parsed = await h.readJson(LIMIT);
    const memories = Array.isArray(parsed.memories) ? parsed.memories : null;
    if (!memories) throw new ctx.HttpError(400, 'no memories');
    try {
      const result = await importMemories({ awj: ctx.awj, memories, dir: dir() });
      ctx.log(`memory import: ${result.ok ? 'ok' : 'failed'} ${result.slots.join(', ') || ''}`
        + (result.error ? ' — ' + result.error : ''));
      h.json(result.ok ? 200 : 502, result);
    } catch (err) {
      /* 502: the failure is the switcher's end of the conversation. */
      h.json(502, { error: err.message });
    }
  };
  ctx.route('POST', '/', save);
  ctx.route('PUT', '/', save);

  ctx.route('GET', '/', async (req, res, h) => {
    needSwitcher();
    const slots = (h.url.searchParams.get('slots') || '')
      .split(',').map((s) => Number(s.trim())).filter(Boolean);
    if (!slots.length) throw new ctx.HttpError(400, 'name at least one slot');
    try {
      const out = await exportMemories({ awj: ctx.awj, slots, dir: dir() });
      if (!out.ok) return h.json(502, out);
      const file = await readFile(out.path, 'utf8');
      return h.json(200, { ok: true, memories: JSON.parse(file) });
    } catch (err) {
      return h.json(502, { error: err.message });
    }
  });
}
