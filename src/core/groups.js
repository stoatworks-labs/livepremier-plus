/*
 * Layer groups — several layers, on one screen or on many, driven as one.
 *
 * The switcher has no such concept. A LivePremier addresses a layer as
 * (destination, preset buffer, layer key) and nothing above that ties two of
 * them together; the same is true on Midra 4K and Alta 4K. So a group is
 * *ours*: a named list of members kept beside the cue stack, resolved to real
 * device paths only at the moment something is applied to it.
 *
 * ## What a group is for
 *
 * The show reason is the side screens. Layer 2 on screen 1 and layer 1 on
 * screens 2 and 3 are, to the operator, one thing — the IMAG. Sending an
 * input to "the side screens" is one decision, and making it three times is
 * three chances to miss one. A group is the name for that one decision.
 *
 * ## Two halves, and only one of them writes on its own
 *
 * - **Fan-out.** Apply a source to a group and every member gets it, in the
 *   buffer the caller named. That is `sourceCommands()`, and nothing happens
 *   until a caller asks.
 * - **The gang.** A group marked `gang` also *follows*: change one member's
 *   source by any route — our menu, the vendor's own UI, a memory recall —
 *   and the rest are written to match. That is `createGang()`, and it is the
 *   only thing in this app that puts a write on the wire without an operator
 *   having asked for that write specifically. Everything about it below is
 *   written to make that safe, and the traps are marked.
 *
 * ## ⚠️ You gang a ROLE, not a letter
 *
 * A layer's source lives under a preset *buffer* — the letter A, B or C on
 * LivePremier, UP or DOWN on Midra — and which letter is program changes on
 * every take. Two screens are very often on opposite letters: S1 can be
 * `AT_UP` while S2 is `AT_DOWN`, so S1's program is B and S2's is A.
 *
 * So a change seen in S1's letter B is first turned back into a *role* —
 * program or preview — through `presetBanks()`, and the write to S2 is then
 * addressed to whichever letter means that role on S2. Ganging letter to
 * letter would put a preview edit on air on half the screens, which is the
 * exact accident this whole file exists to avoid.
 *
 * LivePremier's third buffer follows from the same rule: C is `presetPrevious`
 * and is neither program nor preview, so a change there names no role and is
 * not propagated at all.
 *
 * ## ⚠️ Mid-take there is no honest answer, so nothing is written
 *
 * `presetBanks().settled` is false while a transition is in flight, and the
 * properties panel already refuses to write in that state rather than guess.
 * The gang inherits that refusal per screen: a member whose screen is mid-take
 * is skipped and reported, not written to on a coin toss.
 *
 * ## ⚠️ Why this cannot loop
 *
 * Three rules, and they are not interchangeable — each closes a case the
 * others do not:
 *
 * - **Our own echoes are recognised and dropped.** Every write is remembered
 *   as (path, value) until the frame carrying it back arrives. Without this
 *   a fan-out to three members produces a second, redundant round: the first
 *   echo lands while the *other* members are still stale in the mirror, so
 *   the value check below sees a difference that is only the echo overtaking
 *   itself. The test `the echo of a fan-out produces no second round` is
 *   exactly that case, and it failed before this existed.
 * - **A member is written only when its current value differs.** The
 *   backstop, and what makes the whole thing convergent rather than merely
 *   quiet: whatever else goes wrong, a round that would write what is already
 *   there writes nothing.
 * - **A group ignores frames for `SETTLE_MS` after its own fan-out.** This is
 *   for the burst: a memory recall rewrites several members in the same
 *   handful of milliseconds with *different* values, and without a window
 *   each one would fight the last. The window makes the rule plain — the
 *   first change into a group wins, and the rest of that burst is the group
 *   being brought into line rather than a new decision.
 *
 * A layer may also belong to **at most one group**, which `normalise()`
 * enforces on the way in. Two ganged groups sharing a member is the one shape
 * that could still ping-pong, so it cannot be stored, not even by editing the
 * file by hand.
 *
 * ## ⚠️ The gang never fires on state it merely found
 *
 * `Session` replays the frames buffered during hydration without dispatching
 * them, so a page opening onto a desk already out of step does not rewrite it.
 * The gang acts on changes made while someone is watching, and that asymmetry
 * is deliberate: opening a browser tab is not an instruction to the switcher.
 */

import { dialectFor } from './dialect.js';
import { presetBanks } from './screens.js';
import { bankLetter, fittedLayers, readValue, writeCmd } from './properties.js';

/** The stored shape's version, so a later change can migrate rather than guess. */
export const GROUPS_VERSION = 1;

/**
 * How long a group ignores frames after it has fanned out, in milliseconds.
 *
 * Long enough to cover a memory recall's burst — measured at a few
 * milliseconds on both a simulator and an Aquilon C — and short enough that a
 * second deliberate change never runs into it. An operator cannot make two
 * decisions in four hundred milliseconds; a recall makes eight in five.
 */
export const SETTLE_MS = 400;

/**
 * How long a write we have sent is still expected back, in milliseconds.
 *
 * A device that accepts a write echoes it within milliseconds on a LAN; one
 * that refuses it says nothing at all, and that silence is what this bounds.
 * Ten seconds is far longer than any round trip and far shorter than a show.
 */
export const PENDING_TTL = 10000;

/* ------------------------------------------------------------------ model */

/**
 * @typedef {{id: string, layer: string}} Member
 *   A destination key (`S1`, `A2`) and a layer key (`1`, `NATIVE`).
 * @typedef {{id: string, name: string, gang: boolean, members: Member[]}} Group
 */

const isKey = (v) => typeof v === 'string' && /^[SA]\d+$/.test(v);
const layerKey = (v) => (v == null ? null : String(v).trim().toUpperCase() || null);

/** `S1/2` — the one spelling used as a member's identity everywhere here. */
export const memberKey = (m) => `${m.id}/${m.layer}`;

/**
 * Coerce whatever was on disk into a group list that cannot misbehave.
 *
 * Nothing is rejected outright: a stored file may have been hand-edited, and
 * refusing to start over one bad row would cost an operator their groups on a
 * show day. Bad rows are dropped, and the two rules that matter are imposed
 * rather than checked — ids are made unique, and a member that already belongs
 * to an earlier group is removed from this one.
 */
export function normalise(raw) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw && raw.groups) ? raw.groups : [];
  const groups = [];
  const seenId = new Set();
  /* Every member already claimed, by `S1/2`, so the at-most-one-group rule is
     applied across the whole file rather than within each group. */
  const claimed = new Set();

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;

    let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : newId();
    while (seenId.has(id)) id = newId();
    seenId.add(id);

    const members = [];
    const here = new Set();
    for (const m of Array.isArray(entry.members) ? entry.members : []) {
      if (!m || typeof m !== 'object') continue;
      const dest = typeof m.id === 'string' ? m.id.trim().toUpperCase() : '';
      const layer = layerKey(m.layer);
      if (!isKey(dest) || !layer) continue;
      const key = `${dest}/${layer}`;
      if (here.has(key) || claimed.has(key)) continue;
      here.add(key);
      claimed.add(key);
      members.push({ id: dest, layer });
    }

    groups.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Group',
      /* Ganging is what was asked for, so a group written without the flag —
         by an older build, or by hand — follows. Turning it off is the
         deliberate act, not turning it on. */
      gang: entry.gang !== false,
      members
    });
  }

  return { version: GROUPS_VERSION, groups };
}

/** A new group id. Random rather than sequential: two panels may add at once. */
export function newId() {
  return 'g' + Math.random().toString(36).slice(2, 9);
}

/**
 * Add a member to a group, taking it off whichever group held it before.
 *
 * The move is the point. A layer in two ganged groups is the one arrangement
 * that could oscillate, so joining a group is always a move and never a copy —
 * and the caller is told what it displaced so the panel can say so.
 *
 * @returns {{groups: Group[], movedFrom: Group|null}}
 */
export function addMember(groups, groupId, member) {
  const key = memberKey(member);
  let movedFrom = null;
  const next = groups.map((g) => {
    if (g.members.some((m) => memberKey(m) === key)) {
      if (g.id === groupId) return g;
      movedFrom = g;
      return { ...g, members: g.members.filter((m) => memberKey(m) !== key) };
    }
    if (g.id !== groupId) return g;
    return { ...g, members: [...g.members, { id: member.id, layer: member.layer }] };
  });
  /* The target may already have held it, in which case the map above changed
     nothing and this is a no-op rather than a duplicate. */
  return { groups: next, movedFrom };
}

/** Which group holds a layer, if any. */
export function groupOf(groups, member) {
  const key = memberKey(member);
  return groups.find((g) => g.members.some((m) => memberKey(m) === key)) || null;
}

/* -------------------------------------------------------------- resolving */

/**
 * The catalogue spec naming a layer's source, for whichever platform this is.
 *
 * Asked of the dialect rather than written down: the property is
 * `source.inputNum` on LivePremier and `source.input` on Midra 4K and Alta 4K,
 * and the enum members differ too — one offers stills and screens as layer
 * sources, the other offers sixteen inputs and a colour. Nothing in this file
 * names either.
 */
export function sourceSpec(store) {
  const dialect = dialectFor(store);
  if (!dialect) return null;
  return dialect.catalogue.layer.find((p) => p.id === dialect.sourceParam) || null;
}

/**
 * A group's members, each said to be real or not.
 *
 * A group outlives the configuration it was written against: a preconfig
 * change can take a screen out of service or drop a layer's scaler, and the
 * group still names it. `fitted: false` is how the panel greys a member out
 * and how `sourceCommands` knows to skip it — silently writing to a layer the
 * hardware does not have is a write the device accepts into nowhere.
 */
export function resolveMembers(store, group) {
  return (group.members || []).map((m) => {
    const layers = fittedLayers(store, m.id);
    return { ...m, fitted: layers.some((l) => l.key === m.layer) };
  });
}

/**
 * The writes that put one source on a set of layers.
 *
 * `mode` is `PROGRAM`, `PREVIEW`, or a literal buffer when the caller means
 * that buffer whatever role it is playing. Every target is resolved on its
 * own, because two screens are routinely on opposite letters for the same
 * role — see the note at the head of this file.
 *
 * Returns the commands and, separately, everything it would not write and
 * why. A caller that reports only the commands is hiding half the answer:
 * "sent to three layers" when one of them was refused mid-take is the kind of
 * quiet failure that is discovered on the output.
 *
 * @returns {{cmds: Array<{path: string[], value: any}>, refused: Array<{member: Member, why: string}>,
 *            unchanged: Member[], live: boolean}}
 */
export function sourceCommands(store, targets, source, mode) {
  const spec = sourceSpec(store);
  const out = { cmds: [], refused: [], unchanged: [], live: false };
  if (!spec) {
    for (const m of targets) out.refused.push({ member: m, why: 'no platform yet' });
    return out;
  }

  for (const member of targets) {
    const layers = fittedLayers(store, member.id);
    if (!layers.some((l) => l.key === member.layer)) {
      out.refused.push({ member, why: `${member.id} has no layer ${member.layer}` });
      continue;
    }

    const bank = bankLetter(store, member.id, mode);
    if (!bank.letter) {
      out.refused.push({ member, why: `${member.id} reports no ${String(mode).toLowerCase()} buffer` });
      continue;
    }
    /*
     * Mid-take, PROGRAM and PREVIEW name no buffer honestly — the device is
     * showing a mix of the two. A literal letter is still fine, because the
     * operator named the buffer rather than the role.
     */
    if (!bank.settled && (mode === 'PROGRAM' || mode === 'PREVIEW')) {
      out.refused.push({ member, why: `${member.id} is mid-take` });
      continue;
    }
    if (bank.live) out.live = true;

    const target = { id: member.id, bank: bank.letter, layer: member.layer };
    if (readValue(store, target, spec) === source) {
      out.unchanged.push(member);
      continue;
    }
    const cmd = writeCmd(target, spec, source, store);
    if (!cmd) {
      out.refused.push({ member, why: `${source} is not a source this platform offers` });
      continue;
    }
    out.cmds.push(cmd);
  }

  return out;
}

/* ------------------------------------------------------------------- gang */

/**
 * The live half: a group that follows whichever member was changed.
 *
 * Given the store, a way to read the current groups and a way to send, this
 * watches frames and writes the rest of a group into line. It holds no timer —
 * the settle window is read off the clock when a frame arrives — so an idle
 * gang costs nothing at all.
 *
 * `groups` is a function rather than a list because the panel edits them while
 * this is running, and an index built once would gang the arrangement the page
 * was opened with. The index is rebuilt whenever the group list or the
 * platform changes, which is cheap and is the only way it stays true.
 *
 * @param {{store: object, groups: () => Group[], send: Function,
 *          onActivity?: Function, now?: () => number}} opts
 */
export function createGang({ store, groups, send, onActivity = () => {}, now = () => Date.now() }) {
  /* path string -> {group, member, buffer}. Built from the dialect's own
     addresser, so there is no path pattern to match and nothing to re-spell
     when a platform keeps its layers somewhere else. */
  let index = new Map();
  let builtFor = null;
  /* group id -> the clock reading when it last fanned out. */
  const settling = new Map();
  /*
   * Writes we have put on the wire and not yet seen come back, as
   * `path -> {value, at}`. An echo is precisely a frame at a path we wrote
   * carrying the value we wrote, and dropping it is what stops a fan-out
   * producing a second round off its own first echo.
   */
  const pending = new Map();

  function rebuild() {
    const list = groups() || [];
    const dialect = dialectFor(store);
    const spec = sourceSpec(store);
    /* Cheap identity for "has anything changed that the index depends on":
       the platform, and every ganged member. */
    const stamp = JSON.stringify([
      dialect ? dialect.id : null,
      list.filter((g) => g.gang).map((g) => [g.id, g.members.map(memberKey)])
    ]);
    if (stamp === builtFor) return;
    builtFor = stamp;

    index = new Map();
    if (!dialect || !spec) return;
    for (const group of list) {
      if (!group.gang || group.members.length < 2) continue;
      for (const member of group.members) {
        for (const buffer of dialect.bufferKeys) {
          const path = dialect.layerParamPath(member.id, buffer, member.layer, spec.path);
          if (path) index.set(path.join('/'), { groupId: group.id, member, buffer });
        }
      }
    }
  }

  /**
   * One inbound frame.
   *
   * Returns what it did, which is what the panel's activity line reports and
   * what the tests assert on. A frame that is not a ganged layer's source
   * costs one map lookup and nothing else — and the device store is chatty
   * enough (timers alone are a frame a second) that this matters.
   */
  function onFrame(frame) {
    if (!frame || !Array.isArray(frame.path)) return null;
    rebuild();
    const key = frame.path.join('/');
    const hit = index.get(key);
    if (!hit) return null;

    /*
     * Our own write, coming back. Consumed rather than acted on — and
     * consumed either way, because a frame at that path with a *different*
     * value means the device has moved on from what we sent and the record
     * is stale.
     */
    const mine = pending.get(key);
    if (mine !== undefined) {
      pending.delete(key);
      if (mine.value === frame.value) return null;
    }

    const list = groups() || [];
    const group = list.find((g) => g.id === hit.groupId);
    if (!group) return null;

    /* The group is still coming into line from its own last fan-out, or from
       the burst that started it. See SETTLE_MS. */
    const last = settling.get(group.id);
    if (last != null && now() - last < SETTLE_MS) return null;

    /*
     * Which ROLE did that letter play on that screen? This is the conversion
     * the head of this file is about. Mid-take it has no answer, and a change
     * on LivePremier's third buffer has none either — `presetPrevious` is
     * neither program nor preview, and nothing follows from it.
     */
    const banks = presetBanks(store, hit.member.id);
    if (!banks.settled) {
      const report = { group, source: frame.value, sent: 0, refused: [{ member: hit.member, why: `${hit.member.id} is mid-take` }] };
      onActivity(report);
      return report;
    }
    const mode = hit.buffer === banks.program ? 'PROGRAM'
      : hit.buffer === banks.preview ? 'PREVIEW'
        : null;
    if (!mode) return null;

    const others = group.members.filter((m) => memberKey(m) !== memberKey(hit.member));
    if (!others.length) return null;

    const plan = sourceCommands(store, others, frame.value, mode);
    /* Marked before sending, not after: the echoes are already on their way
       back by the time the last command leaves. */
    settling.set(group.id, now());
    forgetStalePending();

    let sent = 0;
    for (const cmd of plan.cmds) {
      /* Recorded before the send, for the same reason. */
      pending.set(cmd.path.join('/'), { value: cmd.value, at: now() });
      if (send(cmd)) sent++;
    }

    const report = {
      group,
      from: hit.member,
      mode,
      source: frame.value,
      sent,
      unchanged: plan.unchanged,
      refused: plan.refused
    };
    if (sent || plan.refused.length) onActivity(report);
    return report;
  }

  /**
   * Drop records of writes whose echo never arrived.
   *
   * A device that refuses a write says nothing about it, so without this the
   * map would hold one entry per refusal for the life of the page. `PENDING_TTL`
   * is generous — the round trip is milliseconds on a LAN — because the only
   * cost of holding one too long is that one genuine repeat of the same value
   * to the same path is ignored.
   */
  function forgetStalePending() {
    const cutoff = now() - PENDING_TTL;
    for (const [path, entry] of pending) if (entry.at < cutoff) pending.delete(path);
  }

  /**
   * Tell the gang about writes someone else made, so it does not repeat them.
   *
   * The caller for this is the `…` menu sending a source to a whole group: it
   * has already written every member, so the echoes that follow are the group
   * arriving where it was sent rather than one member changing and the rest
   * needing to catch up. Without this the gang fires on the first echo and
   * writes the others a second time — harmless, since the value is the same,
   * but it is a write on the wire that nobody asked for and an activity line
   * claiming the gang did work the operator had already done.
   *
   * ⚠️ Only ever called when the **whole** group was written. A send to one
   * member that happens to be in a group must still be followed by the rest —
   * that is the feature — and registering that single write here would
   * silence exactly the case the gang exists for.
   */
  function expect(cmds) {
    forgetStalePending();
    for (const cmd of cmds || []) pending.set(cmd.path.join('/'), { value: cmd.value, at: now() });
  }

  return {
    onFrame,
    expect,
    /** Exposed for the tests and for a panel that wants to show the mapping. */
    size: () => { rebuild(); return index.size; },
    pending: () => pending.size
  };
}
