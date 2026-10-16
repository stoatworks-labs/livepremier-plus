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

  /*
   * The outbound gate: one function, installed later by a plugin, that may
   * HOLD an outbound Analog Way frame for a moment before it leaves — the
   * layer lock's way of getting preview into line before a TAKE, whoever
   * pressed it. `gate(raw, release)` returns true to hold and calls
   * `release()` when done; anything else sends the frame at once, as a
   * throwing gate does.
   *
   * ⚠️ A held frame is never lost. `release` sends it at most once, and this
   * file sends it itself after GATE_MAX_MS whatever the gate did — a bug in a
   * plugin may delay a take, never swallow one. It is the only place in this
   * app that stands between the vendor's own UI and its socket, so the cap
   * lives here rather than in the plugin that asked for it.
   */
  const GATE_MAX_MS = 750;
  hook.gate = null;
  hook.setGate = (fn) => {
    hook.gate = typeof fn === 'function' ? fn : null;
    return () => { if (hook.gate === fn) hook.gate = null; };
  };

  function gated(raw, socket) {
    const gate = hook.gate;
    if (!gate || !looksAW(raw)) return false;
    let sent = false;
    const release = () => {
      if (sent) return;
      sent = true;
      if (socket.readyState !== 1 /* OPEN */) return;
      nativeSend.call(socket, raw);
      try { record('out', raw, socket); } catch (_) { /* never break the host app */ }
    };
    let held = false;
    try { held = gate(raw, release) === true; } catch (err) { console.error('[wru] gate threw', err); }
    if (!held) return false;
    setTimeout(release, GATE_MAX_MS);
    return true;
  }

  /*
   * The outbound shaper: one object, installed later by a plugin, that may
   * REWRITE frames before they leave — Surfaces' way of keeping a layer
   * inside its LED element whichever control moved it, the vendor's drag and
   * toolbar included. `shaper.wants(raw)` says whether a frame is one it
   * shapes; those are held until the end of the current task and handed to
   * `shaper.shape(raws)` together, so it sees a whole drag step (four
   * geometry writes) at once, and what it returns goes out in their place.
   *
   * ⚠️ Order is the point, and nothing else is delayed. A frame it does not
   * want flushes the held run first and then goes out exactly as before —
   * synchronously, so the preview lock and the cue engine, which rely on an
   * outbound frame being seen inside `send()`, see what they always saw. A
   * held run waits one microtask at most, never a timer. A shaper that
   * throws, or answers anything but an array at least as long as the run,
   * has the run sent as it came: it may change and add frames, never drop
   * one. Shaped frames then pass the gate like any other.
   *
   * Like the gate, there is one shaper, not a list.
   */
  hook.shaper = null;
  let held = [];
  let heldOn = null;
  const later = typeof queueMicrotask === 'function' ? queueMicrotask : (fn) => Promise.resolve().then(fn);

  hook.setShaper = (s) => {
    flush();
    hook.shaper = s && typeof s.wants === 'function' && typeof s.shape === 'function' ? s : null;
    return () => { if (hook.shaper === s) { flush(); hook.shaper = null; } };
  };

  /** Hold a frame for the shaper. True if it was taken. */
  function shapeable(raw, socket) {
    const shaper = hook.shaper;
    if (!shaper || !looksAW(raw)) return false;
    let wants = false;
    try { wants = shaper.wants(raw) === true; } catch (err) { console.error('[wru] shaper threw', err); }
    if (!wants) return false;
    if (held.length && heldOn !== socket) flush();
    if (!held.length) later(flush);
    held.push(raw);
    heldOn = socket;
    return true;
  }

  /** Send the held run, shaped, in order. */
  function flush() {
    if (!held.length) return;
    const raws = held;
    const socket = heldOn;
    held = [];
    heldOn = null;
    let out = raws;
    try {
      const shaped = hook.shaper ? hook.shaper.shape(raws.slice()) : null;
      if (Array.isArray(shaped) && shaped.length >= raws.length && shaped.every((r) => typeof r === 'string')) out = shaped;
    } catch (err) { console.error('[wru] shaper threw', err); }
    for (const raw of out) {
      if (gated(raw, socket) || socket.readyState !== 1 /* OPEN */) continue;
      nativeSend.call(socket, raw);
      try { record('out', raw, socket); } catch (_) { /* never break the host app */ }
    }
  }

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
    if (shapeable(raw, s)) return true;
    if (held.length) flush();
    if (gated(raw, s)) return true;
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
    try { if (shapeable(data, this)) return undefined; } catch (_) { /* never break the host app */ }
    try { if (held.length) flush(); } catch (_) { /* never break the host app */ }
    try { if (gated(data, this)) return undefined; } catch (_) { /* never break the host app */ }
    try { record('out', data, this); } catch (_) { /* never break the host app */ }
    return nativeSend.apply(this, arguments);
  };

  window.WebSocket = Patched;
  window.__WRU_HOOK = hook;
})();
