/*
 * Companion's buttons, drawn by us.
 *
 * Until 0.13 the panel showed Companion's own Buttons, Web buttons and
 * Emulator pages in an iframe. They worked, and they looked like Companion
 * inside a LivePremier: another app's fonts, another app's chrome, a page
 * picker in somebody else's idiom, and a second scrollbar. What an operator
 * wants beside the switcher is the grid of buttons, in this app's look, that
 * they can press — and, for a cue or a memory trigger, point at.
 *
 * So this draws the grid itself and asks Companion only for what Companion
 * alone knows:
 *
 *  - **`pages.watch`** — the page list and names. Used as a doorbell past its
 *    first frame, exactly as the server's link uses `instances.connections.watch`:
 *    a later frame means "re-read", and its deltas are never parsed.
 *  - **`userConfig.watchConfig`** — for `gridSize` only, which is the page's
 *    shape and may start below 0/0 (see `pageGrid` in `core.js`).
 *  - **`preview.graphics.location`** — one subscription per button on the
 *    page being looked at, yielding `{ image, isUsed }`, the rendered PNG as a
 *    data URL each time the button repaints. This is how Companion's own
 *    emulator draws, so a button looks here exactly as it does on a Stream
 *    Deck: its feedbacks, its variables, its colours.
 *  - **`controls.hotPressControl`** — down on pointer-down, up on pointer-up,
 *    so a button with a long-press step or a "while held" action behaves as it
 *    would under a finger.
 *
 * ## Its own socket, on purpose
 *
 * Through the mount, `/__lpp/companion/ui/trpc`, on this page's origin —
 * `link.js` sets out why drawing buttons must not be funnelled through the
 * server's link: a stream of images relayed to a page that could have been
 * handed them directly, and still running with nothing on screen to want it.
 * One socket per page, shared by every grid in it (`sharedSocket`) and closed
 * a little after the last one lets go. Button subscriptions exist only for the
 * page being shown, and only while the grid is on screen: `pause()` ends them.
 *
 * Nothing here imports the app's DOM helpers by path. The panel hands in
 * `ctx.kit`, so the grid is drawn in the app's own idiom and can be put into
 * a popped-out window's document as easily as the sidebar's.
 */

import { gridAxes, locationKey, parseFrames, request, stopRequest } from './core.js';

/** The surface a press is reported as, in Companion's log and its surface variables. */
export const SURFACE_ID = 'livepremier-plus';

const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;
const CALL_TIMEOUT_MS = 8000;
/* How long a socket nobody is using stays open. Long enough that switching
   to another panel and straight back does not redial and redraw every
   button; short enough that it is not held open all show for a panel looked
   at once. */
const IDLE_CLOSE_MS = 20000;

/**
 * One tRPC WebSocket to Companion, from the page, that heals itself.
 *
 * Subscriptions survive a reconnect: each is kept here with its input and
 * re-sent under a fresh id when the socket comes back, so a grid does not
 * have to know the socket ever went away.
 */
export class CompanionSocket extends EventTarget {
  /** @param {string} url  ws:// or wss:// — see `socketUrlFor` */
  constructor(url, { WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.url = url;
    this.WebSocket = WebSocketImpl;
    this.ws = null;
    this.open = false;
    this.nextId = 0;
    this.retry = null;
    this.retryMs = RETRY_MIN_MS;
    this.stopped = true;
    /** wire id -> { resolve, reject, timer } for queries and mutations */
    this.calls = new Map();
    /** handle -> { path, input, onValue, wireId } for subscriptions */
    this.subs = new Map();
    this.nextHandle = 0;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#dial();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    this.#closed();
    if (ws) { try { ws.close(); } catch { /* already gone */ } }
  }

  #dial() {
    if (this.stopped || this.ws) return;
    let ws;
    try { ws = new this.WebSocket(this.url); } catch { this.#retry(); return; }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      this.retryMs = RETRY_MIN_MS;
      for (const sub of this.subs.values()) this.#sendSub(sub);
      this.#emit();
    };
    ws.onmessage = (ev) => this.#onMessage(ws, ev.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.#closed();
      this.#retry();
    };
    ws.onerror = () => { /* onclose follows, and says the same thing */ };
  }

  #closed() {
    const was = this.open;
    this.open = false;
    for (const [id, c] of this.calls) {
      clearTimeout(c.timer);
      c.reject(new Error('the Companion socket closed'));
      this.calls.delete(id);
    }
    for (const sub of this.subs.values()) sub.wireId = null;
    if (was) this.#emit();
  }

  #retry() {
    if (this.stopped || this.retry) return;
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
    this.retry = setTimeout(() => { this.retry = null; this.#dial(); }, wait);
  }

  #emit() { this.dispatchEvent(new CustomEvent('state', { detail: { open: this.open } })); }

  #onMessage(ws, text) {
    /* tRPC's own keep-alive, not WebSocket's — `link.js` has the story. The
       browser answers protocol pings by itself; this one it does not. */
    if (text === 'PING') { try { ws.send('PONG'); } catch { /* closing */ } return; }
    for (const frame of parseFrames(text)) {
      const call = this.calls.get(frame.id);
      if (call) {
        if (frame.kind !== 'data' && frame.kind !== 'error') continue;
        clearTimeout(call.timer);
        this.calls.delete(frame.id);
        if (frame.kind === 'error') call.reject(new Error(frame.error));
        else call.resolve(frame.data);
        continue;
      }
      for (const sub of this.subs.values()) {
        if (sub.wireId !== frame.id) continue;
        if (frame.kind === 'data') { try { sub.onValue(frame.data); } catch (err) { console.warn('[companion]', err); } }
        else if (frame.kind === 'error') { sub.onError?.(new Error(frame.error)); }
      }
    }
  }

  #send(frame) {
    if (!this.ws || !this.open) return false;
    try { this.ws.send(JSON.stringify(frame)); return true; } catch { return false; }
  }

  #sendSub(sub) {
    sub.wireId = ++this.nextId;
    this.#send(request(sub.wireId, 'subscription', sub.path, sub.input));
  }

  /** One query or mutation. Rejects rather than hangs when the socket is down. */
  call(method, path, input) {
    if (!this.open) return Promise.reject(new Error('not connected to Companion'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`Companion did not answer ${path}`));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      if (!this.#send(request(id, method, path, input))) {
        clearTimeout(timer);
        this.calls.delete(id);
        reject(new Error('not connected to Companion'));
      }
    });
  }

  /**
   * A subscription that outlives reconnects. Returns the function that ends it.
   * `onValue` sees every data frame, the first of which is the current value.
   */
  subscribe(path, input, onValue, onError) {
    const handle = ++this.nextHandle;
    const sub = { path, input, onValue, onError, wireId: null };
    this.subs.set(handle, sub);
    if (this.open) this.#sendSub(sub);
    return () => {
      if (!this.subs.delete(handle)) return;
      if (sub.wireId != null) this.#send(stopRequest(sub.wireId));
    };
  }
}

/**
 * The socket address for the mount at `uiPath` on the page's own origin —
 * resolved against the document's base rather than `location`, which is
 * `about:blank` or `about:srcdoc` in a window a script wrote itself.
 */
export function socketUrlFor(uiPath, base = (globalThis.document && globalThis.document.baseURI)
  || (globalThis.location && globalThis.location.href)) {
  const url = new URL(uiPath.replace(/\/+$/, '') + '/trpc', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

/* One socket per page, counted. */
const shared = new Map();

/**
 * Borrow the page's socket to the Companion at `uiPath`. Returns
 * `{ socket, release }`; the socket closes `IDLE_CLOSE_MS` after the last
 * borrower lets go, unless somebody borrows it again first.
 */
export function sharedSocket(uiPath) {
  const url = socketUrlFor(uiPath);
  let entry = shared.get(url);
  if (!entry) {
    entry = { socket: new CompanionSocket(url), users: 0, idle: null };
    shared.set(url, entry);
  }
  clearTimeout(entry.idle);
  entry.users++;
  entry.socket.start();
  let released = false;
  return {
    socket: entry.socket,
    release() {
      if (released) return;
      released = true;
      entry.users--;
      if (entry.users > 0) return;
      entry.idle = setTimeout(() => {
        if (entry.users > 0) return;
        entry.socket.stop();
        shared.delete(url);
      }, IDLE_CLOSE_MS);
    },
  };
}

/* ---------------------------------------------------------------- the grid */

/**
 * The pages, the grid shape, and every button on one page, live.
 *
 * @param {object} o
 * @param {object} o.kit           the app's DOM helpers — `ctx.kit`
 * @param {string} o.ui            the mount, `ctx.url('/ui')`
 * @param {'press'|'pick'} [o.mode]  press buttons, or choose one — a picker
 *        for a cue or a memory trigger presses nothing
 * @param {(loc: object) => void} [o.onPick]
 * @param {number} [o.page]        the page to open on
 * @param {Set<string>} [o.marked] location keys drawn as chosen, in a picker
 * @param {(msg: string) => void} [o.onError]  a press Companion refused
 */
export function createButtonGrid({ kit, ui, mode = 'press', onPick, page = 1, marked, onError }) {
  const { h, button } = kit;
  const { socket, release } = sharedSocket(ui);

  const state = {
    page,
    order: [],        // page ids, in page-number order
    pages: {},        // id -> { name }
    grid: null,       // Companion's gridSize, once read
    running: false,
    disposed: false,
  };

  /* The frame, built once. The tiles are rebuilt only when the page or the
     grid's shape changes; a repaint of a button only swaps its image. */
  const status = h('span', { class: 'aw-font-caption aw-text-tertiary' });
  const picker = h('select', {
    class: 'wru-input',
    title: 'Companion page',
    onChange: (ev) => setPage(Number(ev.target.value)),
  });
  const prev = button('‹', { variant: 'ghost', title: 'Previous page', onClick: () => step(-1) });
  const next = button('›', { variant: 'ghost', title: 'Next page', onClick: () => step(+1) });
  const tiles = h('div', {
    class: 'lpp-companion-grid',
    style: { display: 'grid', gap: '0.375rem', width: '100%', userSelect: 'none', touchAction: 'manipulation' },
  });
  const el = h('div', { class: 'aw-flex-col aw-gap-row-small' },
    h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' }, prev, picker, next, h('div', { style: { flex: '1' } }), status),
    tiles);

  /** location key -> { img, tile, stop } for the page on screen */
  let live = new Map();
  let stops = [];

  const pageCount = () => state.order.length || 1;

  function step(delta) {
    const n = ((state.page - 1 + delta + pageCount()) % pageCount()) + 1;
    setPage(n);
  }

  function setPage(n) {
    if (!Number.isInteger(n) || n < 1) return;
    if (n === state.page && live.size) return;
    state.page = n;
    drawPicker();
    if (state.running) drawTiles();
  }

  function drawPicker() {
    picker.textContent = '';
    const count = Math.max(pageCount(), state.page);
    for (let n = 1; n <= count; n++) {
      const id = state.order[n - 1];
      const name = id && state.pages[id] && state.pages[id].name;
      const opt = h('option', { value: String(n), text: name && name !== 'PAGE' ? `${n} · ${name}` : `Page ${n}` });
      if (n === state.page) opt.selected = true;
      picker.append(opt);
    }
  }

  function drawStatus() {
    status.textContent = socket.open ? '' : 'connecting to Companion…';
  }

  function endTiles() {
    for (const t of live.values()) t.stop();
    live = new Map();
  }

  function drawTiles() {
    endTiles();
    tiles.textContent = '';
    const { rows, columns } = gridAxes(state.grid || {});
    tiles.style.gridTemplateColumns = `repeat(${columns.length}, minmax(0, 1fr))`;
    for (const row of rows) {
      for (const column of columns) tiles.append(tile({ pageNumber: state.page, row, column }));
    }
  }

  function tile(location) {
    const key = locationKey(location);
    const chosen = marked && marked.has(key);
    const img = h('img', {
      alt: '',
      draggable: 'false',
      style: { width: '100%', height: '100%', display: 'block', borderRadius: '0.25rem', pointerEvents: 'none' },
    });
    const node = h('div', {
      title: `${key}${mode === 'pick' ? ' — choose this button' : ''}`,
      style: {
        aspectRatio: '1 / 1',
        background: '#000',
        borderRadius: '0.3rem',
        cursor: 'pointer',
        opacity: '0.35',
        transition: 'transform 60ms ease-out, opacity 120ms',
        outline: chosen ? '2px solid var(--aw-color-primary, #2f9bff)' : 'none',
        outlineOffset: '2px',
        overflow: 'hidden',
      },
    }, img);

    let held = false;
    const up = () => {
      if (!held) return;
      held = false;
      node.style.transform = '';
      if (mode === 'press') hot(location, false);
    };
    node.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      ev.preventDefault();
      if (mode === 'pick') { if (onPick) onPick(location); return; }
      held = true;
      node.style.transform = 'scale(0.94)';
      try { node.setPointerCapture(ev.pointerId); } catch { /* not supported */ }
      hot(location, true);
    });
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('lostpointercapture', up);

    const stop = socket.subscribe('preview.graphics.location', { location }, (value) => {
      /* The first frame and every repaint are the same shape — `WrappedImage`
         in Companion's model. A button with no control on it still gets an
         image (a placeholder with its number), which is what makes an empty
         slot findable in a picker. */
      const image = value && typeof value === 'object' ? value.image : value;
      if (typeof image === 'string' && image) img.src = image;
      node.style.opacity = value && value.isUsed ? '1' : '0.35';
    });
    live.set(key, { img, node, stop });
    return node;
  }

  function hot(location, down) {
    socket.call('mutation', 'controls.hotPressControl', { location, direction: down, surfaceId: SURFACE_ID })
      .catch((err) => { if (onError) onError(`Companion did not take the press: ${err.message}`); });
  }

  function watch() {
    /* Past the first frame each is only a doorbell: ask again for the whole. */
    const pagesSub = () => socket.subscribe('pages.watch', undefined, (value) => {
      if (value && value.type === 'init') {
        state.order = Array.isArray(value.order) ? value.order : [];
        state.pages = value.pages && typeof value.pages === 'object' ? value.pages : {};
        if (state.page > pageCount()) state.page = 1;
        drawPicker();
      } else {
        stopPages();
        stopPages = pagesSub();
      }
    });
    let stopPages = pagesSub();

    const stopConfig = socket.subscribe('userConfig.watchConfig', undefined, (value) => {
      let size = null;
      if (value && value.type === 'init' && value.config) size = value.config.gridSize;
      else if (value && value.type === 'key' && value.key === 'gridSize') size = value.value;
      if (!size) return;
      const changed = JSON.stringify(size) !== JSON.stringify(state.grid);
      state.grid = size;
      if (changed && state.running) drawTiles();
    });

    const onState = () => drawStatus();
    socket.addEventListener('state', onState);
    stops = [() => stopPages(), stopConfig, () => socket.removeEventListener('state', onState)];
  }

  /** Start drawing: subscribe to the page list, the grid shape and the buttons. */
  function resume() {
    if (state.running || state.disposed) return;
    state.running = true;
    watch();
    drawStatus();
    drawPicker();
    drawTiles();
  }

  /** Stop every subscription but keep the frame, for a grid that is off screen. */
  function pause() {
    if (!state.running) return;
    state.running = false;
    endTiles();
    for (const s of stops) s();
    stops = [];
  }

  function dispose() {
    if (state.disposed) return;
    pause();
    state.disposed = true;
    release();
  }

  resume();

  return {
    el,
    setPage,
    get page() { return state.page; },
    pause,
    resume,
    dispose,
    get running() { return state.running; },
  };
}

/**
 * A chooser over the grid, as a dialog in `doc` — the page's own document or
 * a popped-out window's. Resolves with the location picked, or null.
 */
export function pickButton({ kit, ui, doc = document, page = 1, current = [], title = 'Choose a Companion button' }) {
  const { h, button } = kit;
  return new Promise((resolve) => {
    const marked = new Set(current.map(locationKey));
    let grid = null;
    const done = (value) => {
      if (grid) grid.dispose();
      doc.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); done(null); } };

    grid = createButtonGrid({ kit, ui, mode: 'pick', page, marked, onPick: (loc) => done(loc) });
    const box = h('div', {
      class: 'aw-flex-col aw-gap-row-medium aw-padding-large aw-background-slate-grey-900 aw-border-radius',
      style: { width: 'min(46rem, 94vw)', maxHeight: '90vh', overflow: 'auto', boxShadow: '0 1rem 3rem rgba(0,0,0,0.6)' },
    },
    h('div', { class: 'aw-flex-row-center-v aw-gap-col-small' },
      h('span', { class: 'aw-font-subtitle-1', text: title }),
      h('div', { style: { flex: '1' } }),
      button('Cancel', { variant: 'ghost', onClick: () => done(null) })),
    grid.el,
    h('div', { class: 'aw-font-caption aw-text-tertiary', text:
      'Click a button to choose it. Nothing is pressed while choosing. Dim buttons have nothing on them yet.' }));

    const overlay = h('div', {
      style: {
        position: 'fixed', inset: '0', zIndex: '10000', display: 'flex',
        alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.55)',
      },
      onPointerdown: (ev) => { if (ev.target === overlay) done(null); },
    }, box);
    doc.addEventListener('keydown', onKey, true);
    doc.body.append(overlay);
  });
}
