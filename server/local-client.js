/*
 * Is this browser on the same machine as the server? And if so, is it looking
 * at us through the wrong door?
 *
 * ## The problem this solves
 *
 * Web MIDI, and with it the MIDI Mapping panel and the MTC timecode source,
 * needs a *secure context*. A browser grants that to `https://` origins and to
 * loopback — `localhost`, `127.0.0.1`, `[::1]` — and to nothing else. So the
 * default arrangement, LivePremier Plus on `127.0.0.1:8535`, is a secure
 * context and everything works; but the launcher can bind the server to a LAN
 * interface so other machines can reach it, and then it prints and opens
 * `http://192.168.2.69:8534/`. That page is served by us, on this very
 * machine, and is not a secure context — and until 0.6.1 the only thing on
 * screen said "open Web RCS through LivePremier Plus rather than at the
 * switcher's own address", which the operator had already done.
 *
 * For a browser on *another* machine there is no plain-http answer; that
 * needs HTTPS, which this app does not serve (yet). For a browser on *this*
 * machine there is: the loopback address, which index.js now listens on
 * alongside whatever interface the launcher chose. The question is how the
 * server tells the two apart, and the answer is the TCP source address. A
 * connection that arrives from one of this host's own addresses was made on
 * this host — no remote client can carry our address as its source, NAT or
 * no NAT — so a navigation from our own address to a non-loopback Host header
 * is a local browser that would be better off at 127.0.0.1, and we say so with
 * a 302. Bookmarks to the LAN URL keep working; they just land on the secure
 * door. Only top-level navigations are redirected (GET, HTML wanted, no
 * upgrade): the Web RCS's own fetches and its socket are left exactly where
 * they are.
 *
 * ## Why "same address at both ends", and not "one of our addresses"
 *
 * The first draft asked whether the source address was any address this host
 * owns. That is true of a local browser — and also of a virtual machine on
 * this host reaching us through a NAT bridge whose gateway address is ours,
 * and of a container doing the same. Send either of those to 127.0.0.1 and it
 * lands on itself, with nothing listening. A connection whose source address
 * *equals its destination address* can only have been made on this machine:
 * the kernel picked the interface it was talking to as the source. That is
 * the test. It misses a local browser that reached one interface from
 * another, which then simply gets the page as before, and it never misfires
 * onto a machine that is not us.
 *
 * Pure functions, so the decision can be tested without a socket.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/** `::ffff:192.168.2.69` (a v4 client on a dual-stack socket) → `192.168.2.69`. */
export function plainAddress(addr) {
  if (!addr) return '';
  const a = String(addr);
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

/** The hostname of a Host header, without port or IPv6 brackets. */
export function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']') === -1 ? undefined : h.indexOf(']'));
  const i = h.lastIndexOf(':');
  return i === -1 || h.indexOf(':') !== i ? h : h.slice(0, i);
}

export const isLoopbackHost = (hostHeader) => LOOPBACK_HOSTS.has(hostnameOf(hostHeader));

/**
 * Where to send a request instead, or null to serve it here.
 *
 * @param {{method?: string, url?: string, headers?: object, remoteAddress?: string, localAddress?: string}} req
 *   the request's method, url and headers, and the socket's two addresses
 * @param {{port: number}} opts  the port the loopback listener is on
 */
export function loopbackRedirect(req, { port }) {
  if (!port) return null;
  const method = (req.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return null;
  const headers = req.headers || {};
  if (headers.upgrade) return null;
  if (!String(headers.accept || '').includes('text/html')) return null;
  if (isLoopbackHost(headers.host)) return null;
  const from = plainAddress(req.remoteAddress);
  const to = plainAddress(req.localAddress);
  if (!from || !to || from !== to) return null;
  if (LOOPBACK_HOSTS.has(from)) return null;  // already on loopback, whatever the Host header says
  return `http://127.0.0.1:${port}${req.url || '/'}`;
}
