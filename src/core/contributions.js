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
 * | point        | where  | keyed by | a contribution is |
 * |--------------|--------|----------|-------------------|
 * | `cueAction`  | page   | `kind`   | `{ kind, label, run(action, { cue }), describe?(action) }` |
 * | `oscAddress` | server | `prefix` | `{ prefix, describe?, handle(address, args) }` |
 *
 * `cueAction.run` is called while the cue fires, in the order the cue lists
 * its actions, alongside the recalls and before any take or cut in the same cue
 * — the take is deferred and yours is not. It is not awaited; a promise that
 * rejects is reported as a warning on the cue, like a failed write.
 *
 * `oscAddress.handle` is called for any address at or below `prefix`, from UDP
 * and from a line typed in the Console alike. It answers
 * `{ ok: true, summary?, count? }`, `{ ok: false, error }`, or null to decline
 * an address after all — which lets it fall through to the switcher's own.
 *
 * `core/` knows nothing about browsers: this is a pair of plain registries,
 * used by both plugin hosts.
 */

import { ACTION_KINDS } from './cuestack.js';

const fn = (v) => typeof v === 'function';
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
