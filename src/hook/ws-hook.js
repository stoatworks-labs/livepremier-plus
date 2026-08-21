/*
 * LivePremier Plus — WebSocket hook.
 *
 * Inlined by the proxy into the document's <head>, ahead of the vendor's
 * scripts. That placement is the whole point: the Web RCS bundle opens its
 * socket during its own boot, so a hook installed any later would miss the
 * connection and every frame up to it.
 *
 * As an extension this ran as a MAIN-world content script at document_start,
 * which usually won that race but was never promised to. Injected into the
 * markup it is not a race at all — every vendor script tag is `defer`, and an
 * inline classic script runs when the parser reaches it, which is strictly
 * earlier. This file is served as-is; the proxy reads these exact bytes.
 *
 * Deliberately dependency-free and tiny. It does not parse or interpret the
 * protocol beyond recognising the envelope — all of that lives in core/, which
 * loads later as a module.
 */
(() => {
  'use strict';
  if (window.__WRU_HOOK) return;

  const RING_MAX = 8192;
  const PING = '0x9';
  const PONG = '0xA';

  const hook = {
    version: 1,
    /** Frames seen since page start, oldest first: {seq, dir, raw}. */
    ring: [],
    /** Monotonic counter across every frame, never reset by ring trimming. */
    seq: 0,
    /** The socket the Web RCS app itself is using, once we have identified it. */
    appSocket: null,
    /** True once a frame with an Analog Way envelope has been seen. */
    detected: false,
    listeners: new Set(),
    sockets: new Set()
  };

  /* Is this the Web RCS envelope? Cheap string test first — the full parse
     happens in core/, and this runs on every frame of every page. */
  const looksAW = (s) =>
    typeof s === 'string' &&
    s.length > 12 &&
    s.charCodeAt(0) === 123 /* { */ &&
    (s.indexOf('"channel":"DEVICE"') > 0 ||
      s.indexOf('"channel":"REMOTE"') > 0 ||
      s.indexOf('"channel":"LOG"') > 0);

  /**
   * Start following a socket.
   *
   * Called both for sockets we saw being constructed and for one we recognise
   * later from its traffic. The second case matters more than it looks: an
   * extension reloaded or enabled mid-session lands on a page whose socket is
   * already open, and without this it would sit deaf until the next reload.
   */
  function adopt(socket) {
    if (!socket || hook.sockets.has(socket)) return;
    hook.sockets.add(socket);
    socket.addEventListener('message', (ev) => record('in', ev.data, socket));
    socket.addEventListener('close', () => {
      hook.sockets.delete(socket);
      if (hook.appSocket === socket) hook.appSocket = null;
    });
  }

  function record(dir, raw, socket) {
    /* The keep-alive is not worth recording, but it is proof of identity:
       only the Web RCS client sends it, once a second, on its own socket. */
    if (raw === PING || raw === PONG) {
      if (!hook.appSocket && dir === 'out') { hook.appSocket = socket; adopt(socket); }
      return;
    }
    if (!looksAW(raw)) return;
    if (!hook.appSocket) { hook.appSocket = socket; adopt(socket); }
    if (!hook.detected) {
      hook.detected = true;
      window.dispatchEvent(new CustomEvent('wru:detected'));
    }

    const frame = { seq: ++hook.seq, dir, raw };
    hook.ring.push(frame);
    if (hook.ring.length > RING_MAX) hook.ring.splice(0, hook.ring.length - RING_MAX);
    for (const fn of hook.listeners) {
      try { fn(frame); } catch (err) { console.error('[wru] listener threw', err); }
    }
  }

  /** Subscribe to frames. Returns an unsubscribe function. */
  hook.on = (fn) => { hook.listeners.add(fn); return () => hook.listeners.delete(fn); };

  /** Every frame at or after `fromSeq`, for catching up after a snapshot fetch. */
  hook.since = (fromSeq) => hook.ring.filter((f) => f.seq >= fromSeq);

  /**
   * Send a frame on the app's own socket.
   *
   * Using the page's existing connection rather than opening our own is not an
   * optimisation — the device counts clients, and a second connection would
   * show up in the Web RCS client list and in the AWJ five-client budget.
   */
  hook.send = (raw) => {
    const s = hook.appSocket;
    if (!s || s.readyState !== 1 /* OPEN */) return false;
    nativeSend.call(s, raw);
    record('out', raw, s);
    return true;
  };

  const Native = window.WebSocket;
  const nativeSend = Native.prototype.send;

  const Patched = new Proxy(Native, {
    construct(target, args) {
      const socket = new target(...args);
      adopt(socket);
      return socket;
    }
  });

  /* Patch send on the prototype rather than per instance so we also catch
     frames the app sends before we have identified which socket is its own. */
  Native.prototype.send = function (data) {
    try { record('out', data, this); } catch (_) { /* never break the host app */ }
    return nativeSend.apply(this, arguments);
  };

  window.WebSocket = Patched;
  window.__WRU_HOOK = hook;
})();
