/*
 * Variables — the page's state, and the `variables` service the rest of the
 * page uses. No DOM; the fetches are handed in, so a test drives it whole.
 *
 * The service is narrow on purpose, like `stack`: **reading** variables, not
 * editing them. The Console asks for `resolver()` and hands it to mynah; Field
 * arithmetic asks for it and hands it to `core/expr.js`; anything else may
 * `list()`, `resolve()` or `evaluate()`. Editing belongs to the panel in this
 * folder, which holds the whole object.
 *
 * Ask for the service per use, not once at start (docs/PLUGINS.md): switched
 * off, `use('variables')` answers null and both callers fall back to exactly
 * what they did before variables existed.
 */

import { evaluate } from '../../src/core/expr.js';
import {
  normalise, checkName, newId, systemIndex, createUserEvaluator, findCycles,
  MAX_VARIABLES, VARIABLES_VERSION
} from './core.js';

/**
 * How long one walk of the store's objects serves. The values are read live
 * on every lookup either way; this only bounds how stale the *set of names*
 * can be — a screen brought into service shows up within a quarter-second —
 * and spares walking the store once per variable in a line.
 */
const INDEX_MS = 250;

/** `@name` → `{sigil: '@', name}`; anything else → null. */
export function splitName(text) {
  const m = /^\s*([$@])(.+?)\s*$/.exec(String(text ?? ''));
  return m ? { sigil: m[1], name: m[2] } : null;
}

/**
 * @param {object} o
 * @param {() => object} o.store     the live store mirror, read per use
 * @param {() => Promise<object|null>} o.load   the stored document
 * @param {(doc: object) => Promise<void>} o.save
 * @param {{warn?: Function}} [o.log]
 * @param {() => number} [o.now]
 */
export function createVariables({ store, load, save, log = {}, now = () => Date.now() }) {
  let doc = normalise(null);
  let state = { loaded: false, error: null, saving: null };
  const listeners = new Set();

  let index = null;
  let indexed = { at: -Infinity, store: null };
  function system() {
    const s = store();
    const t = now();
    if (!index || indexed.store !== s || t - indexed.at > INDEX_MS) {
      index = s && s.ready ? systemIndex(s) : { entries: [], get: () => null, resolve: () => undefined };
      indexed = { at: t, store: s };
    }
    return index;
  }

  /** One evaluator per call: memoised for its lifetime, fresh for the next. */
  const evaluator = () => {
    const sys = system();
    return createUserEvaluator(doc.variables, (name) => sys.resolve(name));
  };

  function changed() {
    for (const fn of [...listeners]) {
      try { fn(); } catch (err) { if (log.warn) log.warn('a variables listener threw', err); }
    }
  }

  async function persist() {
    state.saving = null;
    try {
      await save({ version: VARIABLES_VERSION, variables: doc.variables });
    } catch (err) {
      /* A failed save must not interrupt an operator mid-show. The variable
         stands on this page; the next edit retries. */
      state.saving = `not saved — ${err && err.message ? err.message : err}`;
      if (log.warn) log.warn('could not save the variables', err);
    }
    changed();
  }

  /* ------------------------------------------------------------ reading */

  /** The `$` catalogue, each entry with its value right now. */
  function systemList() {
    return system().entries.map((e) => {
      let answer;
      try { answer = e.read(); } catch (err) { answer = { ok: false, error: err.message }; }
      return {
        kind: 'system', name: '$' + e.name, bare: e.name, group: e.group,
        type: e.type, unit: e.unit, description: e.description, answer
      };
    });
  }

  /** The user's own, with what each evaluates to and any cycle it is in. */
  function userList() {
    const ev = evaluator();
    return doc.variables.map((v) => ({
      kind: 'user', id: v.id, name: '@' + v.name, bare: v.name, definition: v.value,
      answer: ev.user(v.name) || { ok: false, error: 'has no value yet' },
      cycle: ev.cycles.get(v.name.toLowerCase()) || null
    }));
  }

  /** `$S1.width` or `@gap` → the answer, or undefined for a name nobody knows. */
  function resolve(text) {
    const parts = splitName(text);
    if (!parts) return undefined;
    return evaluator().resolver(parts.name, parts.sigil === '$' ? 'system' : 'user');
  }

  /* ------------------------------------------------------------ editing */

  /** A fresh name nobody has: `var1`, `var2`, … */
  function freshName() {
    const taken = new Set(doc.variables.map((v) => v.name.toLowerCase()));
    for (let n = 1; ; n++) if (!taken.has(`var${n}`)) return `var${n}`;
  }

  /** Add a variable. Answers its row, or a sentence when it cannot be added. */
  function add({ name = freshName(), value = '0' } = {}) {
    if (doc.variables.length >= MAX_VARIABLES) return { error: `at most ${MAX_VARIABLES} variables` };
    const problem = checkName(name, doc.variables);
    if (problem) return { error: problem };
    const row = { id: newId(), name: name.trim(), value: String(value).trim() };
    doc = { ...doc, variables: [...doc.variables, row] };
    void persist();
    return { row };
  }

  /**
   * Rename a variable or change its definition. A rename carries every
   * `@old` in the other definitions with it, so renaming does not break what
   * was built on the name. A definition is kept whatever it says — one that
   * does not evaluate shows why, the way a spreadsheet cell does.
   *
   * @returns {string|null} a sentence when refused
   */
  function update(id, patch = {}) {
    const row = doc.variables.find((v) => v.id === id);
    if (!row) return 'that variable has gone';
    let rows = doc.variables;
    const name = patch.name === undefined ? row.name : String(patch.name).trim().replace(/^@/, '');
    if (name !== row.name) {
      const problem = checkName(name, doc.variables, id);
      if (problem) return problem;
      rows = rows.map((v) => (v.id === id ? { ...v, name } : { ...v, value: renameIn(v.value, row.name, name) }));
    }
    if (patch.value !== undefined) {
      const value = String(patch.value).replace(/\s+/g, ' ').trim();
      rows = rows.map((v) => (v.id === id ? { ...v, value } : v));
    }
    if (rows === doc.variables) return null;
    doc = { ...doc, variables: rows };
    void persist();
    return null;
  }

  function remove(id) {
    const rows = doc.variables.filter((v) => v.id !== id);
    if (rows.length === doc.variables.length) return;
    doc = { ...doc, variables: rows };
    void persist();
  }

  /**
   * What a definition would evaluate to, without keeping it — the panel's
   * live result while a value is being typed. Cycles are checked against the
   * set as it would be.
   */
  function preview(id, value) {
    const rows = doc.variables.map((v) => (v.id === id ? { ...v, value: String(value) } : v));
    const row = rows.find((v) => v.id === id);
    if (!row) return { ok: false, error: 'that variable has gone' };
    const sys = system();
    const ev = createUserEvaluator(rows, (name) => sys.resolve(name));
    return ev.user(row.name) || { ok: false, error: 'has no value yet' };
  }

  async function start() {
    try {
      doc = normalise(await load());
      state = { ...state, loaded: true, error: null };
    } catch (err) {
      state = { ...state, loaded: true, error: `could not load the variables — ${err && err.message ? err.message : err}` };
      if (log.warn) log.warn('could not load the variables', err);
    }
    changed();
  }

  const service = Object.freeze({
    /** Every variable, `$` then `@`, with its value or the reason it has none. */
    list: () => [...systemList(), ...userList()],
    /** One variable by its written name — `$S1.width`, `@gap`. */
    resolve,
    /**
     * `(name, kind) => answer`, the shape mynah's `vars` and `core/expr.js`'s
     * `resolve` take. Fresh per call; hold it for one line, not for ever.
     */
    resolver: () => evaluator().resolver,
    /** Arithmetic over numbers and variables — `$S1.width/2` — as a field would. */
    evaluate: (text) => evaluate(text, { resolve: evaluator().resolver }),
    /** Hear the user's variables change. Answers its own unsubscribe. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  });

  return {
    service,
    start,
    state: () => state,
    definitions: () => doc.variables.map((v) => ({ ...v })),
    systemList,
    userList,
    cycles: () => findCycles(doc.variables),
    resolve,
    add,
    update,
    remove,
    preview,
    onChange: service.onChange
  };
}

/** Every `@from` in a definition, as `@to` — whole names only, any case. */
export function renameIn(definition, from, to) {
  const target = from.toLowerCase();
  return String(definition).replace(/@([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)/g,
    (whole, name) => (name.toLowerCase() === target ? '@' + to : whole));
}
