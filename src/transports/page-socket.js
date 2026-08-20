/*
 * Transport: the Web RCS page's own WebSocket.
 *
 * The extension does not open a connection of its own. The device counts its
 * clients and shows them in the header, and a second socket would appear
 * there as a phantom operator; on top of that AWJ's five-client budget is
 * small enough that burning one on a passenger is rude. So this rides the
 * connection the vendor app already has, via the document_start hook.
 *
 * Frames on the wire are one JSON object each:
 *
 *   {"channel":"DEVICE","data":{"path":["device",...],"value":<any>}}
 *   {"channel":"REMOTE","data":{"channel":"INIT"|"PATCH", ...}}
 *   {"channel":"LOG","data":"<json string>"}
 *
 * plus a bare "0x9"/"0xA" ping pair which the hook already drops. REMOTE is
 * the vendor UI's own view state, not the device - we ignore it.
 */

const HOOK = () => window.__WRU_HOOK;

export class PageSocketTransport {
  constructor() {
    this.snapshotUrl = '/api/stores/device';
  }

  /** True when the hook has seen Analog Way traffic on this page. */
  get detected() { const h = HOOK(); return !!(h && h.detected); }

  get connected() {
    const h = HOOK();
    return !!(h && h.appSocket && h.appSocket.readyState === 1);
  }

  mark() { const h = HOOK(); return h ? h.seq + 1 : 0; }

  onFrame(fn) {
    const h = HOOK();
    if (!h) return () => {};
    return h.on((frame) => {
      const parsed = parseDeviceFrame(frame);
      if (parsed) fn(parsed);
    });
  }

  replay(mark) {
    const h = HOOK();
    if (!h) return [];
    const out = [];
    for (const frame of h.since(mark)) {
      const parsed = parseDeviceFrame(frame);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  send({ path, value }) {
    const h = HOOK();
    if (!h) return false;
    return h.send(JSON.stringify({ channel: 'DEVICE', data: { path, value } }));
  }
}

/**
 * Pull a device write out of a raw frame, or null if it is not one.
 *
 * Outbound frames count too: another operator's tab does not produce them,
 * but the vendor UI in this same tab does, and treating our own page's writes
 * as state changes keeps the panels in step with the stock UI without waiting
 * for the device to echo.
 */
function parseDeviceFrame(frame) {
  const raw = frame && frame.raw;
  if (typeof raw !== 'string' || raw.indexOf('"channel":"DEVICE"') < 0) return null;
  let msg;
  try { msg = JSON.parse(raw); } catch { return null; }
  const data = msg && msg.data;
  if (!data || !Array.isArray(data.path) || data.value === undefined) return null;
  return { path: data.path, value: data.value, dir: frame.dir, seq: frame.seq };
}
