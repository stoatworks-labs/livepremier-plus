/*
 * An NDI receiver for tests: finds a source by name on this machine and
 * hands back the frames it sends, RGBA. Through the real NDI runtime and the
 * koffi in `devices/node_modules`, so it is only for tests that run against
 * the real thing (the simulator's), and says so when either is missing. It waits in
 * short slices (the runtime's calls block): the app under test shares this process.
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { candidates } from '../../devices/media/ndi.js';

const RGBX_RGBA = 2;
const HIGHEST = 100;
const VIDEO = 1;

/** `{ open(name, ms), reason }`: `open` null with a reason when there is no runtime here. */
export function ndiReceiver(root) {
  const modules = join(root, 'devices', 'node_modules');
  if (!existsSync(join(modules, 'koffi'))) return { open: null, reason: 'devices/ is not installed (npm run setup:devices)' };
  const file = candidates().find((p) => existsSync(p));
  if (!file) return { open: null, reason: 'no NDI runtime on this machine' };
  const koffi = createRequire(join(modules, 'x.js'))('koffi');
  const so = koffi.load(file);
  const source = koffi.struct('T_ndi_source', { p_ndi_name: 'const char *', p_url_address: 'const char *' });
  const findCreate = koffi.struct('T_ndi_find_create', { show_local_sources: 'bool', p_groups: 'const char *', p_extra_ips: 'const char *' });
  const recvCreate = koffi.struct('T_ndi_recv_create', {
    source_to_connect_to: source, color_format: 'int', bandwidth: 'int', allow_video_fields: 'bool', p_ndi_recv_name: 'const char *',
  });
  const frame = koffi.struct('T_ndi_video_frame', {
    xres: 'int', yres: 'int', FourCC: 'int', frame_rate_N: 'int', frame_rate_D: 'int', picture_aspect_ratio: 'float',
    frame_format_type: 'int', timecode: 'int64_t', p_data: 'void *', line_stride_in_bytes: 'int', p_metadata: 'const char *', timestamp: 'int64_t',
  });
  const f = {
    init: so.func('bool NDIlib_initialize()'),
    findCreate: so.func('void *NDIlib_find_create_v2(const T_ndi_find_create *p)'),
    findWait: so.func('bool NDIlib_find_wait_for_sources(void *f, uint32_t ms)'),
    sources: so.func('const T_ndi_source *NDIlib_find_get_current_sources(void *f, _Out_ uint32_t *n)'),
    findDestroy: so.func('void NDIlib_find_destroy(void *f)'),
    recvCreate: so.func('void *NDIlib_recv_create_v3(const T_ndi_recv_create *p)'),
    recvDestroy: so.func('void NDIlib_recv_destroy(void *r)'),
    capture: so.func('int NDIlib_recv_capture_v2(void *r, _Out_ T_ndi_video_frame *v, void *a, void *m, uint32_t ms)'),
    freeVideo: so.func('void NDIlib_recv_free_video_v2(void *r, const T_ndi_video_frame *v)'),
  };
  f.init();
  const finder = f.findCreate({ show_local_sources: true, p_groups: null, p_extra_ips: null });

  /** The names NDI can see now, `MACHINE (name)`. */
  function names() {
    const n = [0];
    const p = f.sources(finder, n);
    return n[0] ? koffi.decode(p, koffi.array(source, n[0])).map((s) => ({ name: s.p_ndi_name, url: s.p_url_address })) : [];
  }

  /** Wait up to `ms` for a source whose name ends `(name)`; null if none came. */
  async function find(name, ms = 10_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = names().find((s) => s.name.endsWith(`(${name})`));
      if (hit) return hit;
      f.findWait(finder, 30);
      await new Promise((r) => setImmediate(r));
    }
    return null;
  }

  async function open(name, ms = 10_000) {
    const found = await find(name, ms);
    if (!found) return null;
    const recv = f.recvCreate({
      source_to_connect_to: { p_ndi_name: found.name, p_url_address: found.url },
      color_format: RGBX_RGBA, bandwidth: HIGHEST, allow_video_fields: false, p_ndi_recv_name: 'lpp-test',
    });
    return {
      name: found.name,
      /** The next frame within `ms`, `{width, height, data, at}` (RGBA, tightly packed), or null. */
      async next(ms = 5000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const v = {};
          const type = f.capture(recv, v, null, null, 20);
          if (type === VIDEO) {
            const bytes = koffi.decode(v.p_data, 'uint8_t', v.line_stride_in_bytes * v.yres);
            const data = new Uint8Array(v.xres * v.yres * 4);
            for (let y = 0; y < v.yres; y++) data.set(bytes.slice(y * v.line_stride_in_bytes, y * v.line_stride_in_bytes + v.xres * 4), y * v.xres * 4);
            const out = { width: v.xres, height: v.yres, data, at: Date.now() };
            f.freeVideo(recv, v);
            return out;
          }
          await new Promise((r) => setImmediate(r));
        }
        return null;
      },
      close: () => f.recvDestroy(recv),
    };
  }

  return { open, find, names, close: () => f.findDestroy(finder), reason: null };
}
