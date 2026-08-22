/*
 * The app's own settings: what they are, what they default to, and the one
 * place that decides whether a stored value is allowed.
 *
 * ## Why these are server-side and not `localStorage`
 *
 * Two of them are not the page's business at all. The OSC listener is a UDP
 * socket in this process; a browser cannot open one, cannot see one, and
 * cannot be the authority on whether one is bound. And the console can be
 * open in two places at once — the tab and the popped-out window — so a
 * setting kept per-page would have the two of them disagreeing about which
 * language the operator chose.
 *
 * So settings live in `~/.livepremier-plus/settings.json`, read and written
 * over `/__lpp/settings`, and every surface asks the same process.
 *
 * ## Why they are not keyed by device
 *
 * A cue stack belongs to one switcher. These belong to the installation. An
 * operator re-pointing at a backup frame mid-show must not find the command
 * language changed under them or a port a lighting desk is sending to quietly
 * closed.
 *
 * ## `core/` still knows nothing about browsers
 *
 * This file is data and validation. It runs under plain Node — the server
 * imports it to sanitise what it stores, the panels import it for the same
 * table of what is allowed — and it does no I/O of its own.
 */

export const LANGUAGE_CHOICES = [
  {
    id: 'all',
    label: 'All — detect the language of each line',
    what: 'Reads each line as whichever language it looks like, and honours a leading MYNAH, AWJ, JSON or OSC.',
  },
  { id: 'mynah', label: 'Mynah only', what: 'The command language. Detection off.' },
  { id: 'awj', label: 'AWJ only', what: 'Raw AWJ messages, in the vendor’s own protocol. Detection off.' },
  { id: 'json', label: 'JSON only', what: 'Raw Web RCS store writes, as the socket carries them. Detection off.' },
  { id: 'osc', label: 'OSC only', what: 'Addresses from the published OSC dictionary. Detection off.' },
];

export const AWJ_TRANSPORTS = [
  {
    id: 'store',
    label: 'Store writes — the vendor’s own socket',
    what: 'Convert the message to the store spelling and send it on the connection this page already has. Lands at the same node; cannot answer a get.',
  },
  {
    id: 'socket',
    label: 'TCP 10606 — a real AWJ socket',
    what: 'Send the message as typed and read the reply. Opened by this process, one connection per exchange, and it spends one of the device’s five AWJ client slots while it is open.',
  },
];

/**
 * What the OSC listener may bind to.
 *
 * A closed list rather than a free-text field, and that is the safety
 * argument: this port fires takes on a video switcher, so the choice between
 * "only this machine" and "anything on the network" should be a decision
 * somebody made in words, not a value they typed without reading.
 */
export const OSC_BIND_CHOICES = [
  {
    id: '127.0.0.1',
    label: 'This machine only',
    what: 'Only software on this computer can send. The safe default.',
  },
  {
    id: '0.0.0.0',
    label: 'Any interface — the network can drive the switcher',
    what: 'Anything that can reach this machine can fire takes. Only on a show network you control.',
  },
];

export const DEFAULT_SETTINGS = {
  /* Detection, because a console pinned to one language is one an operator has
     to configure before it is useful. */
  consoleLanguage: 'all',
  /* The transport that works everywhere and spends no AWJ client slot.
     Someone who wants the wire-truthful one is being deliberate. */
  awjTransport: 'store',
  /* Off. An open UDP port that fires takes on a switcher is not something to
     turn on for somebody. */
  oscEnabled: false,
  oscPort: 8000,
  oscBind: '127.0.0.1',
};

const ids = (list) => list.map((c) => c.id);

/**
 * Coerce anything into a valid settings object.
 *
 * Every field is checked against its own closed list or range and falls back
 * to the default rather than being rejected wholesale. That is deliberate:
 * this runs on a file that a previous version wrote and that a person may have
 * edited, and refusing to start over one bad field would take the whole app
 * down for a typo. A field that is wrong is reported by being *not what was
 * typed*, which is visible in the settings page.
 */
export function normalise(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const pick = (value, list, fallback) => (ids(list).includes(value) ? value : fallback);

  const port = Number(input.oscPort);
  return {
    consoleLanguage: pick(input.consoleLanguage, LANGUAGE_CHOICES, DEFAULT_SETTINGS.consoleLanguage),
    awjTransport: pick(input.awjTransport, AWJ_TRANSPORTS, DEFAULT_SETTINGS.awjTransport),
    oscEnabled: input.oscEnabled === true,
    /* Above 1024 so it never needs privilege to bind, which would be a
       surprising thing for this app to ask for. */
    oscPort: Number.isInteger(port) && port > 1024 && port < 65536 ? port : DEFAULT_SETTINGS.oscPort,
    oscBind: pick(input.oscBind, OSC_BIND_CHOICES, DEFAULT_SETTINGS.oscBind),
  };
}

/** True when a change needs the UDP socket rebound rather than just noted. */
export const oscChanged = (a, b) =>
  a.oscEnabled !== b.oscEnabled || a.oscPort !== b.oscPort || a.oscBind !== b.oscBind;
