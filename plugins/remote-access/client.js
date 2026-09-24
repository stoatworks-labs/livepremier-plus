/*
 * Remote access — the plugin's page half: its card on the settings page.
 *
 * What the card has to make plain is where the app can be reached from, and
 * by whom: an address that works from the far side of the world is also one
 * every member of that network can drive the switcher through. So the doors
 * that are open are listed by address, and the note under them says so.
 *
 * The membership controls — an auth key, a network id, Leave — are drawn only
 * when the server says it is an appliance; the server refuses them otherwise,
 * so hiding them is manners, not the gate.
 */

/** How often the card asks again, while it is drawn. Each ask runs the CLIs. */
const POLL_MS = 5000;

const TAILSCALE_CHOICES = [
  { id: 'off', label: 'Off', what: 'Not served over Tailscale.' },
  {
    id: 'serve', label: 'HTTPS on the tailnet name',
    what: 'tailscale serve puts this app at https://<machine>.<tailnet>.ts.net/ with a real certificate, while it stays on loopback here. A secure context, so MIDI and audio input work from the remote browser too. Needs HTTPS certificates switched on for the tailnet.'
  },
  {
    id: 'bind', label: 'Plain http on the tailnet address',
    what: 'Also answers on this host’s 100.x address at the app’s own port. Works on any tailnet, but plain http off loopback is not a secure context — no MIDI or audio input from there.'
  }
];

const HTTPS_PORTS = [
  { id: '443', label: '443', what: 'The address needs no port.' },
  { id: '8443', label: '8443', what: 'For a host that already serves something else on 443.' },
  { id: '10000', label: '10000', what: 'For a host that already serves something else on 443 and 8443.' }
];

export default function activate(ctx) {
  const { h, card, note, readout, picker, button } = ctx.kit;
  let live = null;
  let asked = 0;
  let problem = null;
  let busy = false;
  /* Typed values live here, not in the DOM: the card is redrawn when the
     state moves, and a key half typed must survive that. */
  const draft = { authKey: '', rename: '', network: '' };

  function poll(force) {
    if (!force && Date.now() - asked < POLL_MS) return;
    asked = Date.now();
    fetch(ctx.url('/state'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((state) => {
        if (state && JSON.stringify(state) !== JSON.stringify(live)) { live = state; ctx.refresh(); }
      })
      .catch(() => { /* the next draw asks again */ });
  }

  const save = (patch) => ctx.settings.set(patch).then(
    () => { problem = null; poll(true); ctx.refresh(); },
    (err) => { problem = err.message; ctx.refresh(); });

  async function act(path, body, clear) {
    busy = true; problem = null; ctx.refresh();
    try {
      const r = await fetch(ctx.url(path), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {})
      });
      const answer = await r.json().catch(() => ({}));
      if (!r.ok) problem = answer.url ? `${answer.error} — ${answer.url}` : (answer.error || `${r.status}`);
      else if (clear) draft[clear] = '';
    } catch (err) { problem = err.message; }
    busy = false;
    poll(true);
    ctx.refresh();
  }

  const field = (key, placeholder, width = '16rem', secret = false) => h('input', {
    class: 'wru-input', type: secret ? 'password' : 'text', value: draft[key], placeholder,
    autocomplete: 'off', spellcheck: 'false', style: { maxWidth: width },
    onInput: (ev) => { draft[key] = ev.target.value; }
  });

  const link = (url) => h('a', { href: url, target: '_blank', rel: 'noopener', class: 'aw-font-body-1-bold', text: url });

  function tailscaleRows(s) {
    const ts = live && live.tailscale;
    if (!ts) return [];
    if (!ts.installed) return [note('warn', 'Tailscale is not installed on this host.')];
    const rows = [h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('Tailscale', ts.state || 'not answering', { tone: ts.state === 'Running' ? null : 'tertiary' }),
      readout('Machine', ts.name || '—', { tone: ts.name ? null : 'tertiary' }),
      ts.tailnet ? readout('Tailnet', ts.tailnet) : null)];
    if (s.tailscale === 'serve' && ts.url) {
      rows.push(h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Open from the tailnet' }), link(ts.url)));
    }
    if (ts.serveError) {
      rows.push(note('warn', ts.serveError.error));
      if (ts.serveError.url) rows.push(link(ts.serveError.url));
    }
    if (live.appliance) {
      rows.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        field('authKey', 'tskey-auth-…', '18rem', true),
        button(ts.state === 'Stopped' && !draft.authKey ? 'Reconnect' : 'Join', {
          disabled: busy, onClick: () => act('/tailscale/up', { authKey: draft.authKey.trim() }, 'authKey')
        }),
        button('Disconnect', { disabled: busy || ts.state !== 'Running', onClick: () => act('/tailscale/down') }),
        field('rename', ts.hostName || 'machine name', '12rem'),
        button('Rename', { disabled: busy, onClick: () => act('/tailscale/rename', { name: draft.rename.trim() }, 'rename') })));
    }
    return rows;
  }

  function zerotierRows(s) {
    const zt = live && live.zerotier;
    if (!zt) return [];
    if (!zt.installed) return [note('warn', 'ZeroTier is not installed on this host.')];
    const rows = [];
    if (zt.error) {
      rows.push(note('warn', `zerotier-cli: ${zt.error}. It reads the service’s auth token, which only root can — copy it to ~/.zeroTierOneAuthToken for the account this app runs as.`));
    }
    rows.push(h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
      readout('ZeroTier node', zt.node || '—', { tone: zt.node ? null : 'tertiary' }),
      readout('Online', zt.online ? 'yes' : 'no', { tone: zt.online ? null : 'tertiary' })));
    for (const n of zt.networks) {
      rows.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-extra-large aw-flex-wrap' },
        readout(n.name || 'Network', n.id),
        readout('Status', n.status === 'ACCESS_DENIED' ? 'waiting to be authorised in the controller' : n.status,
          { tone: n.status === 'OK' ? null : 'tertiary' }),
        readout('Addresses', n.addresses.join(', ') || '—', { tone: n.addresses.length ? null : 'tertiary' }),
        live.appliance ? button('Leave', { disabled: busy, onClick: () => act('/zerotier/leave', { network: n.id }) }) : null));
    }
    if (!zt.networks.length) rows.push(note('info', 'This host is on no ZeroTier network.'));
    if (live.appliance) {
      rows.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-small aw-flex-wrap' },
        field('network', 'network id — 16 hex digits', '14rem'),
        button('Join', { disabled: busy, onClick: () => act('/zerotier/join', { network: draft.network.trim() }, 'network') })));
    }
    return rows;
  }

  function render() {
    poll();
    const s = ctx.settings.get();

    const zerotierToggle = h('label', { class: 'aw-flex-row-center-v aw-gap-col-small', style: { cursor: 'pointer' } },
      h('input', {
        type: 'checkbox', checked: s.zerotier ? 'checked' : null,
        onChange: (ev) => void save({ zerotier: ev.target.checked })
      }),
      h('span', { class: 'aw-font-body-1', text: 'Answer on this host’s ZeroTier addresses' }));

    const notes = [];
    if (problem) notes.push(note('warn', problem));
    if (live && live.wildcard && (s.tailscale === 'bind' || s.zerotier)) {
      notes.push(note('info', `This app is bound to every interface (${live.bind}), so it already answers on the tailnet and ZeroTier addresses — no extra door is needed.`));
    }
    if (live && live.doors.length) {
      notes.push(h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Also answering on' }),
        ...live.doors.map((d) => {
          const host = d.address.includes(':') ? `[${d.address}]` : d.address;
          return h('div', { class: 'aw-font-body-1', text: `http://${host}:${d.port}/  — ${d.via}` });
        })));
    }
    if (s.tailscale !== 'off' || s.zerotier) {
      notes.push(note('warn',
        'Neither network is a login for this app, and it has none: every member of the tailnet or the ZeroTier network '
        + 'that can reach this host can drive the switcher. Keep who can reach it in the tailnet’s ACLs or the ZeroTier controller’s rules.'));
    }
    if (live && !live.appliance) {
      notes.push(note('info', 'Joining and leaving networks from here is for an appliance: start the app with --appliance (LPP_APPLIANCE=1) on a box that exists to run it.'));
    }

    return card('Remote access',
      h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
        picker('Tailscale', TAILSCALE_CHOICES, s.tailscale, (v) => void save({ tailscale: v })),
        s.tailscale === 'serve'
          ? picker('HTTPS port', HTTPS_PORTS, String(s.httpsPort), (v) => void save({ httpsPort: Number(v) }))
          : null),
      ...(s.tailscale !== 'off' || (live && live.appliance) ? tailscaleRows(s) : []),
      zerotierToggle,
      ...(s.zerotier || (live && live.appliance) ? zerotierRows(s) : []),
      ...notes);
  }

  ctx.ui.settingsSection({ id: 'remote-access', order: 6, render });
}
