/*
 * FTDI chips in MPSSE mode, for the device host.  ** PREVIEW **
 *
 * The Barco EC panels are an FT232H clocking SPI into a CPLD (see
 * `../modules/barco-ec/protocol.js`). Reaching one takes a different road on
 * each platform, and the road is decided by whose driver already owns it:
 *
 * - **macOS and Linux: libusb**, through the `usb` package (v2, the libusb
 *   binding). Nothing in either kernel claims vendor 0x0600, so the device is
 *   there for the asking; this is also how Barco's own Mac Toolset reaches it
 *   (it bundles libftdi and libusb). Linux needs a udev rule for access.
 * - **Windows: FTDI's D2XX**, `ftd2xx.dll`, through `koffi`. The Toolset's
 *   installer binds FTDI's own driver to the panel with a re-badged INF, and
 *   D2XX is that driver's API. ⚠️ **Never replace it with WinUSB (Zadig)** to
 *   use libusb instead: the Toolset would stop seeing the panel.
 *
 * Both answer the same small interface, and a test passes its own:
 *
 * ```text
 *   backend.name                           'libusb' | 'd2xx'
 *   backend.list({vid, pid, descriptions}) → [{ key, serial, description, busy }]
 *   backend.open(entry)                    → device, already in MPSSE mode
 *   device.write(bytes)                    → Promise<void>
 *   device.read(n, timeoutMs)              → Promise<Uint8Array>, exactly n bytes
 *   device.purge() / device.close()
 * ```
 *
 * ⚠️ Neither road has met a panel. The libusb half follows libftdi's own
 * requests; the D2XX half follows FTDI's programmer's guide and ec50-panel's
 * use of it (which is the one proved on hardware). Neither has run here
 * against an FTDI chip of any kind.
 */

/* FTDI's vendor requests, as libftdi spells them. */
const REQ = Object.freeze({ RESET: 0x00, SET_LATENCY: 0x09, SET_BITMODE: 0x0b });
const RESET = Object.freeze({ SIO: 0, PURGE_RX: 1, PURGE_TX: 2 });
export const BITMODE = Object.freeze({ RESET: 0x00, MPSSE: 0x02 });
/* Vendor request, host to device. */
const OUT_REQTYPE = 0x40;
/* libftdi's `index` for INTERFACE_A, which a single-interface FT232H answers to. */
const INDEX_A = 1;
/* The chip holds a short read back for this long before sending what it has;
   1 ms keeps a key poll a round trip, not a wait. */
const LATENCY_MS = 1;
/* An FT232H on a high-speed port sends 512-byte packets, each led by two
   modem-status bytes that are not data. */
const HS_PACKET = 512;

/**
 * The backend for this platform, or why there is none. Never throws: a host
 * with no FTDI road still runs its other modules.
 *
 * @param {object} [o]
 * @param {string} [o.platform]  process.platform, replaced in tests
 * @param {(name:string) => Promise<any>} [o.importer]  `import`, replaced in tests
 * @param {string} [o.d2xxPath]  where ftd2xx lives (LPP_FTD2XX), for a non-standard install
 */
export async function loadFtdi({
  platform = process.platform,
  importer = (name) => import(name),
  d2xxPath = process.env.LPP_FTD2XX || null,
} = {}) {
  if (platform === 'win32') {
    let koffi;
    try {
      const mod = await importer('koffi');
      koffi = mod.default ?? mod;
    } catch (err) {
      return { ftdi: null, reason: missing(err) ? 'koffi is not installed in devices/ (npm run setup:devices).' : `koffi failed to load: ${err.message}` };
    }
    try {
      return { ftdi: d2xxBackend(koffi, d2xxPath || 'ftd2xx.dll'), reason: null };
    } catch (err) {
      return {
        ftdi: null,
        reason: `FTDI's D2XX driver (ftd2xx.dll) did not load: ${err.message}. It comes with the Event Master Toolset, or from ftdichip.com.`,
      };
    }
  }
  try {
    const mod = await importer('usb');
    return { ftdi: libusbBackend(mod.usb ? mod : (mod.default ?? mod)), reason: null };
  } catch (err) {
    return { ftdi: null, reason: missing(err) ? 'usb is not installed in devices/ (npm run setup:devices).' : `usb failed to load: ${err.message}` };
  }
}

const missing = (err) => err?.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(err?.message ?? '');

/* ================================================================ libusb */

/**
 * @param usbmod  the `usb` package (v2): `getDeviceList()` and the legacy device API
 */
export function libusbBackend(usbmod) {
  const getDeviceList = usbmod.getDeviceList ?? usbmod.usb?.getDeviceList;
  return {
    name: 'libusb',

    async list({ vid, pid }) {
      return getDeviceList()
        .filter((d) => d.deviceDescriptor.idVendor === vid && d.deviceDescriptor.idProduct === pid)
        .map((d) => ({
          key: `usb:${d.busNumber}-${(d.portNumbers || []).join('.') || d.deviceAddress}`,
          serial: null,
          description: null,
          busy: false,
          device: d,
        }));
    },

    async open(entry) {
      const d = entry.device;
      d.open();
      let iface = null;
      try {
        d.timeout = 1000;
        iface = d.interface(0);
        /* Linux only; macOS and Windows answer "not supported", and nothing
           there claims this vendor anyway. */
        try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch { /* not supported here */ }
        iface.claim();
        const out = iface.endpoints.find((e) => e.direction === 'out');
        const inn = iface.endpoints.find((e) => e.direction === 'in');
        if (!out || !inn) throw new Error('the panel has no bulk endpoints');
        out.timeout = 2000;
        inn.timeout = 50;
        const packet = inn.descriptor?.wMaxPacketSize || HS_PACKET;
        const control = (request, value) => new Promise((resolve, reject) => {
          d.controlTransfer(OUT_REQTYPE, request, value, INDEX_A, Buffer.alloc(0), (err) => (err ? reject(err) : resolve()));
        });
        await control(REQ.RESET, RESET.SIO);
        await control(REQ.SET_LATENCY, LATENCY_MS);
        await control(REQ.SET_BITMODE, (BITMODE.RESET << 8) | 0x00);
        await control(REQ.SET_BITMODE, (BITMODE.MPSSE << 8) | 0x00);
        return libusbDevice({ d, iface, out, inn, packet, control });
      } catch (err) {
        try { iface?.release(() => {}); } catch { /* not claimed */ }
        try { d.close(); } catch { /* already */ }
        throw err;
      }
    },
  };
}

function libusbDevice({ d, iface, out, inn, packet, control }) {
  /* Bytes that arrived after a read had what it asked for. In lock-step MPSSE
     there should never be any; kept rather than dropped if there are. */
  let carry = new Uint8Array(0);
  return {
    async write(bytes) {
      await out.transferAsync(Buffer.from(bytes));
    },

    async read(n, timeoutMs = 1000) {
      const deadline = Date.now() + timeoutMs;
      const parts = carry.length ? [carry] : [];
      let have = carry.length;
      carry = new Uint8Array(0);
      while (have < n) {
        let buf;
        try {
          buf = await inn.transferAsync(Math.max(packet, Math.ceil((n - have) / (packet - 2)) * packet));
        } catch (err) {
          if (!/TIMED_OUT|TIMEOUT/i.test(String(err?.message ?? err))) throw err;
          buf = null;
        }
        /* Every packet starts with two modem-status bytes; only the rest is data. */
        for (let at = 0; buf && at < buf.length; at += packet) {
          const p = buf.subarray(at, Math.min(at + packet, buf.length));
          if (p.length > 2) { parts.push(p.subarray(2)); have += p.length - 2; }
        }
        if (have < n && Date.now() > deadline) throw new Error(`the panel sent ${have} of ${n} bytes in ${timeoutMs} ms`);
      }
      const all = concat(parts);
      carry = all.slice(n);
      return all.slice(0, n);
    },

    async purge() {
      carry = new Uint8Array(0);
      await control(REQ.RESET, RESET.PURGE_RX);
      await control(REQ.RESET, RESET.PURGE_TX);
    },

    async close() {
      try { await control(REQ.SET_BITMODE, (BITMODE.RESET << 8) | 0x00); } catch { /* unplugged */ }
      await new Promise((resolve) => { try { iface.release(true, () => resolve()); } catch { resolve(); } });
      try { d.close(); } catch { /* already */ }
    },
  };
}

/* ================================================================== D2XX */

/* FT_STATUS 0 is FT_OK; the rest are named for the error message. */
const FT_STATUS = [
  'OK', 'INVALID_HANDLE', 'DEVICE_NOT_FOUND', 'DEVICE_NOT_OPENED', 'IO_ERROR', 'INSUFFICIENT_RESOURCES',
  'INVALID_PARAMETER', 'INVALID_BAUD_RATE', 'DEVICE_NOT_OPENED_FOR_ERASE', 'DEVICE_NOT_OPENED_FOR_WRITE',
  'FAILED_TO_WRITE_DEVICE', 'EEPROM_READ_FAILED', 'EEPROM_WRITE_FAILED', 'EEPROM_ERASE_FAILED',
  'EEPROM_NOT_PRESENT', 'EEPROM_NOT_PROGRAMMED', 'INVALID_ARGS', 'NOT_SUPPORTED', 'OTHER_ERROR',
];
const FT_PURGE = Object.freeze({ RX: 1, TX: 2 });
/* `FT_DEVICE_LIST_INFO_NODE.Flags` bit 0: some process already has it open. */
const FT_FLAGS_OPENED = 1;

/**
 * @param koffi  the koffi module
 * @param path   ftd2xx.dll, or a path to it (or, in a test, a stand-in library)
 */
export function d2xxBackend(koffi, path) {
  const lib = koffi.load(path);
  /* `FT_HANDLE` is a pointer the library hands out and takes back; we never look inside. */
  const HANDLE = koffi.pointer('FT_HANDLE', koffi.opaque());
  /* WINAPI is __stdcall; on x64 and arm64 there is only one convention and koffi ignores it. */
  const fn = (decl) => lib.func(decl);
  const api = {
    CreateDeviceInfoList: fn('uint32_t __stdcall FT_CreateDeviceInfoList(_Out_ uint32_t *count)'),
    GetDeviceInfoDetail: fn('uint32_t __stdcall FT_GetDeviceInfoDetail(uint32_t index, _Out_ uint32_t *flags, _Out_ uint32_t *type, _Out_ uint32_t *id, _Out_ uint32_t *locId, _Out_ uint8_t *serial, _Out_ uint8_t *description, _Out_ FT_HANDLE *handle)'),
    Open: fn('uint32_t __stdcall FT_Open(int index, _Out_ FT_HANDLE *handle)'),
    Close: fn('uint32_t __stdcall FT_Close(FT_HANDLE handle)'),
    ResetDevice: fn('uint32_t __stdcall FT_ResetDevice(FT_HANDLE handle)'),
    SetTimeouts: fn('uint32_t __stdcall FT_SetTimeouts(FT_HANDLE handle, uint32_t readMs, uint32_t writeMs)'),
    SetLatencyTimer: fn('uint32_t __stdcall FT_SetLatencyTimer(FT_HANDLE handle, uint8_t ms)'),
    SetBitMode: fn('uint32_t __stdcall FT_SetBitMode(FT_HANDLE handle, uint8_t mask, uint8_t mode)'),
    Purge: fn('uint32_t __stdcall FT_Purge(FT_HANDLE handle, uint32_t mask)'),
    Write: fn('uint32_t __stdcall FT_Write(FT_HANDLE handle, const uint8_t *buffer, uint32_t length, _Out_ uint32_t *written)'),
    Read: fn('uint32_t __stdcall FT_Read(FT_HANDLE handle, _Out_ uint8_t *buffer, uint32_t length, _Out_ uint32_t *got)'),
  };
  void HANDLE;

  const check = (what, status) => {
    if (status !== 0) throw new Error(`${what} failed: FT_${FT_STATUS[status] || status}`);
  };
  /* A read or a write can block for its timeout; koffi's async call runs it on
     a worker so the host's event loop keeps answering the app. */
  const later = (f, ...args) => new Promise((resolve, reject) => {
    f.async(...args, (err, status) => (err ? reject(err) : resolve(status)));
  });
  const text = (buf) => {
    const end = buf.indexOf(0);
    return Buffer.from(buf.subarray(0, end < 0 ? buf.length : end)).toString('latin1');
  };

  return {
    name: 'd2xx',

    async list({ vid, pid, descriptions = [] }) {
      const count = [0];
      check('FT_CreateDeviceInfoList', api.CreateDeviceInfoList(count));
      const out = [];
      for (let i = 0; i < count[0]; i++) {
        const flags = [0]; const type = [0]; const id = [0]; const loc = [0]; const handle = [null];
        const serial = new Uint8Array(16); const desc = new Uint8Array(64);
        if (api.GetDeviceInfoDetail(i, flags, type, id, loc, serial, desc, handle) !== 0) continue;
        const description = text(desc);
        const ours = (id[0] >>> 0) === (((vid << 16) | pid) >>> 0)
          || descriptions.some((s) => description.toLowerCase().includes(s));
        /* D2XX reports a blank description and id for a device another
           process has open; it is ours to report as busy, not to skip. */
        const busy = (flags[0] & FT_FLAGS_OPENED) !== 0;
        if (ours || (busy && !description)) {
          out.push({ key: `d2xx:${loc[0]}:${text(serial)}`, index: i, serial: text(serial) || null, description: description || null, busy });
        }
      }
      return out;
    },

    async open(entry) {
      if (entry.busy) throw new Error('another program has the panel open — close the Event Master Toolset');
      const h = [null];
      check('FT_Open', api.Open(entry.index, h));
      const handle = h[0];
      try {
        check('FT_ResetDevice', api.ResetDevice(handle));
        check('FT_SetTimeouts', api.SetTimeouts(handle, 1000, 2000));
        check('FT_SetLatencyTimer', api.SetLatencyTimer(handle, LATENCY_MS));
        check('FT_SetBitMode', api.SetBitMode(handle, 0x00, BITMODE.RESET));
        check('FT_SetBitMode', api.SetBitMode(handle, 0x00, BITMODE.MPSSE));
        check('FT_Purge', api.Purge(handle, FT_PURGE.RX | FT_PURGE.TX));
      } catch (err) {
        api.Close(handle);
        throw err;
      }
      return {
        async write(bytes) {
          const buf = Uint8Array.from(bytes);
          const written = [0];
          check('FT_Write', await later(api.Write, handle, buf, buf.length, written));
          if (written[0] !== buf.length) throw new Error(`FT_Write sent ${written[0]} of ${buf.length} bytes`);
        },
        async read(n, timeoutMs = 1000) {
          /* FT_Read waits up to the timeout set at open for all n bytes. */
          void timeoutMs;
          const buf = new Uint8Array(n);
          const got = [0];
          check('FT_Read', await later(api.Read, handle, buf, n, got));
          if (got[0] !== n) throw new Error(`the panel sent ${got[0]} of ${n} bytes`);
          return buf;
        },
        async purge() { check('FT_Purge', api.Purge(handle, FT_PURGE.RX | FT_PURGE.TX)); },
        async close() {
          try { api.SetBitMode(handle, 0x00, BITMODE.RESET); } catch { /* unplugged */ }
          api.Close(handle);
        },
      };
    },
  };
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
