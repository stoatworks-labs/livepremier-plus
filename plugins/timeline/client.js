/*
 * The Timeline — the plugin's page half: the cue stack, and the tab that runs
 * it.
 *
 * On the Screens / Aux. strip, beside Properties and Memories — a per-screen
 * tool belongs where an operator already looks for per-screen tools — and it
 * pops out into a full cue editor (`popout.html`, `editor.js`).
 *
 * The engine is `src/core/cuestack.js`. It spells its writes for whichever
 * platform the store turns out to be, and asks at fire time, because the
 * store is empty when this runs and may be re-pointed at a different frame
 * mid-show. Anything the engine does not do itself is a plugin's `cueAction`
 * — Matrix Routing's two among them — asked for at fire time as well.
 *
 * It offers the rest of the page the **`stack` service**, a narrow face: what
 * a show needs from outside the stack is to move through it and to hear it
 * move, not to rewrite it. Its own cue editor window needs the stack itself,
 * so that goes through `ctx.share` instead. Timecode, when that plugin is on,
 * is asked for as it is drawn: `ctx.use('timecode')`.
 */

import { CueStack } from '../../src/core/cuestack.js';
import { commandsFor } from '../../src/core/commands.js';
import { dialectFor } from '../../src/core/dialect.js';
import { createTimelinePanel } from './panel.js';

/** The stack's file, through this plugin's own route. */
function documentAt(url, log) {
  return {
    async load() {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        return res.ok ? (await res.json()).data ?? null : null;
      } catch (err) {
        log.warn('could not load the cue stack', err);
        return null;
      }
    },
    async save(data) {
      try {
        await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
      } catch (err) {
        /* A failed save must not interrupt an operator mid-cue. The stack in
           this page carries on; the next edit retries. */
        log.warn('could not save the cue stack', err);
      }
    }
  };
}

export default async function activate(ctx) {
  const { session } = ctx;
  const cueActions = () => ctx.contributions('cueAction');

  const stack = new CueStack({
    send: (cmd) => session.send(cmd),
    commands: () => commandsFor(dialectFor(session.store)),
    actions: (kind) => cueActions().find((a) => a.kind === kind) || null
  });
  const storage = documentAt(ctx.url('/'), ctx.log);
  const saved = await storage.load();
  if (saved) stack.load(saved);

  const find = (id) => stack.cues.find((c) => c.id === id) || null;
  ctx.provide('stack', Object.freeze({
    go: () => stack.go(),
    back: () => stack.back(),
    stop: () => stack.stop(),
    gotoId: (id) => stack.gotoId(id),
    /** Fire one cue now, wherever the standby is — what a chase does. */
    fire: (id) => { const cue = find(id); if (cue) stack.fire(cue); return Boolean(cue); },
    get standby() { return stack.standby ? { ...stack.standby } : null; },
    cues: () => stack.cues.map((c) => ({ ...c, actions: c.actions.map((a) => ({ ...a })) })),
    addEventListener: (...a) => stack.addEventListener(...a),
    removeEventListener: (...a) => stack.removeEventListener(...a)
  }));

  const timecode = () => { const t = ctx.use('timecode'); return t ? t.source : null; };
  const chase = () => { const t = ctx.use('timecode'); return t ? t.chase : null; };
  const panel = createTimelinePanel({
    session, stack, storage, timecode, chase, onRefresh: ctx.refresh, cueActions
  });
  stack.addEventListener('changed', ctx.refresh);

  ctx.share({
    stack,
    save: () => storage.save(stack.toJSON()),
    timecode,
    chase,
    contributions: (point) => ctx.contributions(point)
  });

  ctx.ui.tab({
    id: 'timeline',
    label: 'Timeline',
    /* What the tab falls back to when the strip runs out of room. "Time"
       would read as neither one thing nor the other. */
    short: 'Cues',
    icon: 'timer-14',
    order: 20,
    render: () => panel.render()
  });
}
