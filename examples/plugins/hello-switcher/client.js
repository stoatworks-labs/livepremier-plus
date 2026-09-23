/*
 * Hello, switcher — the page half of an example plugin.
 *
 * A page in the sidebar that greets the switcher, shows the server's clock as
 * it streams and counts the frames the switcher sends; and a card in this
 * app's settings to change the greeting. Everything is drawn with `ctx.kit`,
 * so it looks like the rest of the app, and reached through `ctx`, so it does
 * not depend on where the app keeps its own files.
 */

export default function activate(ctx) {
  const { h, panel, sectionTitle, readout, card, note, button } = ctx.kit;

  let hello = null;
  let clock = '—';
  let frames = 0;
  let said = null;

  /* A new kind of thing a cue can do: say something on this page. Add one to a
     cue as {"kind": "hello-switcher:say", "text": "…"} — it runs when the cue
     fires, before any take in the same cue. */
  ctx.contribute('cueAction', {
    kind: 'hello-switcher:say',
    label: 'Say something',
    run: (action) => { said = String(action.text ?? ''); ctx.refresh(); },
    describe: (action) => `say “${action.text ?? ''}”`
  });
  let stream = null;
  let asked = false;

  /* The live store mirror is `ctx.session`: every write the switcher makes
     arrives as a `frame` event. */
  ctx.session.addEventListener('frame', () => { frames += 1; });

  async function load() {
    try {
      const res = await fetch(ctx.url('/hello'), { cache: 'no-store' });
      if (res.ok) hello = await res.json();
    } catch { /* drawn without it */ }
    ctx.refresh();
  }

  function listen() {
    if (stream) return;
    stream = new EventSource(ctx.url('/ticks'));
    stream.addEventListener('tick', (ev) => {
      clock = new Date(JSON.parse(ev.data).at).toLocaleTimeString();
      ctx.refresh();
    });
  }

  function page() {
    if (!asked) { asked = true; void load(); }
    listen();
    return panel({
      toolbar: sectionTitle('Hello, switcher'),
      body: h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        h('div', { class: 'aw-font-subtitle-1', text: `${ctx.settings.get().greeting}, ${hello && hello.switcher ? hello.switcher : 'switcher'}.` }),
        h('div', { class: 'aw-flex-row aw-gap-col-extra-large aw-flex-wrap' },
          readout('Server clock', clock),
          readout('Frames from the switcher', String(frames)),
          readout('Platform', ctx.platform().name || 'not known yet'),
          readout('A cue said', said ?? '—'),
          /* Another plugin's service — the Timeline's cue stack. null when the
             Timeline is switched off, so always ask, and always check. */
          readout('Standby cue', standby())),
        note(null, 'An example plugin. Change the greeting in Preconfig ▸ LivePremier Plus.'),
        button('Say hello again', { onClick: () => { asked = false; ctx.refresh(); } }))
    });
  }

  function standby() {
    const stack = ctx.use('stack');
    if (!stack) return 'no Timeline';
    const cue = stack.standby;
    return cue ? [cue.number, cue.label].filter(Boolean).join(' ') || 'unnamed' : 'end of the stack';
  }

  function settingsCard() {
    return card('Hello, switcher',
      h('div', { class: 'aw-flex-col aw-gap-row-mini' },
        h('div', { class: 'aw-font-overline aw-text-tertiary', text: 'Greeting' }),
        h('input', {
          class: 'wru-input', type: 'text', value: ctx.settings.get().greeting, style: { maxWidth: '16rem' },
          /* Saved on blur rather than per keystroke. */
          onBlur: async (ev) => {
            if (ev.target.value === ctx.settings.get().greeting) return;
            await ctx.settings.set({ greeting: ev.target.value });
            asked = false;
            ctx.refresh();
          },
          onKeyDown: (ev) => { if (ev.key === 'Enter') ev.target.blur(); }
        })),
      note(null, 'Settings a plugin keeps are its own, and survive it being switched off.'));
  }

  ctx.ui.sidebar({ id: 'hello-switcher', label: 'Hello', icon: ['properties-18', 'layer-stacked-18'], order: 100, render: page });
  ctx.ui.settingsSection({ id: 'hello-switcher', order: 100, render: settingsCard });
}
