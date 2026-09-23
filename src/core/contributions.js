/*
 * How plugins extend each other: contribution points, and shared services.
 *
 * A **contribution point** is a place in the app that takes additions from any
 * plugin — a new kind of thing a cue can do, a new subtree of OSC addresses.
 * The app's own features used to reach into each other by name instead: the
 * cue engine had the matrix router's two actions in its switch, the Console
 * intercepted `/lp/matrix/` by hand, and the OSC server took a matrix-only hook.
 * Each was a special case only a built-in could have. Now the engine, the
 * Console and the OSC server ask the registry, and Matrix Routing contributes
 * like anybody else would.
 *
 * A **service** is an object one plugin offers the rest — the cue stack, say —
 * found by name with `use`. It is how a plugin gets at another's state without
 * importing its files.
 *
 * ## The points
 *
 * | point           | where  | keyed by | a contribution is |
 * |-----------------|--------|----------|-------------------|
 * | `cueAction`     | page   | `kind`   | `{ kind, label, run(action, { cue }), describe?(action), field? }` |
 * | `oscAddress`    | server | `prefix` | `{ prefix, describe?, handle(address, args) }` |
 * | `configSection` | server | `key`    | `{ key, group, label, perDevice?, byDefault?, export(device), import(data, device) }` |
 *
 * `cueAction.run` is called while the cue fires, in the order the cue lists
 * its actions, alongside the recalls and before any take or cut in the same cue
 * — the take is deferred and yours is not. It is not awaited; a promise that
 * rejects is reported as a warning on the cue, like a failed write.
 *
 * `cueAction.field`, when there is one, is how a cue editor offers the kind:
 * one text field per cue, `{ label, placeholder?, hint?, parse(text),
 * format(actions), pick?({ doc, text }) }`. `parse` answers the cue's
 * actions of this kind — an empty list clears them — or throws a sentence
 * the editor shows; `format` turns them back into the text. `pick`, when
 * given, is a chooser the editor puts a button beside the field for: drawn
 * in `doc`, the editor's own document, starting from the field's `text`, and
 * resolving with the new text, or null to leave it. See `fieldActions`.
 *
 * `oscAddress.handle` is called for any address at or below `prefix`, from UDP
 * and from a line typed in the Console alike. It answers
 * `{ ok: true, summary?, count? }`, `{ ok: false, error }`, or null to decline
 * an address after all — which lets it fall through to the switcher's own.
 *
 * `configSection` is a section of the one-file setup, `livepremier-plus.json`
 * (the Setup file plugin writes and reads it). `group` is where it sits in the
 * file — `installation` for what belongs to this machine, `show` and `rig` for
 * what belongs to one switcher, which is what `perDevice` says. `export(device)`
 * answers the section, or undefined for "nothing to write" — which an import
 * then leaves alone, where an empty section would wipe. `import(data, device)`
 * puts it back, for a switcher that need not be the one the app points at now
 * — and when it is, into the running feature as well as its file. `byDefault:
 * false` keeps a section out of an import that did not ask for it by name.
 *
 * The app's own contributions and services are owned by `APP`, which no
 * plugin can be called and which is never off.
 *
 * `core/` knows nothing about browsers: this is a pair of plain registries,
 * used by both plugin hosts.
 */

import { ACTION_KINDS } from './cuestack.js';

const fn = (v) => typeof v === 'function';

/** The owner of what the app itself contributes or provides: not a plugin id, and always on. */
export const APP = '(app)';

/** Where a `configSection` may sit in the setup file. */
export const CONFIG_GROUPS = ['installation', 'show', 'rig'];
const text = (v) => typeof v === 'string' && v.trim().length > 0;

/** The action kinds the cue engine does itself, which nothing may claim. */
const CORE_KINDS = new Set(Object.values(ACTION_KINDS));

/**
 * The points there are, what a contribution to each must look like, and what
 * makes two of them collide. `check` answers with a problem, or null.
 */
export const POINTS = {
  cueAction: {
    side: 'page',
    key: 'kind',
    check(spec) {
      if (!text(spec.kind) || !/^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/.test(spec.kind)) {
        return 'its kind must be a name: letters, digits, _ : . -';
      }
      if (CORE_KINDS.has(spec.kind)) return `"${spec.kind}" is one the cue engine does itself`;
      if (!text(spec.label)) return 'it needs a label, which is what a cue sheet shows';
      if (!fn(spec.run)) return 'it needs a run(action, { cue }) function';
      if (spec.describe !== undefined && !fn(spec.describe)) return 'describe must be a function';
      if (spec.field !== undefined) {
        const f = spec.field;
        if (!f || typeof f !== 'object') return 'field must be an object';
        if (!text(f.label)) return 'its field needs a label';
        if (!fn(f.parse) || !fn(f.format)) return 'its field needs parse(text) and format(actions)';
        if (f.pick !== undefined && !fn(f.pick)) return 'field.pick must be a function';
      }
      return null;
    },
    clash: (a, b) => a.kind === b.kind
  },
  oscAddress: {
    side: 'server',
    key: 'prefix',
    check(spec, { builtIn }) {
      if (!text(spec.prefix) || !/^(\/[A-Za-z0-9_-]+)+\/$/.test(spec.prefix)) {
        return 'its prefix must be an address that ends in "/", like "/hello/"';
      }
      /* `/lp/` is the switcher's own address space — mynah's. A plugin that
         could answer `/lp/screen/…` could quietly take the switcher's
         addresses over. Built-ins have one subtree there, `/lp/matrix/`,
         which predates this rule. */
      if (!builtIn && spec.prefix.startsWith('/lp/')) return '"/lp/…" is the switcher’s own address space';
      if (!fn(spec.handle)) return 'it needs a handle(address, args) function';
      return null;
    },
    /* A subtree inside another's is a collision too: the longer prefix would
       quietly take part of the shorter one's space away. */
    clash: (a, b) => a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix)
  },
  configSection: {
    side: 'server',
    key: 'key',
    check(spec) {
      if (!text(spec.key) || !/^[a-z][a-zA-Z0-9-]{0,39}$/.test(spec.key)) {
        return 'its key must be a name: a lower-case letter, then letters, digits or -';
      }
      /* The file's own envelope. A section called `device` would sit beside the
         record of which switcher the file was written against. */
      if (['format', 'version', 'exported', 'app', 'device', ...CONFIG_GROUPS].includes(spec.key)) {
        return `"${spec.key}" is part of the file's own envelope`;
      }
      if (!CONFIG_GROUPS.includes(spec.group)) return `its group must be one of ${CONFIG_GROUPS.join(', ')}`;
      if (!text(spec.label)) return 'it needs a label, which is what an import reports';
      if (!fn(spec.export) || !fn(spec.import)) return 'it needs export(device) and import(data, device)';
      return null;
    },
    clash: (a, b) => a.key === b.key
  }
};

/**
 * The contributions in one process, or one page.
 *
 * Each is recorded with its owner — the plugin that made it — so switching a
 * plugin off can take its contributions with it, and so a listing can leave
 * out those whose owner is off.
 */
export function createContributions() {
  const byPoint = new Map();

  return {
    /**
     * Add one. Throws, saying why, for an unknown point, a malformed
     * contribution, or one that collides with another plugin's.
     */
    add(point, spec, owner, { builtIn = true } = {}) {
      const def = POINTS[point];
      if (!def) throw new Error(`${owner}: there is no contribution point called "${point}"`);
      if (!spec || typeof spec !== 'object') throw new Error(`${owner}: a ${point} contribution must be an object`);
      const problem = def.check(spec, { builtIn });
      if (problem) throw new Error(`${owner}: ${point}: ${problem}`);
      const list = byPoint.get(point) || [];
      const clash = list.find((c) => def.clash(c.spec, spec) && (c.owner !== owner || c.spec[def.key] === spec[def.key]));
      if (clash) {
        throw new Error(`${owner}: ${point} "${spec[def.key]}" collides with ${clash.owner}'s "${clash.spec[def.key]}"`);
      }
      list.push({ owner, spec: Object.freeze({ ...spec }) });
      byPoint.set(point, list);
    },

    /**
     * The contributions to a point, each `{ ...spec, owner }`, leaving out any
     * whose owner `isOn` says is off.
     */
    list(point, isOn = () => true) {
      return (byPoint.get(point) || [])
        .filter((c) => isOn(c.owner))
        .map((c) => ({ ...c.spec, owner: c.owner }));
    },

    /** Take everything a plugin contributed away — it was switched off. */
    removeOwner(owner) {
      for (const [point, list] of byPoint) byPoint.set(point, list.filter((c) => c.owner !== owner));
    }
  };
}

/**
 * The `oscAddress` contribution an address belongs to: the longest prefix it
 * falls under, or null. Longest, so a plugin may answer `/a/` and — itself —
 * `/a/b/` differently.
 */
export function oscAddressFor(list, address) {
  let best = null;
  for (const c of list) {
    if (address === c.prefix.slice(0, -1) || address.startsWith(c.prefix)) {
      if (!best || c.prefix.length > best.prefix.length) best = c;
    }
  }
  return best;
}

/**
 * How a cue sheet names an action of a kind a plugin contributed: its own
 * `describe`, else its label, else the bare kind — which is also what a cue
 * whose plugin is switched off shows, so the action is not silently hidden.
 * A `describe` that throws is its plugin's fault, not the cue sheet's.
 */
/**
 * Put what a contributed field was given into a cue's actions.
 *
 * The cue's actions of that kind are replaced by what `field.parse` answers —
 * **where the first of them was**, so a trigger that the operator had placed
 * after a recall stays after it — and every other action is left exactly as
 * it was. Throws what `parse` throws, having changed nothing.
 *
 * @returns {object[]} the cue's new action list
 */
export function fieldActions(actions, contribution, text) {
  const made = contribution.field.parse(String(text ?? ''));
  if (!Array.isArray(made)) throw new Error(`${contribution.label}: the field answered no actions`);
  const kind = contribution.kind;
  const fresh = made.map((a) => ({ ...a, kind }));
  const list = actions || [];
  const at = list.findIndex((a) => a.kind === kind);
  const rest = list.filter((a) => a.kind !== kind);
  if (at < 0) return [...rest, ...fresh];
  const before = list.slice(0, at).filter((a) => a.kind !== kind).length;
  return [...rest.slice(0, before), ...fresh, ...rest.slice(before)];
}

/** The text a contributed field shows for a cue's actions — its own `format`, over its own kind. */
export function fieldText(actions, contribution) {
  const mine = (actions || []).filter((a) => a.kind === contribution.kind);
  try { return String(contribution.field.format(mine) ?? ''); } catch { return ''; }
}

export function describeContributed(action, list) {
  const c = (list || []).find((x) => x.kind === action.kind);
  if (!c) return action.kind;
  if (typeof c.describe === 'function') {
    try { return String(c.describe(action)); } catch { return c.label; }
  }
  return c.label;
}

/**
 * The services in one process, or one page: an object offered under a name,
 * and found by it. One provider per name; a second is refused rather than
 * silently replacing the first.
 */
export function createServices() {
  const byName = new Map();
  return {
    provide(name, api, owner) {
      if (!text(name)) throw new Error(`${owner}: a service needs a name`);
      if (api == null) throw new Error(`${owner}: service "${name}" is empty`);
      const held = byName.get(name);
      if (held) throw new Error(`${owner}: service "${name}" is already provided by ${held.owner}`);
      byName.set(name, { owner, api });
    },
    /** The service, or null when nobody provides it or its provider is off. */
    use(name, isOn = () => true) {
      const held = byName.get(name);
      return held && isOn(held.owner) ? held.api : null;
    },
    removeOwner(owner) {
      for (const [name, held] of byName) if (held.owner === owner) byName.delete(name);
    },
    list: () => [...byName].map(([name, { owner }]) => ({ name, owner }))
  };
}
