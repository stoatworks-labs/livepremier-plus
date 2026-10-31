/*
 * Slow-link thumbnails: a source thumbnail keeps its picture until the next
 * has arrived, so a page a thin link away from this app draws them.
 *
 * The browser here is a stand-in with the one behaviour that matters: an
 * image has one load at a time, and a new `src` drops the load on its way.
 * The real case it stands in for is a tablet over Remote access; the browser
 * check through a 400 KB/s relay is in docs/NOTES.md (2026-10-31).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installThumbnailHold, heldPath, HELD_SNAPSHOT, GIVE_UP_MS } from '../plugins/thumbnail-hold/hold.js';
import { KEPT_SNAPSHOT } from '../server/snapshot-keeper.js';
import { bump } from '../plugins/snapshot-relay/hot.js';

const input = (n, tick) => `/api/device/snapshots/inputs/${n}?${tick}`;

/**
 * Just enough browser: elements with attributes, an `<img>` whose `complete`
 * is false while a load is on its way, a `src` accessor of its own as
 * `HTMLImageElement.prototype` has, and `load`/`error` heard at the document.
 */
function browser() {
  const listeners = { load: new Set(), error: new Set() };
  const doc = {
    addEventListener(type, fn, capture) { assert.equal(capture, true, 'heard at capture'); listeners[type].add(fn); },
    removeEventListener(type, fn) { listeners[type].delete(fn); }
  };
  const dropped = [];
  const fire = (type, img) => { for (const fn of listeners[type]) fn({ type, target: img }); };

  class Element {
    constructor() { this.attrs = new Map(); }
    setAttribute(name, value) {
      this.attrs.set(name.toLowerCase(), String(value));
      if (name.toLowerCase() === 'src') this.started(String(value));
    }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    started() {}
  }
  class Img extends Element {
    constructor() { super(); this.loading = null; this.drawn = null; this.frames = 0; }
    get complete() { return !this.loading; }
    /** The browser asks for `url`, dropping whatever was on its way. */
    started(url) {
      if (this.loading) dropped.push(this.loading);
      this.loading = url || null;
    }
    /** The load on its way lands. */
    finish() {
      assert.ok(this.loading, 'something was loading');
      this.drawn = this.loading;
      this.loading = null;
      this.frames += 1;
      fire('load', this);
    }
    fail() {
      this.loading = null;
      fire('error', this);
    }
  }
  /* The real accessor sets the attribute without going through setAttribute. */
  Object.defineProperty(Img.prototype, 'src', {
    configurable: true,
    enumerable: true,
    get() { return this.getAttribute('src') || ''; },
    set(v) { Element.prototype.setAttribute.call(this, 'src', v); }
  });
  return { doc, Img, Element, dropped, listeners };
}

function setup({ giveUpMs } = {}) {
  const b = browser();
  let t = 0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const hold = installThumbnailHold({ proto: b.Img.prototype, doc: b.doc, now: clock.now, ...(giveUpMs ? { giveUpMs } : {}) });
  return { ...b, hold, clock };
}

test('only the thumbnails the vendor polls wait — the keeper’s list, never a still or a library image', () => {
  assert.equal(HELD_SNAPSHOT.source, KEPT_SNAPSHOT.source, 'the same four kinds the keeper answers in time');
  for (const p of ['inputs/1', 'outputs/12', 'multiviewers/2', 'timers/4']) {
    assert.equal(heldPath(`/api/device/snapshots/${p}?1730000000000`), `/api/device/snapshots/${p}`, p);
  }
  for (const src of ['/api/device/snapshots/images/3?1', '/api/device/snapshots/images_library/7?1',
    '/api/device/images/download/2?v=abc', 'blob:http://127.0.0.1:8535/5d1e', '/logo.png', '', null]) {
    assert.equal(heldPath(src), null, String(src));
  }
});

test('a new URL for a picture still loading waits, the last picture stays, and the newest goes in when it lands', () => {
  const { Img, hold, dropped } = setup();
  const img = new Img();
  img.setAttribute('src', input(3, 1000));
  assert.equal(img.loading, input(3, 1000));

  img.setAttribute('src', input(3, 2000));
  img.src = input(3, 3000);
  /* The hot tracker's refresh is one more URL like the vendor's. */
  img.setAttribute('src', bump(img.getAttribute('src'), 3500));
  assert.equal(img.loading, input(3, 1000), 'the load on its way is not dropped');
  assert.equal(img.getAttribute('src'), input(3, 1000), 'what anybody reads still names input 3');
  assert.equal(hold.pending(img), input(3, 3500));

  img.finish();
  assert.equal(img.drawn, input(3, 1000), 'drawn, not cut off');
  assert.equal(img.loading, input(3, 3500), 'the newest URL went in, not the first held');
  assert.equal(hold.pending(img), null);
  img.finish();
  assert.equal(img.frames, 2);
  assert.deepEqual(dropped, [], 'no load was dropped');
  assert.deepEqual(hold.stats(), { held: 1, superseded: 2, released: 1, gaveUp: 0 });
});

test('on a LAN every URL goes in the moment it is set', () => {
  const { Img, hold } = setup();
  const img = new Img();
  for (let tick = 1000; tick <= 5000; tick += 1000) {
    img.setAttribute('src', input(1, tick));
    assert.equal(img.loading, input(1, tick), `${tick} went in`);
    img.finish();
  }
  assert.equal(img.frames, 5);
  assert.deepEqual(hold.stats(), { held: 0, superseded: 0, released: 0, gaveUp: 0 });
});

test('a card pointed at another source, a still or a library image goes straight in and drops what was held', () => {
  const { Img, hold } = setup();
  const img = new Img();
  img.setAttribute('src', input(3, 1000));
  img.setAttribute('src', input(3, 2000));
  assert.equal(hold.pending(img), input(3, 2000));

  img.setAttribute('src', input(4, 2100));
  assert.equal(img.loading, input(4, 2100), 'another source is another picture: never kept behind the old one');
  assert.equal(hold.pending(img), null, 'input 3’s URL can no longer land on input 4’s card');
  img.finish();
  assert.equal(img.drawn, input(4, 2100));

  const still = new Img();
  still.setAttribute('src', '/api/device/snapshots/images/2?1');
  still.setAttribute('src', '/api/device/snapshots/images/2?2');
  assert.equal(still.loading, '/api/device/snapshots/images/2?2');
  const library = new Img();
  library.setAttribute('src', '/api/device/snapshots/images_library/5?1');
  library.setAttribute('src', '/api/device/snapshots/images_library/5?2');
  assert.equal(library.loading, '/api/device/snapshots/images_library/5?2');
  assert.equal(hold.stats().held, 1);
});

test('Multiviewer thumbnails’ crop goes straight in and is never written over by a held URL', () => {
  const { Img, hold } = setup();
  const img = new Img();
  img.setAttribute('src', input(2, 1000));
  img.setAttribute('src', input(2, 2000));
  img.setAttribute('src', 'blob:http://127.0.0.1:8535/crop-1');
  assert.equal(img.loading, 'blob:http://127.0.0.1:8535/crop-1');
  img.finish();
  assert.equal(img.drawn, 'blob:http://127.0.0.1:8535/crop-1', 'the crop, not input 2’s held URL');
  assert.equal(hold.pending(img), null);
  /* The vendor's next URL goes in as it did before this plugin, for the
     slicer's own observer to take back. */
  img.setAttribute('src', 'blob:http://127.0.0.1:8535/crop-2');
  img.setAttribute('src', input(2, 3000));
  assert.equal(img.loading, input(2, 3000));
});

test('a failed load ends the wait like a finished one', () => {
  const { Img } = setup();
  const img = new Img();
  img.setAttribute('src', input(5, 1000));
  img.setAttribute('src', input(5, 2000));
  img.fail();
  assert.equal(img.loading, input(5, 2000), 'the next URL is asked for');
});

test('a load that has stopped is given up on at the next URL, and the one after waits again', () => {
  const { Img, hold, clock, dropped } = setup();
  const img = new Img();
  img.setAttribute('src', input(6, 0));
  clock.advance(1000);
  img.setAttribute('src', input(6, 1000));
  clock.advance(GIVE_UP_MS);
  img.setAttribute('src', input(6, 31000));
  assert.equal(img.loading, input(6, 31000), 'past giveUpMs the vendor’s URL goes in');
  assert.deepEqual(dropped, [input(6, 0)]);
  assert.equal(hold.pending(img), null);
  clock.advance(1000);
  img.setAttribute('src', input(6, 32000));
  assert.equal(img.loading, input(6, 31000), 'the new load is waited for from the start');
  assert.equal(hold.stats().gaveUp, 1);
});

test('an image already loading when the hold starts is held too', () => {
  const b = browser();
  const img = new b.Img();
  img.setAttribute('src', input(7, 1000));
  const hold = installThumbnailHold({ proto: b.Img.prototype, doc: b.doc, now: () => 0 });
  img.setAttribute('src', input(7, 2000));
  assert.equal(img.loading, input(7, 1000));
  img.finish();
  assert.equal(img.loading, input(7, 2000));
  hold.stop();
});

test('other attributes and other elements are untouched; stop() puts the browser’s setters back', () => {
  const { Img, Element, hold, listeners } = setup();
  const img = new Img();
  img.setAttribute('alt', 'Input 1');
  assert.equal(img.getAttribute('alt'), 'Input 1');
  const div = new Element();
  div.setAttribute('src', input(1, 1));
  assert.equal(div.getAttribute('src'), input(1, 1));

  assert.ok(Object.hasOwn(Img.prototype, 'setAttribute'));
  hold.stop();
  assert.ok(!Object.hasOwn(Img.prototype, 'setAttribute'), 'the inherited one again');
  assert.equal(listeners.load.size + listeners.error.size, 0);
  img.setAttribute('src', input(1, 1000));
  img.setAttribute('src', input(1, 2000));
  assert.equal(img.loading, input(1, 2000), 'without the hold, the vendor’s cliff is back');
  img.src = input(1, 3000);
  assert.equal(img.loading, input(1, 3000));
});

/*
 * The page as a whole, over a modelled link: the vendor's `SnapshotManager`
 * asks for each input in turn, one every 1000/n ms (`MINIMUM_INTERVAL` 40),
 * and the link shares its bytes between the loads it carries, six
 * connections at a time, the rest queued, a round trip before each.
 */
function page({ hold, inputs = 8, bytes = 147_925, rate = 400_000, seconds = 30, rtt = 50, connections = 6 }) {
  const b = browser();
  let t = 0;
  const h = hold ? installThumbnailHold({ proto: b.Img.prototype, doc: b.doc, now: () => t }) : null;
  const imgs = Array.from({ length: inputs }, () => new b.Img());
  /* img → the load on its way, in the order asked for. */
  const queue = [];
  let asked = 0;
  for (const img of imgs) {
    const started = img.started.bind(img);
    img.started = (url) => {
      started(url);
      const i = queue.findIndex((q) => q.img === img);
      if (i >= 0) queue.splice(i, 1);
      if (url) queue.push({ img, wait: rtt, left: bytes });
      asked += 1;
    };
  }
  const interval = Math.max(Math.floor(1000 / inputs), 40);
  const dt = 5;
  let key = 0;
  for (; t < seconds * 1000; t += dt) {
    if (t % interval === 0) {
      imgs[key].setAttribute('src', input(key + 1, t));
      key = (key + 1) % inputs;
    }
    const carried = queue.slice(0, connections);
    const share = (rate * dt) / 1000 / Math.max(1, carried.filter((q) => q.wait <= 0).length);
    for (const q of carried) {
      if (q.wait > 0) { q.wait -= dt; continue; }
      q.left -= share;
    }
    for (const q of carried.filter((x) => x.wait <= 0 && x.left <= 0)) {
      queue.splice(queue.indexOf(q), 1);
      q.img.finish();
    }
  }
  if (h) h.stop();
  return { frames: imgs.map((img) => img.frames), dropped: b.dropped.length, asked, stats: h && h.stats() };
}

test('over 400 KB/s the vendor’s swap draws nothing; with the hold every input keeps coming', () => {
  const before = page({ hold: false });
  assert.deepEqual(before.frames, [0, 0, 0, 0, 0, 0, 0, 0], 'the cliff: every load cut off at a second');
  assert.ok(before.dropped > 200, `${before.dropped} loads dropped`);

  const after = page({ hold: true });
  const total = after.frames.reduce((a, n) => a + n, 0);
  /* The link carries 400 KB/s × 30 s / 148 KB ≈ 81 pictures. */
  assert.ok(total >= 70, `${total} frames drawn`);
  for (const [i, n] of after.frames.entries()) assert.ok(n >= 7, `input ${i + 1}: ${n} frames`);
  assert.equal(after.dropped, 0, 'no load was cut off');
});

test('on a LAN the page is exactly the vendor’s: every URL asked for and drawn, nothing held', () => {
  const lan = page({ hold: true, rate: 100_000_000 });
  assert.equal(lan.stats.held, 0);
  assert.equal(lan.dropped, 0);
  const total = lan.frames.reduce((a, n) => a + n, 0);
  assert.equal(total, lan.asked, 'every URL the vendor set was drawn');
  for (const n of lan.frames) assert.ok(n >= 29, `${n} frames in 30 s`);
});
