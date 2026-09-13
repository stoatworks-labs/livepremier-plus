/*
 * What to say about a page that is not a secure context.
 *
 * Web MIDI — the MIDI Mapping panel, the MTC timecode source — and
 * `getUserMedia` — the LTC timecode source — need a secure context, and a
 * browser grants that to https and to loopback (`localhost`, `127.0.0.1`,
 * `[::1]`) and to nothing else. There are two ways to land on a
 * plain-http LAN origin, and until 0.6.1 the note on the Settings page only
 * knew about one of them: the switcher's own address. The other is
 * LivePremier Plus itself, bound to a LAN interface by the launcher and opened
 * at `http://192.168.2.69:8534/` — served by us, on this very machine, and
 * told to "open it through LivePremier Plus", which the operator had already
 * done.
 *
 * So the advice is written for the page that is actually open: it names the
 * loopback door the server now always has beside a LAN bind
 * (`server/local-client.js` sends a local browser there itself), and is honest
 * that a browser on another machine needs HTTPS, which this app does not serve
 * yet. Pure, so it is testable and so the three panels that need it share one
 * sentence rather than three drifting ones.
 */

/**
 * @param {{protocol?: string, host?: string, port?: string, pathname?: string}} loc
 *   `window.location`, or anything shaped like it
 */
export function insecureContextAdvice(loc = {}) {
  const protocol = loc.protocol || 'http:';
  const port = loc.port || (protocol === 'https:' ? '443' : '80');
  const here = `${protocol}//${loc.host || 'this address'}`;
  const local = `http://127.0.0.1:${port}${loc.pathname || '/'}`;
  return `This page is open at ${here}, which is not a secure context — only localhost and https are — ` +
    'so the browser withholds Web MIDI and audio input here: MIDI Mapping and the MTC and LTC timecode sources. ' +
    `On this machine open ${local} instead — LivePremier Plus answers there too, and sends a local browser there when it can tell. ` +
    'From another machine those need HTTPS, which this app does not serve yet; everything else works.';
}

/** True when `loc` is a loopback origin — the one plain-http secure context. */
export function isLoopbackLocation(loc = {}) {
  const h = String(loc.hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}
