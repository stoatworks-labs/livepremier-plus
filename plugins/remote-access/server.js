/*
 * Remote access — the plugin's server half: this app reached over Tailscale
 * or ZeroTier, from anywhere the tailnet or the network reaches, without
 * binding it to the venue LAN.
 *
 * ## Tailscale, two ways
 *
 * - **HTTPS (`tailscale serve`)** — the default, and the better one. The app
 *   stays on loopback; tailscaled terminates TLS for `https://<machine>.<tailnet>.ts.net/`
 *   with a real certificate and proxies to `127.0.0.1:<port>`. An https page
 *   is a *secure context*, so Web MIDI and audio input for LTC work
 *   from the remote browser too — which plain http on any address but
 *   loopback never gives (see server/local-client.js). It needs HTTPS
 *   certificates switched on for the tailnet, once, in its admin console.
 * - **Tailnet address** — a door on this host's 100.x (and fd7a:) addresses at
 *   the app's own port, plain http. Works on any tailnet; loses the secure
 *   context.
 *
 * ## ZeroTier
 *
 * ZeroTier has no `serve`, so it is always a door: one listener per address
 * this host holds on an authorised network, at the app's own port. Addresses
 * arrive when a controller authorises the node and go when it leaves, so the
 * doors are reconciled on a timer rather than opened once.
 *
 * ## Who may do what
 *
 * Serving is a setting, off until somebody switches it on, like OSC input.
 * **Changing membership** — joining a tailnet with an auth key, leaving,
 * renaming, joining or leaving a ZeroTier network — changes the *host's*
 * networking, and only happens when the app was started with `--appliance`:
 * on a laptop those belong to its owner, not to a web page. The gate is here,
 * at the route, not a hidden button.
 *
 * Neither network is authentication for this app, and this app has none: a
 * member of the tailnet or the ZeroTier network can drive the switcher. The
 * tailnet's ACLs, or the ZeroTier controller's rules, are the access control.
 */

import {
  createTailscale, createZeroTier, zeroTierAddresses, serveTarget, serveUrl,
  validHostname, validAuthKey, validNetworkId
} from './overlay.js';

export const TAILSCALE_MODES = ['off', 'serve', 'bind'];

export const settings = {
  normalise(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const httpsPort = Number(s.httpsPort);
    return {
      tailscale: TAILSCALE_MODES.includes(s.tailscale) ? s.tailscale : 'off',
      /* 443, 8443 and 10000 are the ports tailscale serve accepts for HTTPS. */
      httpsPort: [443, 8443, 10000].includes(httpsPort) ? httpsPort : 443,
      zerotier: s.zerotier === true
    };
  }
};

/* How often addresses are looked at again. ZeroTier's arrive when somebody
   authorises the node in a controller, which is a person clicking, not a
   packet — a quarter of a minute is prompt enough. */
const RECONCILE_MS = 15000;

export default function activate(ctx, {
  tailscale = createTailscale(), zerotier = createZeroTier(), every = RECONCILE_MS
} = {}) {
  const app = ctx.use('app');
  const appliance = Boolean(app && app.appliance);
  const port = app && app.port;
  const bind = String((app && app.bind) || '127.0.0.1');
  const wildcard = bind === '0.0.0.0' || bind === '::';

  /** address -> { door, via } for each extra listener open now. */
  const doors = new Map();
  /** address -> the last reason it would not open, so the log says it once. */
  const refused = new Map();
  /** The HTTPS port this process put a `tailscale serve` on, or null. */
  let serving = null;
  let serveError = null;
  let serveUrlShown = null;
  let last = { tailscale: null, zerotier: null };
  let stopped = false;

  const setting = () => ctx.settings.get();

  /** Open a door on each wanted address; close each that is no longer wanted. */
  async function syncDoors(wanted) {
    for (const [address, { door }] of doors) {
      if (wanted.has(address)) continue;
      doors.delete(address);
      await door.close();
      ctx.log(`stopped answering on ${address}`);
    }
    for (const [address, via] of wanted) {
      if (doors.has(address) || stopped) continue;
      try {
        const door = await app.listen(address);
        doors.set(address, { door, via });
        refused.delete(address);
        ctx.log(`answering on http://${address.includes(':') ? `[${address}]` : address}:${port}/ over ${via}`);
      } catch (err) {
        /* Most often EADDRNOTAVAIL: the address is in the CLI's answer a
           moment before the interface carries it. The next pass retries. */
        if (refused.get(address) !== err.code) ctx.log(`could not answer on ${address}: ${err.message}`);
        refused.set(address, err.code || err.message);
      }
    }
  }

  async function syncServe(want, ts) {
    const s = setting();
    if (serving !== null && (!want || serving !== s.httpsPort)) {
      /* Only ever take down what points at us — if somebody re-pointed the
         port by hand since, it is theirs now. */
      const holder = await tailscale.serveHolder(serving);
      if (holder === serveTarget(port)) {
        const r = await tailscale.unserve(serving);
        if (!r.ok) ctx.log(`could not stop tailscale serve on ${serving}: ${r.error}`);
      }
      ctx.log(`no longer served over Tailscale HTTPS on ${serving}`);
      serving = null;
      serveUrlShown = null;
    }
    if (!want || serving !== null) return;
    if (ts.state !== 'Running') { serveError = { error: 'Tailscale is not connected on this host' }; return; }
    if (!ts.httpsNames.length) {
      serveError = {
        error: 'HTTPS certificates are off for this tailnet — switch them on in the Tailscale admin console (DNS ▸ HTTPS Certificates), or serve on the tailnet address instead',
        url: 'https://login.tailscale.com/admin/dns'
      };
      return;
    }
    const holder = await tailscale.serveHolder(s.httpsPort);
    if (holder && holder !== serveTarget(port)) {
      serveError = { error: `HTTPS port ${s.httpsPort} on this host is already served to ${holder} — pick another port, or free it with tailscale serve` };
      return;
    }
    const r = await tailscale.serve(s.httpsPort, port);
    if (!r.ok) { serveError = r; ctx.log(`tailscale serve: ${r.error}${r.url ? ` (${r.url})` : ''}`); return; }
    serving = s.httpsPort;
    serveError = null;
    serveUrlShown = serveUrl(ts.name, s.httpsPort);
    ctx.log(`served over Tailscale at ${serveUrlShown}`);
  }

  /** Bring the doors and the serve into line with the settings and the networks. */
  async function reconcile() {
    if (stopped) return;
    const s = setting();
    const ts = s.tailscale === 'off' && !appliance ? null : await tailscale.status();
    const zt = !s.zerotier && !appliance ? null : await zerotier.status();
    last = { tailscale: ts, zerotier: zt };

    await syncServe(s.tailscale === 'serve' && ts && ts.installed, ts || {});

    const wanted = new Map();
    /* Bound to every interface already, the app answers on these addresses
       as it is — and on Linux a second bind to the same port would be
       refused anyway. */
    if (!wildcard) {
      if (s.tailscale === 'bind' && ts && ts.state === 'Running') for (const a of ts.addresses) wanted.set(a, 'Tailscale');
      if (s.zerotier && zt) for (const a of zeroTierAddresses(zt.networks)) wanted.set(a, 'ZeroTier');
    }
    await syncDoors(wanted);
  }

  /* One pass at a time: a settings save during a timer pass would otherwise
     open the same door twice. */
  let queue = Promise.resolve();
  const apply = () => {
    queue = queue.then(reconcile).catch((err) => ctx.log(`remote access: ${err.message}`));
    return queue;
  };

  ctx.settings.onChange(() => { void apply(); });
  const timer = setInterval(() => { void apply(); }, every);
  timer.unref?.();

  ctx.onDispose(async () => {
    stopped = true;
    clearInterval(timer);
    await queue;
    await syncServe(false, {});
    await syncDoors(new Map());
  });

  /* ----------------------------------------------------------- routes -- */

  ctx.route('GET', '/state', async (req, res, h) => {
    /* Fresh on request, not the timer's last look: the card is how an
       operator checks a join they just made. */
    await apply();
    const s = setting();
    h.json(200, {
      appliance,
      port,
      bind,
      wildcard,
      settings: s,
      tailscale: last.tailscale && {
        ...last.tailscale,
        serving: serving !== null,
        url: serveUrlShown,
        serveError: s.tailscale === 'serve' ? serveError : null
      },
      zerotier: last.zerotier,
      doors: [...doors].map(([address, { via }]) => ({ address, via, port }))
    });
  });

  /* Membership: an appliance's, never a laptop's. */
  const owned = (fn) => async (req, res, h) => {
    if (!appliance) {
      throw new ctx.HttpError(403, 'this host was not started as an appliance — its Tailscale and ZeroTier membership belong to its owner, not to this page (start with --appliance)');
    }
    const body = (await h.readJson(4096)) || {};
    const r = await fn(body);
    if (!r.ok) return h.json(409, r);
    await apply();
    return h.json(200, { ok: true });
  };

  ctx.route('POST', '/tailscale/up', owned(async ({ authKey }) => {
    const key = String(authKey || '').trim();
    if (key && !validAuthKey(key)) return { error: 'that is not an auth key — they begin tskey-' };
    if (!key) {
      /* Without a key `up` only reconnects a node that already has an
         identity; on one that has none it would wait on a login URL. */
      const st = await tailscale.status();
      if (st.state !== 'Stopped') return { error: 'this host has no Tailscale identity yet — enter an auth key to join' };
    }
    return tailscale.up(key);
  }));
  ctx.route('POST', '/tailscale/down', owned(() => tailscale.down()));
  ctx.route('POST', '/tailscale/rename', owned(async ({ name }) => {
    const n = String(name || '').trim();
    if (!validHostname(n)) return { error: 'a name is letters, digits and hyphens, and cannot start or end with a hyphen' };
    return tailscale.rename(n);
  }));
  ctx.route('POST', '/zerotier/join', owned(async ({ network }) => {
    const id = String(network || '').trim().toLowerCase();
    if (!validNetworkId(id)) return { error: 'a ZeroTier network id is sixteen hex digits' };
    return zerotier.join(id);
  }));
  ctx.route('POST', '/zerotier/leave', owned(async ({ network }) => {
    const id = String(network || '').trim().toLowerCase();
    if (!validNetworkId(id)) return { error: 'a ZeroTier network id is sixteen hex digits' };
    return zerotier.leave(id);
  }));

  return apply();
}
