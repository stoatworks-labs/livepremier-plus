/*
 * Device host — the plugin's page half: a card on the settings page saying
 * whether the device host is running and what each of its modules has found.
 * Each device's own controls are on its own page; the Speed Editor's is under
 * Virtual RC400T.
 */

const POLL_MS = 3000;

export function hostLine(d) {
  if (!d.installed) return d.reason || 'Not installed.';
  if (!d.running) return d.reason || 'Stopped.';
  if (d.available === false) return `Running, but without USB access: ${d.reason}`;
  const restarts = d.restarts ? ` · restarted ${d.restarts} time${d.restarts === 1 ? '' : 's'}` : '';
  return `Running${restarts}.`;
}

export function moduleLine(m) {
  const s = m.state;
  if (!s) return 'not started';
  if (s.connected) return s.authed === false ? 'open, waiting for its handshake' : `in use${s.battery ? ` · battery ${s.battery.level}%` : ''}`;
  if (s.present) return 'found, not in use';
  return 'not plugged in';
}

export default function activate(ctx) {
  const { h, button, card, note } = ctx.kit;
  let data = null;
  let error = null;
  let polledAt = 0;
  let restarting = false;

  async function load() {
    polledAt = Date.now();
    try {
      const res = await fetch(ctx.url('/'), { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
      error = null;
    } catch (err) {
      error = `Could not reach LivePremier Plus: ${err.message}`;
    }
    ctx.refresh();
  }

  async function restart() {
    restarting = true;
    ctx.refresh();
    try { await fetch(ctx.url('/restart'), { method: 'POST' }); } catch { /* the next poll says */ }
    restarting = false;
    setTimeout(load, 1500);
  }

  function render() {
    if (Date.now() - polledAt > POLL_MS) void load();
    const d = data;
    const body = [];
    if (error) body.push(note('warn', error));
    if (!d) {
      body.push(note('info', 'Asking the app…'));
    } else {
      body.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
        h('span', { class: ['wru-tag', d.running && d.available !== false ? '' : 'wru-warn'], text: d.running ? 'running' : 'stopped' }),
        h('span', { class: 'aw-text-secondary', text: hostLine(d) }),
        d.installed ? button(restarting ? 'Restarting…' : 'Restart', { onClick: restart, variant: 'ghost', disabled: restarting }) : null));
      for (const m of d.modules || []) {
        body.push(h('div', { class: 'aw-flex-row-center-v aw-gap-col-medium' },
          h('span', { class: 'aw-font-subtitle-2', text: m.name }),
          h('span', { class: 'aw-text-tertiary', text: moduleLine(m) })));
      }
      if (!d.installed && /setup:devices/.test(d.reason || '')) {
        body.push(note('info', 'In a checkout, run npm run setup:devices once and restart the app. The desktop app carries the device host already; the Docker image has no USB and does not.'));
      }
    }
    body.push(note('info',
      'The device host holds USB panels for this app, in a process of its own that the app restarts if it stops. '
      + 'It opens a panel only while a page is using it. Each panel’s controls are on its own page.'));
    return card('Device host', ...body);
  }

  ctx.ui.settingsSection({ id: 'devices', order: 5, render });
}
