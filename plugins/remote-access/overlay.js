/*
 * Remote access — the two overlay networks, as their command-line tools see
 * them.
 *
 * Everything shells out to `tailscale` and `zerotier-cli` rather than talking
 * to either daemon's local API. The CLIs are the stable interface, they are
 * present wherever the daemons are, and they already know where the socket
 * or the auth token lives on each platform — which differs between a Linux
 * box, the macOS app and a Windows service. openrcs made the same choice for
 * its Tailnet view, for the same reasons.
 *
 * Arguments are always separate argv entries, never a shell string, and every
 * value is passed in `--flag=value` form: a value that began with `-` would
 * otherwise be read as another flag.
 *
 * The parsers are pure and exported, so the tests hold them to captured
 * output without either daemon installed.
 */

import { spawn } from 'node:child_process';

/*
 * How long one invocation may take.
 *
 * `tailscale up` on a node with no identity prints a login URL and waits
 * forever, and `tailscale serve` on a tailnet without HTTPS does the same
 * with a URL to enable it. Reached from a button, that would be a request
 * that never comes back — so every call is bounded, and the child is killed.
 */
export const TIMEOUT_MS = 20000;

/**
 * Run a CLI and collect what it says.
 *
 * Resolves `{ ok, stdout, stderr, code, timedOut, missing }` and never
 * rejects: a tool that is not installed is an answer ("not on this host"),
 * not an error.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ timeoutMs?: number, spawnImpl?: typeof spawn }} [opts]
 */
export function run(bin, args, { timeoutMs = TIMEOUT_MS, spawnImpl = spawn } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, stdout, stderr: err.message, code: null, timedOut, missing: err.code === 'ENOENT' });
      return;
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message, code: null, timedOut, missing: err.code === 'ENOENT' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, stdout, stderr, code, timedOut, missing: false });
    });
  });
}

/**
 * The sentence to show for a failed run.
 *
 * The CLI's own words are far more useful than anything invented here —
 * "access denied", "invalid key", "network not found" each say what to do
 * next — so the first non-empty line is kept. A URL anywhere in the output is
 * pulled out separately: it is the one thing an operator must be able to open.
 */
export function failure(r, what) {
  if (r.missing) return { error: `${what} is not installed on this host` };
  const text = `${r.stderr}\n${r.stdout}`;
  const url = (text.match(/https:\/\/\S+/) || [null])[0];
  if (r.timedOut) {
    return url
      ? { error: `${what} is waiting on a page in a browser`, url }
      : { error: `${what} did not answer in time` };
  }
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) || `${what} failed`;
  return url ? { error: first, url } : { error: first };
}

/* ------------------------------------------------------------ Tailscale -- */

/**
 * `tailscale status --json` → what the card shows.
 *
 * `state` is `Running`, `NeedsLogin`, `Stopped`, `NoState` — or empty when
 * the daemon did not answer at all, which is a different fault from being
 * logged out and the one people misread.
 */
export function parseTailscaleStatus(json) {
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { v = null; }
  if (!v || typeof v !== 'object') return { state: '', name: '', addresses: [], httpsNames: [] };
  const self = v.Self || {};
  return {
    state: String(v.BackendState || ''),
    name: String(self.DNSName || '').replace(/\.$/, ''),
    hostName: String(self.HostName || ''),
    addresses: Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.map(String) : [],
    /* Non-empty only when the tailnet has HTTPS certificates switched on —
       which `tailscale serve` needs. Saying so before trying is kinder than
       the CLI waiting on a URL. */
    httpsNames: Array.isArray(v.CertDomains) ? v.CertDomains.map(String) : [],
    tailnet: String((v.CurrentTailnet && v.CurrentTailnet.Name) || '')
  };
}

/**
 * Who holds an HTTPS port in `tailscale serve status --json`, as the proxy
 * URL of its root handler — or null when nothing serves on it.
 *
 * The shape is `{ TCP: { "443": { HTTPS: true } }, Web: { "<name>:443":
 * { Handlers: { "/": { Proxy: "http://127.0.0.1:8535" } } } } }`. Anything
 * other than a root proxy on that port (a path, a file, raw TCP) is somebody
 * else's too, and reported as `'(other)'` so it is never overwritten.
 */
export function serveHolder(json, httpsPort) {
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json || '{}') : json; } catch { v = null; }
  if (!v || typeof v !== 'object') return null;
  const key = String(httpsPort);
  const tcp = v.TCP && v.TCP[key];
  const webKey = Object.keys(v.Web || {}).find((k) => k.endsWith(`:${key}`));
  if (!tcp && !webKey) return null;
  const handlers = webKey ? (v.Web[webKey].Handlers || {}) : {};
  const paths = Object.keys(handlers);
  if (paths.length === 1 && paths[0] === '/' && handlers['/'].Proxy) return String(handlers['/'].Proxy);
  return '(other)';
}

/** The loopback URL this app is served from, as `tailscale serve` is given it. */
export const serveTarget = (port) => `http://127.0.0.1:${port}`;

/** The address an operator types, for a tailnet name and an HTTPS port. */
export const serveUrl = (name, httpsPort) =>
  (name ? `https://${name}${Number(httpsPort) === 443 ? '' : `:${httpsPort}`}/` : '');

/** A machine name Tailscale will accept — checked here so a typo is a sentence, not usage text. */
export function validHostname(s) {
  return typeof s === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(s);
}

/** Auth keys begin `tskey-`; anything else is refused before the CLI sees it. */
export function validAuthKey(s) {
  return typeof s === 'string' && /^tskey-[A-Za-z0-9_-]{8,250}$/.test(s);
}

export function createTailscale({ bin = 'tailscale', exec = run } = {}) {
  const ts = (args, opts) => exec(bin, args, opts);
  return {
    async status() {
      const r = await ts(['status', '--json'], { timeoutMs: 5000 });
      /* `status` exits non-zero while logged out but still prints the JSON. */
      const parsed = parseTailscaleStatus(r.stdout);
      return { installed: !r.missing, ...parsed };
    },
    async serveHolder(httpsPort) {
      const r = await ts(['serve', 'status', '--json'], { timeoutMs: 5000 });
      return r.ok ? serveHolder(r.stdout, httpsPort) : null;
    },
    async serve(httpsPort, port) {
      const r = await ts(['serve', '--bg', '--yes', `--https=${httpsPort}`, serveTarget(port)]);
      return r.ok ? { ok: true } : failure(r, 'tailscale serve');
    },
    async unserve(httpsPort) {
      const r = await ts(['serve', `--https=${httpsPort}`, 'off'], { timeoutMs: 8000 });
      return r.ok ? { ok: true } : failure(r, 'tailscale serve');
    },
    async up(authKey) {
      const args = ['up'];
      if (authKey) args.push(`--authkey=${authKey}`);
      const r = await ts(args);
      return r.ok ? { ok: true } : failure(r, 'tailscale up');
    },
    async down() {
      /* `down` only: the node keeps its identity, so reconnecting is a button
         rather than a re-registration. */
      const r = await ts(['down'], { timeoutMs: 8000 });
      return r.ok ? { ok: true } : failure(r, 'tailscale down');
    },
    async rename(name) {
      const r = await ts(['set', `--hostname=${name}`], { timeoutMs: 8000 });
      return r.ok ? { ok: true } : failure(r, 'tailscale set');
    }
  };
}

/* ------------------------------------------------------------- ZeroTier -- */

/** A ZeroTier network id: sixteen hex digits. */
export const validNetworkId = (s) => typeof s === 'string' && /^[0-9a-f]{16}$/i.test(s);

/**
 * `zerotier-cli -j listnetworks` → one row per network.
 *
 * `status` is ZeroTier's own word: `OK` once the controller has authorised
 * this node, `ACCESS_DENIED` until somebody ticks it in the controller,
 * `REQUESTING_CONFIGURATION` while it is asking, `NOT_FOUND` for a bad id.
 * An address only arrives with `OK`, which is why the doors wait for it.
 */
export function parseZeroTierNetworks(json) {
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { v = null; }
  if (!Array.isArray(v)) return [];
  return v.map((n) => ({
    id: String(n.nwid || n.id || ''),
    name: String(n.name || ''),
    status: String(n.status || ''),
    addresses: (Array.isArray(n.assignedAddresses) ? n.assignedAddresses : [])
      .map((a) => String(a).split('/')[0])
      .filter(Boolean)
  }));
}

/** The addresses this host has on authorised networks — where a door can open. */
export const zeroTierAddresses = (networks) =>
  [...new Set(networks.filter((n) => n.status === 'OK').flatMap((n) => n.addresses))];

export function parseZeroTierInfo(json) {
  let v;
  try { v = typeof json === 'string' ? JSON.parse(json) : json; } catch { v = null; }
  if (!v || typeof v !== 'object') return { node: '', online: false, version: '' };
  return { node: String(v.address || ''), online: Boolean(v.online), version: String(v.version || '') };
}

export function createZeroTier({ bin = 'zerotier-cli', exec = run } = {}) {
  const zt = (args, opts) => exec(bin, args, opts);
  return {
    async status() {
      const [info, nets] = await Promise.all([
        zt(['-j', 'info'], { timeoutMs: 5000 }),
        zt(['-j', 'listnetworks'], { timeoutMs: 5000 })
      ]);
      if (info.missing) return { installed: false, node: '', online: false, networks: [], error: null };
      /* The usual failure is the auth token: zerotier-cli reads it from the
         service's home, which only root can, unless it was copied to the
         account this app runs as. Surfaced, because it is the whole fix. */
      const error = info.ok ? null : failure(info, 'zerotier-cli').error;
      return {
        installed: true,
        ...parseZeroTierInfo(info.ok ? info.stdout : null),
        networks: nets.ok ? parseZeroTierNetworks(nets.stdout) : [],
        error
      };
    },
    async join(id) {
      const r = await zt(['join', id], { timeoutMs: 8000 });
      return r.ok ? { ok: true } : failure(r, 'zerotier-cli join');
    },
    async leave(id) {
      const r = await zt(['leave', id], { timeoutMs: 8000 });
      return r.ok ? { ok: true } : failure(r, 'zerotier-cli leave');
    }
  };
}
