/*
 * OSC input — the plugin's server half: QLab, TouchOSC or a lighting desk
 * driving the switcher over UDP, with no browser open.
 *
 * OSC is not possible in a page — there is no UDP anywhere in a browser — so
 * it lives here, in this process. The listener is `server/osc.js`, and the
 * address space it answers is the dictionary in `docs/OSC.md`, plus whatever
 * subtrees plugins contribute (`oscAddress` — Matrix Routing's `/lp/matrix/`
 * among them), read per message so a plugin switched on or off changes what
 * is answered without rebinding the socket.
 *
 * It writes to the switcher over AWJ, through `ctx.awj` — so re-pointing the
 * app at a backup frame re-points the OSC input with it, and a cue fires at
 * 20:03 whether or not anybody has a Web RCS open.
 *
 * Its three settings were top-level settings before OSC input was a plugin;
 * the schema lifts them from wherever an older file still has them.
 */

import { createOscServer } from '../../server/osc.js';
import { normaliseOsc, oscChanged } from '../../src/core/settings.js';

export const settings = {
  normalise: normaliseOsc,
  /* Only these ask for a rebind: settings are saved as a whole. */
  changed: oscChanged,
  legacy: ['oscEnabled', 'oscPort', 'oscBind']
};

/* A tail for debugging a sender, not a log — small on purpose. */
const HISTORY = 100;

export default function activate(ctx) {
  const history = [];
  /* What the listener has heard: the tail first, then live, so a console
     opened after a message arrived still shows it. */
  const stream = ctx.stream('/stream', {
    onOpen: (first) => { for (const entry of [...history].reverse()) first.send('osc', entry); }
  });
  const note = (entry) => {
    history.unshift(entry);
    if (history.length > HISTORY) history.length = HISTORY;
    stream.send('osc', entry);
  };

  let osc = null;
  /* One apply at a time: a rebind that overlapped the one before it would
     find its own socket still holding the port. */
  let queue = Promise.resolve();

  /**
   * Bring the listener into line with the settings.
   *
   * Always stops first, even when only the port changed: rebinding a UDP
   * socket that is still open fails with EADDRINUSE against *itself*, which
   * reads as somebody else holding the port and sends whoever is debugging it
   * a long way in the wrong direction.
   */
  const apply = () => {
    queue = queue.then(async () => {
      if (osc) { const closing = osc; osc = null; await closing.stop(); }
      const s = ctx.settings.get();
      if (!s.oscEnabled) return;
      osc = createOscServer({
        port: s.oscPort,
        address: s.oscBind,
        /* Read per message, not captured — see the head of this file. */
        deviceHost: () => ctx.device(),
        awj: ctx.awj,
        addresses: () => ctx.contributions('oscAddress'),
        onActivity: note,
        log: ctx.log
      });
      await osc.start();
    }).catch((err) => ctx.log(`the OSC listener could not start: ${err.message}`));
    return queue;
  };

  ctx.settings.onChange(() => { void apply(); });
  /*
   * The UDP socket is invisible to `server.close()` — it was never the HTTP
   * server's — and a bound datagram socket keeps the event loop alive, so
   * leaving it open would hang the launcher's Stop button.
   */
  ctx.onDispose(async () => {
    await queue;
    if (osc) { const closing = osc; osc = null; await closing.stop(); }
  });

  /* What the settings card shows: listening or not, and what it has done. */
  ctx.route('GET', '/state', (req, res, h) => {
    const s = ctx.settings.get();
    h.json(200, osc ? osc.state : { listening: false, port: s.oscPort, address: s.oscBind, received: 0, sent: 0, failed: 0, lastError: null, platform: null });
  });

  return apply();
}
