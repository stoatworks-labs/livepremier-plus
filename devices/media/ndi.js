/*
 * NDI senders, through the NDI runtime already on this machine.
 *
 * Nothing of NDI's is shipped with LivePremier Plus. The runtime is loaded at
 * run time, by path, from wherever NDI Tools or the NDI SDK put it; with none
 * found the media host says so and the app says where to get it
 * (https://ndi.video/tools). NDI® is a registered trademark of Vizrt NDI AB.
 *
 * Reached through koffi, as the FTDI transport reaches D2XX: the app's own
 * package.json keeps no dependencies, and this folder's carries koffi already.
 *
 * Only the sending half of the SDK is used: a sender per feed, a frame sent
 * when there is a new picture, and the number of receivers asked for so the
 * app can leave a feed nobody watches alone.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/* NDI_LIB_FOURCC('R','G','B','X'): 8-bit RGB with an alpha byte the receiver ignores. */
const FOURCC_RGBX = 0x52 | (0x47 << 8) | (0x42 << 16) | (0x58 << 24);
const PROGRESSIVE = 1;
/* NDIlib_send_timecode_synthesize: the SDK stamps the frame itself. */
const SYNTHESIZE = 0x7fffffffffffffffn;

/** Where the runtime may be, most specific first. */
export function candidates({ platform = process.platform, env = process.env, execPath = process.execPath } = {}) {
  const dir = env.NDI_RUNTIME_DIR_V6 || env.NDI_RUNTIME_DIR_V5;
  if (platform === 'darwin') {
    return [
      dir && join(dir, 'libndi.dylib'),
      /* The desktop app's bundle, should a release ever carry the runtime (scripts/release-lib.sh). */
      join(execPath, '..', '..', 'Frameworks', 'libndi.dylib'),
      '/usr/local/lib/libndi.dylib',
      '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib',
      '/Library/NDI SDK for macOS/lib/macOS/libndi.dylib',
      '/opt/homebrew/lib/libndi.dylib',
    ].filter(Boolean);
  }
  if (platform === 'win32') {
    return [
      dir && join(dir, 'Processing.NDI.Lib.x64.dll'),
      join(execPath, '..', 'Processing.NDI.Lib.x64.dll'),
      'C:\\Program Files\\NDI\\NDI 6 Runtime\\v6\\Processing.NDI.Lib.x64.dll',
      'C:\\Program Files\\NDI\\NDI 6 Tools\\Runtime\\Processing.NDI.Lib.x64.dll',
    ].filter(Boolean);
  }
  return [
    dir && join(dir, 'libndi.so.6'),
    join(execPath, '..', 'libndi.so.6'),
    '/usr/lib/libndi.so.6', '/usr/local/lib/libndi.so.6', '/usr/lib/x86_64-linux-gnu/libndi.so.6',
  ].filter(Boolean);
}

/**
 * The runtime, loaded: `{ lib, reason }`, `lib` null with `reason` saying why.
 *
 * @param o.importer  `import`, replaced in tests
 * @param o.file      a runtime to load instead of looking for one
 */
export async function loadNdi({ importer = (m) => import(m), file = null, exists = existsSync, ...where } = {}) {
  let koffi;
  try {
    const mod = await importer('koffi');
    koffi = mod.default ?? mod;
  } catch (err) {
    const missing = err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err?.message ?? '');
    return { lib: null, reason: missing ? 'koffi is not installed in devices/ (npm run setup:devices).' : `koffi failed to load: ${err.message}` };
  }
  const path = file || candidates(where).find((p) => exists(p));
  if (!path) return { lib: null, reason: 'No NDI runtime on this machine. Install NDI Tools (ndi.video/tools), or set NDI_RUNTIME_DIR_V6.' };
  try {
    const so = koffi.load(path);
    const create = koffi.struct('LPP_NDIlib_send_create_t', {
      p_ndi_name: 'const char *', p_groups: 'const char *', clock_video: 'bool', clock_audio: 'bool',
    });
    const frame = koffi.struct('LPP_NDIlib_video_frame_v2_t', {
      xres: 'int', yres: 'int', FourCC: 'int', frame_rate_N: 'int', frame_rate_D: 'int',
      picture_aspect_ratio: 'float', frame_format_type: 'int', timecode: 'int64_t',
      p_data: 'void *', line_stride_in_bytes: 'int', p_metadata: 'const char *', timestamp: 'int64_t',
    });
    const source = koffi.struct('LPP_NDIlib_source_t', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
    const fns = {
      initialize: so.func('bool NDIlib_initialize()'),
      version: so.func('const char *NDIlib_version()'),
      sendCreate: so.func('void *NDIlib_send_create(const LPP_NDIlib_send_create_t *p)'),
      sendDestroy: so.func('void NDIlib_send_destroy(void *inst)'),
      sendVideo: so.func('void NDIlib_send_send_video_v2(void *inst, const LPP_NDIlib_video_frame_v2_t *f)'),
      connections: so.func('int NDIlib_send_get_no_connections(void *inst, uint32_t timeout)'),
      sourceName: so.func('const LPP_NDIlib_source_t *NDIlib_send_get_source_name(void *inst)'),
    };
    if (!fns.initialize()) return { lib: null, reason: 'The NDI runtime will not start on this CPU.' };
    /* "NDI SDK APPLE 12:49:17 Apr 13 2026 6.3.2.0": the number at the end. */
    const said = String(fns.version() || '');
    const version = (/(\d+\.\d+\.\d+(?:\.\d+)?)\s*$/.exec(said) || [null, said.trim()])[1];
    return { lib: wrap(koffi, fns, source, path, version), reason: null };
  } catch (err) {
    return { lib: null, reason: `The NDI runtime at ${path} did not load: ${err.message}` };
  }
}

/** The handful of calls `core.js` needs, with koffi kept in here. */
function wrap(koffi, fns, sourceType, path, version) {
  return {
    path,
    version,
    /** A sender named `name`; its handle is opaque. */
    create(name) {
      const inst = fns.sendCreate({ p_ndi_name: name, p_groups: null, clock_video: false, clock_audio: false });
      if (!inst) throw new Error(`NDI would not make a sender called ${name}`);
      return inst;
    },
    destroy(inst) { fns.sendDestroy(inst); },
    /** The name receivers see, `MACHINE (name)`. */
    fullName(inst) {
      const p = fns.sourceName(inst);
      if (!p) return null;
      return koffi.decode(p, sourceType).p_ndi_name || null;
    },
    connections(inst) { return fns.connections(inst, 0); },
    /**
     * One RGBA picture, sent as RGBX: the alpha byte is there and ignored.
     * Synchronous — the SDK is done with the buffer when this returns.
     */
    send(inst, pic, fps = 1) {
      fns.sendVideo(inst, {
        xres: pic.width, yres: pic.height, FourCC: FOURCC_RGBX,
        frame_rate_N: Math.max(1, Math.round(fps * 1000)), frame_rate_D: 1000,
        picture_aspect_ratio: pic.width / pic.height, frame_format_type: PROGRESSIVE,
        timecode: SYNTHESIZE, p_data: pic.data, line_stride_in_bytes: pic.width * 4,
        p_metadata: null, timestamp: 0n,
      });
    },
  };
}
