/*
 * Blackmagic Videohub Ethernet Protocol, client side. TCP 9990.
 *
 * ## Provenance
 *
 * The block parser and the handling below are a port of the client in
 * **BlackMatrix** (`packages/videohub/src/{client,protocol}.ts`,
 * stoatworks-labs/blackmatrix), which is this author's own and where the
 * protocol was actually exercised — against a real ATEM fleet serving the
 * protocol, a raw TCP client and telnet. It is a port and not a dependency
 * because that repo is TypeScript with a build step and this one is plain ESM
 * with none, deliberately; and because two of the three drivers here have no
 * upstream at all, so a shared package would carry one of three.
 *
 * ⚠️ **What has never happened, there or here: a real Videohub.** BlackMatrix's
 * README says so in as many words and it is still true. The protocol is
 * implemented from Blackmagic's published "Videohub Developer Information"
 * (v2.3, May 2018) and proven against an emulation of it. Prove it on your own
 * router before a show.
 *
 * ## The wire
 *
 * Blocks: an ALL-CAPS header ending in a colon, zero or more lines, a blank
 * line. A block with no lines is a request for a dump; a block with lines is a
 * status update — and clients ask for changes in exactly the form the server
 * reports them, which is why one parser serves both directions.
 *
 * ```text
 *   VIDEO OUTPUT ROUTING:
 *   0 3
 *
 * ```
 *
 * ## ⚠️ The zero-based trap
 *
 * **The Videohub wire counts from 0 and everything else in this app counts
 * from 1.** Output 1 on the front panel is `0` in that block. This file is the
 * only place in the repo that knows it — `core/patch.js` says so, and the
 * conversion happens in exactly two places below, both marked. Getting it
 * wrong routes a real crosspoint one off from the one asked for, which is a
 * mistake nobody spots until it is on a screen.
 *
 * ## Refusals are silent by design
 *
 * A route the router will not make is answered with ACK and then the
 * *unchanged* routing — not NAK, which means it did not understand. So a
 * refusal is indistinguishable from a command that never arrived, except that
 * the state does not move. That is the protocol's own choice and the reason
 * the driver layer never writes its own state.
 */

import { MatrixDriver, emptyState } from './driver.js';

export class VideohubDriver extends MatrixDriver {
  static get kind() { return 'videohub'; }

  constructor(options) {
    super({ port: 9990, ...options });
    this.header = null;
    this.lines = [];
    this.buffer = '';
    /* The Videohub pushes every change, so there is nothing to poll. */
    this.pollMs = 0;
  }

  onOpen() {
    /* Nothing to ask for: a Videohub dumps its whole state on connect. */
    this.buffer = '';
    this.header = null;
    this.lines = [];
  }

  onIdle() { this.write('PING:\n\n'); }

  onData(text) {
    this.buffer += text;
    let index;
    let touched = false;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const raw = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (this.header === null) {
        if (line.trim() === '') continue;
        this.header = normaliseHeader(line);
        this.lines = [];
        continue;
      }
      if (line.trim() === '') {
        if (this.handleBlock(this.header, this.lines)) touched = true;
        this.header = null;
        this.lines = [];
        continue;
      }
      this.lines.push(line);
    }
    if (touched) this.changed();
  }

  /** @returns {boolean} whether anything worth redrawing changed. */
  handleBlock(header, lines) {
    switch (header) {
      case 'PROTOCOL PREAMBLE':
        return false;

      case 'VIDEOHUB DEVICE': {
        const present = (field(lines, 'Device present') ?? 'false').trim();
        if (present !== 'true') {
          /* "false" or "needs_update": nothing further will arrive until that
             is fixed, so say it rather than showing an empty grid that looks
             like a small router. */
          this.lastError = `router reports device present: ${present}`;
          this.log(`videohub ${this.id}: device present: ${present}`);
          this.current = emptyState();
          return true;
        }
        this.lastError = null;
        this.current.model = field(lines, 'Model name') ?? '';
        this.current.name = field(lines, 'Friendly name') ?? this.current.model;
        this.current.inputs = int(field(lines, 'Video inputs')) ?? this.current.inputs;
        this.current.outputs = int(field(lines, 'Video outputs')) ?? this.current.outputs;
        return true;
      }

      case 'INPUT LABELS':
        applyIndexed(this.current.inputLabels, lines);
        return true;
      case 'OUTPUT LABELS':
        applyIndexed(this.current.outputLabels, lines);
        return true;

      case 'VIDEO OUTPUT ROUTING':
        for (const line of lines) {
          const parsed = parseIndexed(line);
          if (!parsed) continue;
          const source = Number(parsed.value.trim());
          if (!Number.isInteger(source)) continue;
          /* ⚠️ ZERO-BASED IN, ONE-BASED OUT — conversion 1 of 2. */
          this.current.routing[parsed.index + 1] = source + 1;
        }
        return true;

      case 'VIDEO OUTPUT LOCKS':
        for (const line of lines) {
          const parsed = parseIndexed(line);
          if (!parsed) continue;
          /* O = ours, L = somebody else's, U = nobody's. Only L can stop us. */
          this.current.locks[parsed.index + 1] = parsed.value.trim().toUpperCase();
        }
        return true;

      case 'ACK':
        /* Receipt, not success. Deliberately nothing. */
        return false;
      case 'NAK':
        this.log(`videohub ${this.id} answered NAK — a port out of range, or a block it does not have`);
        return false;

      default:
        /* Unknown blocks are read to their blank line and ignored, as the
           spec asks — later firmwares add blocks and must not break us. */
        return false;
    }
  }

  /** 1-based in, as everywhere in this app. */
  route(output, input) {
    /* ⚠️ ONE-BASED IN, ZERO-BASED OUT — conversion 2 of 2. */
    return this.write(`VIDEO OUTPUT ROUTING:\n${output - 1} ${input - 1}\n\n`);
  }
}

function normaliseHeader(line) {
  const trimmed = line.trim();
  const withoutColon = trimmed.endsWith(':') ? trimmed.slice(0, -1) : trimmed;
  return withoutColon.toUpperCase();
}

function field(lines, name) {
  const prefix = `${name}:`;
  const line = lines.find((c) => c.startsWith(prefix));
  return line?.slice(prefix.length).trim();
}

/** `<index> <value>`; the value may contain spaces, because labels do. */
function parseIndexed(line) {
  const match = /^\s*(\d+)\s?(.*)$/.exec(line);
  if (!match) return null;
  return { index: Number(match[1]), value: match[2] ?? '' };
}

/* Status updates carry only what changed, so every apply is a sparse write
   into what we already hold — never a replacement. */
function applyIndexed(target, lines) {
  for (const line of lines) {
    const parsed = parseIndexed(line);
    if (parsed) target[parsed.index + 1] = parsed.value;
  }
}

const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};
