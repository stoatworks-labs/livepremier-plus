/*
 * Matrix routing: the routers in the rack, the cables to them, and the two
 * operations that follow.
 *
 * ## Why this is a panel of ours and not a tab
 *
 * It is a whole-device view — it is about the back of the frame, not about
 * one screen — so it belongs beside the VPU map in the sidebar rather than on
 * the Screens / Aux. strip, by the same rule that put the memory banks there.
 *
 * ## Why the panel holds its own data
 *
 * Every other panel here reads the store mirror, which is already in the page.
 * An external router is not in the store and never will be: the switcher has
 * never heard of the Videohub in front of it. So this one fetches from our own
 * process and keeps a live subscription to it — `GET /__lpp/matrix` for the
 * picture and `/__lpp/matrix/stream` for changes, which arrive whether they
 * came from this panel, another operator, or somebody at the router's front
 * panel.
 *
 * That subscription is not a nicety. A grid that only updated when you touched
 * it would be a grid that was right when you opened it, which on a show is
 * worse than no grid at all.
 *
 * ## What the two tables are
 *
 * **Routers** is setup: what is in the rack and whether we can reach it.
 * **Patch** is the daily surface: one row per cable, showing what that socket
 * is currently getting or going to, with the control to change it in the same
 * row. Those are genuinely different jobs and an operator does the first once.
 *
 * ⚠️ **The two route controls are different and must stay different.** An
 * input row picks *one* source, because a socket is fed by one router output.
 * An output row takes a *list* of destinations, because the signal arrives at
 * one router input and can be sent to any number of outputs. Making them look
 * alike would be making a lie look tidy. See `core/patch.js`.
 */

import { h, button, sectionTitle } from '../../src/ui/dom.js';
import { panel } from '../../src/ui/shell.js';
import { readAllConnectors, describeConnector } from '../../src/core/connectors.js';
import { MATRIX_KINDS, entryConnectorId, currentFor } from '../../src/core/patch.js';

const API = '/__lpp/matrix';

export function createMatrixPanel({ session, onRefresh }) {
  /* The last snapshot from the server. Null until the first fetch lands —
     which is a different thing from "no routers configured", and the panel
     says so rather than showing an empty table that looks like an answer. */
  let data = null;
  let error = null;
  let stream = null;

  /* Draft state for the two forms. Kept out of `data` so a redraw driven by a
     router changing its mind does not wipe what somebody is halfway through
     typing. */
  const draft = { matrix: blankMatrix(), addConnector: '', addMatrix: '', addPort: '' };
  const routeDraft = {};      /* connector id -> what is typed in its row */
  let busy = null;            /* connector id or 'patch' while a POST is out */

  async function load() {
    try {
      const res = await fetch(API, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${res.status}`);
      data = await res.json();
      error = null;
    } catch (err) {
      error = `Could not reach the launcher: ${err.message}`;
    }
    onRefresh && onRefresh();
  }

  /**
   * Subscribe to router changes.
   *
   * EventSource reconnects on its own, so a launcher restart heals without
   * anybody reloading the page. The payload is the router list only; the patch
   * is ours and changes only when we change it.
   */
  function listen() {
    if (stream) return;
    try {
      stream = new EventSource(`${API}/stream`);
      stream.addEventListener('matrix', (ev) => {
        try {
          const matrices = JSON.parse(ev.data);
          if (data) data.matrices = matrices;
          else data = { matrices, patch: [], problems: [], routing: {} };
          /* The routing table is folded out of the same payload so
             `currentFor` has something to read without a second fetch. */
          data.routing = Object.fromEntries(
            matrices.filter((m) => m.state).map((m) => [m.id, m.state.routing]));
          onRefresh && onRefresh();
        } catch { /* a malformed frame is not worth taking the panel down */ }
      });
    } catch { /* no EventSource: the panel still works, just not live */ }
  }

  async function post(path, body, key) {
    busy = key;
    onRefresh && onRefresh();
    try {
      const res = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) error = payload.error || `${res.status}`;
      else error = null;
      if (payload.patch) data = { ...data, ...payload };
      return payload;
    } catch (err) {
      error = err.message;
      return null;
    } finally {
      busy = null;
      onRefresh && onRefresh();
      /* A route is answered by the router a moment later, not by the reply.
         Nothing is written locally — the stream brings the truth. */
    }
  }

  async function savePatch(entries) {
    busy = 'patch';
    onRefresh && onRefresh();
    try {
      const res = await fetch(`${API}/patch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: entries }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) { data = { ...data, ...payload }; error = null; }
      else error = payload.error || `${res.status}`;
    } catch (err) {
      error = err.message;
    } finally {
      busy = null;
      onRefresh && onRefresh();
    }
  }

  async function saveMatrices(list) {
    busy = 'matrices';
    onRefresh && onRefresh();
    try {
      const res = await fetch(API, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matrices: list }),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) { data = { ...data, ...payload }; error = null; }
      else error = payload.error || `${res.status}`;
    } catch (err) {
      error = err.message;
    } finally {
      busy = null;
      onRefresh && onRefresh();
    }
  }

  /* ---------------------------------------------------------------- */

  function render() {
    if (!data && !error) { load(); listen(); }
    else listen();

    return panel({
      toolbar: sectionTitle('Matrix routing', summary()),
      body: h('div', { class: 'aw-flex-col aw-gap-row-medium' },
        error ? h('div', { class: 'wru-warn', text: error }) : null,
        problems(),
        routersSection(),
        patchSection()),
    });
  }

  function summary() {
    const list = (data && data.matrices) || [];
    if (!list.length) return null;
    return h('div', { class: 'aw-flex-row aw-gap-column-small' },
      ...list.map((m) => h('span', {
        class: `wru-tag ${m.status === 'connected' ? 'wru-tag--good' : ''}`,
        title: `${m.host}:${m.port} — ${m.status}${m.error ? ` (${m.error})` : ''}`,
        text: `${m.name} ${statusGlyph(m.status)}`,
      })));
  }

  function problems() {
    const list = (data && data.problems) || [];
    if (!list.length) return null;
    return h('div', { class: 'wru-warnings' },
      ...list.map((p) => h('div', { class: 'wru-warn', text: p.message })));
  }

  /* ---- routers ---------------------------------------------------- */

  function routersSection() {
    const list = (data && data.matrices) || [];
    const rows = list.map((m) => h('tr', {},
      h('td', { text: m.name }),
      h('td', { text: kindLabel(m.kind) + (m.protocol ? ` (${m.protocol.toUpperCase()})` : '') }),
      h('td', { text: `${m.host}:${m.port}` }),
      h('td', {},
        h('span', {
          class: `wru-tag ${m.status === 'connected' ? 'wru-tag--good' : ''}`,
          text: m.status,
        })),
      h('td', { text: m.state ? `${m.state.inputs} × ${m.state.outputs}` : '—' }),
      h('td', { text: m.state?.model || m.error || '' }),
      h('td', {}, button('Remove', {
        variant: 'danger',
        disabled: busy === 'matrices',
        onClick: () => saveMatrices(list.filter((x) => x.id !== m.id).map(toConfig)),
      }))));

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Routers' }),
      list.length
        ? h('table', { class: 'wru-table' },
            h('thead', {}, h('tr', {},
              ...['Name', 'Protocol', 'Address', 'Link', 'Size', 'Reports', ''].map(
                (t) => h('th', { text: t })))),
            h('tbody', {}, ...rows))
        : h('div', {
            class: 'wru-empty',
            text: data ? 'No routers configured yet.' : 'Asking the launcher…',
          }),
      addMatrixForm(list));
  }

  function addMatrixForm(list) {
    const kindSelect = h('select', {
      class: 'wru-select',
      onChange: (ev) => {
        draft.matrix.kind = ev.target.value;
        /* Follow the new kind's default port unless a port was actually
           typed — changing protocol and keeping 9990 is never what was meant. */
        const kind = MATRIX_KINDS.find((k) => k.id === ev.target.value);
        if (!draft.matrix.portTouched) draft.matrix.port = String(kind.defaultPort);
        onRefresh && onRefresh();
      },
    }, ...MATRIX_KINDS.map((k) => h('option', {
      value: k.id, selected: k.id === draft.matrix.kind ? 'selected' : null,
    }, k.label)));

    const chosen = MATRIX_KINDS.find((k) => k.id === draft.matrix.kind);

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-flex-row aw-gap-column-small aw-align-items-end' },
        field('Name', h('input', {
          class: 'wru-input', value: draft.matrix.name, placeholder: 'Machine room',
          onInput: (ev) => { draft.matrix.name = ev.target.value; },
        })),
        field('Protocol', kindSelect),
        field('Address', h('input', {
          class: 'wru-input', value: draft.matrix.host, placeholder: '192.168.1.60',
          onInput: (ev) => { draft.matrix.host = ev.target.value; },
        })),
        field('Port', h('input', {
          class: 'wru-input wru-input--narrow', value: draft.matrix.port,
          onInput: (ev) => { draft.matrix.port = ev.target.value; draft.matrix.portTouched = true; },
        })),
        /*
         * Validated on the click, not by being disabled.
         *
         * A panel here is rebuilt wholesale, and `main.js` deliberately holds
         * repaints off while a text field has an uncommitted edit — a device
         * frame arriving mid-keystroke would take the field and the caret with
         * it, and the store produces a frame a second. So nothing typed into
         * one of these fields re-renders the button, and a button disabled at
         * render time would stay disabled while the operator filled the form
         * in. Refusing on the click with a reason is the behaviour that
         * survives that, and it says what is missing instead of doing nothing.
         */
        button('Add router', {
          variant: 'go',
          disabled: busy === 'matrices',
          onClick: () => {
            if (!draft.matrix.name.trim() || !draft.matrix.host.trim()) {
              error = 'A router needs a name and an address.';
              return onRefresh && onRefresh();
            }
            const next = [...list.map(toConfig), {
              id: draft.matrix.name, name: draft.matrix.name, kind: draft.matrix.kind,
              host: draft.matrix.host.trim(), port: Number(draft.matrix.port), enabled: true,
            }];
            draft.matrix = blankMatrix();
            saveMatrices(next);
          },
        })),
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: chosen.what }));
  }

  /* ---- patch ------------------------------------------------------ */

  function patchSection() {
    const store = session.store;
    const connectors = store && store.ready
      ? readAllConnectors(store)
      : { input: [], output: [] };
    const all = [...connectors.input, ...connectors.output];
    const byId = new Map(all.map((c) => [c.id, c]));

    const entries = (data && data.patch) || [];
    const routing = (data && data.routing) || {};

    const rows = entries.map((entry) => patchRow(entry, byId, routing, entries));

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: 'Patch' }),
      entries.length
        ? h('table', { class: 'wru-table' },
            h('thead', {}, h('tr', {},
              ...['Socket', 'Router', 'Port', 'Now', 'Route', ''].map((t) => h('th', { text: t })))),
            h('tbody', {}, ...rows))
        : h('div', {
            class: 'wru-empty',
            text: store && store.ready
              ? 'Nothing patched. Add a cable below.'
              : 'Waiting for the device store…',
          }),
      all.length ? addPatchForm(all, entries) : null);
  }

  function patchRow(entry, byId, routing, entries) {
    const id = entryConnectorId(entry);
    const connector = byId.get(id);
    const state = currentFor([entry], id, routing);
    const matrix = ((data && data.matrices) || []).find((m) => m.id === entry.matrix);
    const live = matrix && matrix.status === 'connected';

    return h('tr', {},
      h('td', {}, connector
        ? describeConnector(connector)
        /* A patch can name a socket this frame does not have — somebody
           re-pointed at a smaller chassis, or the cable schedule came from
           another rig. Say which, rather than drawing a blank row. */
        : h('span', { class: 'wru-warn', text: `${entry.side} ${entry.key} — not on this frame` })),
      h('td', { text: matrix ? matrix.name : entry.matrix }),
      h('td', { text: `${entry.routerSide} ${entry.port}` }),
      h('td', {}, nowCell(entry, state, matrix)),
      h('td', {}, live ? routeControl(entry, id, matrix) : h('span', {
        class: 'aw-text-tertiary', text: matrix ? matrix.status : 'no such router',
      })),
      h('td', {}, button('Unpatch', {
        variant: 'danger',
        disabled: busy === 'patch',
        onClick: () => savePatch(entries.filter((e) => entryConnectorId(e) !== id
          || e.matrix !== entry.matrix || e.port !== entry.port)),
      })));
  }

  function nowCell(entry, state, matrix) {
    if (!state || !state.known) return h('span', { class: 'aw-text-tertiary', text: '—' });
    if (entry.side === 'input') {
      if (state.source == null) return h('span', { class: 'aw-text-tertiary', text: 'nothing' });
      return h('span', { text: portName(matrix, 'input', state.source) });
    }
    if (!state.destinations.length) {
      return h('span', { class: 'aw-text-tertiary', text: 'nowhere' });
    }
    return h('span', {
      text: state.destinations.map((d) => portName(matrix, 'output', d)).join(', '),
    });
  }

  /**
   * The control that fires a route.
   *
   * An input gets a source picker — one choice, applied on change, because a
   * dropdown that then needed a button pressed is a dropdown people will
   * forget to press. An output gets a destination field and a button, because
   * a list is typed and a half-typed list must not fire.
   */
  function routeControl(entry, id, matrix) {
    if (entry.side === 'input') {
      const count = matrix.state ? matrix.state.inputs : 0;
      const select = h('select', {
        class: 'wru-select',
        disabled: busy === id ? 'disabled' : null,
        onChange: (ev) => {
          const source = Number(ev.target.value);
          if (source) post('/feed', { connector: id, source }, id);
        },
      }, h('option', { value: '' }, 'Choose a source…'),
        ...Array.from({ length: count }, (_, i) => h('option', { value: String(i + 1) },
          portName(matrix, 'input', i + 1))));
      return select;
    }

    /* An output. The field takes `1-4` and `1,2,5-8` as well as a single
       number — `toPortList` in the proxy parses it, and a range is how
       somebody actually says "outputs 1 to 4". */
    const input = h('input', {
      class: 'wru-input wru-input--narrow',
      value: routeDraft[id] ?? '',
      placeholder: '1-4',
      title: 'Router outputs — 3, or 1-4, or 1,2,5-8',
      onInput: (ev) => { routeDraft[id] = ev.target.value; },
      onKeyDown: (ev) => { if (ev.key === 'Enter') fire(); },
    });
    const fire = () => {
      const text = (routeDraft[id] ?? '').trim();
      if (!text) {
        error = 'Name the router outputs to send to — 3, or 1-4, or 1,2,5-8.';
        return onRefresh && onRefresh();
      }
      post('/send', { connector: id, destinations: text }, id);
    };
    return h('div', { class: 'aw-flex-row aw-gap-column-small' }, input,
      button('Send', { variant: 'go', disabled: busy === id, onClick: fire }));
  }

  function addPatchForm(all, entries) {
    const patched = new Set(entries.map(entryConnectorId));
    const free = all.filter((c) => !patched.has(c.id));
    const list = (data && data.matrices) || [];
    if (!list.length) {
      return h('div', {
        class: 'aw-font-caption aw-text-tertiary',
        text: 'Add a router above before patching cables to it.',
      });
    }
    if (!free.length) return null;

    if (!draft.addMatrix) draft.addMatrix = list[0].id;
    const chosenSide = free.find((c) => c.id === draft.addConnector)?.side;

    return h('div', { class: 'aw-flex-col aw-gap-row-small' },
      h('div', { class: 'aw-flex-row aw-gap-column-small aw-align-items-end' },
        field('Socket', h('select', {
          class: 'wru-select',
          onChange: (ev) => { draft.addConnector = ev.target.value; onRefresh && onRefresh(); },
        }, h('option', { value: '' }, 'Choose a socket…'),
          ...free.map((c) => h('option', {
            value: c.id, selected: c.id === draft.addConnector ? 'selected' : null,
          }, describeConnector(c))))),
        field('Router', h('select', {
          class: 'wru-select',
          onChange: (ev) => { draft.addMatrix = ev.target.value; },
        }, ...list.map((m) => h('option', {
          value: m.id, selected: m.id === draft.addMatrix ? 'selected' : null,
        }, m.name)))),
        field(portLabel(chosenSide), h('input', {
          class: 'wru-input wru-input--narrow', value: draft.addPort, placeholder: '1',
          onInput: (ev) => { draft.addPort = ev.target.value; },
        })),
        /* Validated on the click for the same reason as Add router above. */
        button('Patch', {
          variant: 'go',
          disabled: busy === 'patch',
          onClick: () => {
            if (!draft.addConnector) {
              error = 'Choose which socket the cable is plugged into.';
              return onRefresh && onRefresh();
            }
            if (!Number(draft.addPort)) {
              error = `Give the ${portLabel(chosenSide).toLowerCase()} number, counting from 1.`;
              return onRefresh && onRefresh();
            }
            const [side, ...rest] = draft.addConnector.split(':');
            const next = [...entries, {
              side, key: rest.join(':'), matrix: draft.addMatrix, port: Number(draft.addPort),
            }];
            draft.addConnector = '';
            draft.addPort = '';
            savePatch(next);
          },
        })),
      /* The direction inverts, and saying so here is cheaper than an operator
         discovering it by patching a whole rack backwards. */
      h('div', { class: 'aw-font-caption aw-text-tertiary', text: chosenSide
        ? (chosenSide === 'input'
            ? 'A switcher input is fed by a router OUTPUT — give the router output number the cable comes from.'
            : 'A switcher output arrives at a router INPUT — give the router input number the cable goes to.')
        : 'A switcher input hangs off a router output; a switcher output arrives at a router input.' }));
  }

  return { render, reload: load };
}

/* ------------------------------------------------------------------ */

const blankMatrix = () => ({ name: '', kind: 'videohub', host: '', port: '9990', portTouched: false });

const toConfig = (m) => ({
  id: m.id, name: m.name, kind: m.kind, host: m.host, port: m.port, enabled: m.enabled !== false,
});

const kindLabel = (kind) => MATRIX_KINDS.find((k) => k.id === kind)?.label ?? kind;

const portLabel = (side) =>
  side === 'input' ? 'Router output' : side === 'output' ? 'Router input' : 'Router port';

const statusGlyph = (status) =>
  status === 'connected' ? '●' : status === 'connecting' ? '◐' : '○';

/** A router port as the router itself names it, falling back to its number. */
function portName(matrix, side, port) {
  const labels = matrix && matrix.state
    ? (side === 'input' ? matrix.state.inputLabels : matrix.state.outputLabels)
    : null;
  const label = labels && labels[port];
  return label ? `${port} — ${label}` : String(port);
}

function field(label, control) {
  return h('label', { class: 'wru-field aw-flex-col' },
    h('span', { class: 'aw-font-caption aw-text-tertiary', text: label }), control);
}
