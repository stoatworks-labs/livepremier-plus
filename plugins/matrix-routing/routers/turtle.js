/*
 * Turtle AV, the ASCII command set. TCP 8000.
 *
 * Written from *8x8 4K60 VIDEOWALL AND MULTIVIEW — User Manual* (Turtle AV,
 * 2025; device type `HDP-MXB88VW`), section 10, "RS-232 Control Command".
 * **Not verified against a unit.** The same warning the Lightware driver
 * carries applies here, with one thing in its favour: this protocol is small
 * enough to read in full, and the manual gives an example and a feedback
 * string for every command.
 *
 * ## The wire
 *
 * ASCII, one command per line, **terminated by `!`** rather than by the
 * newline — which is the detail that catches anyone who sees "ASCII" and
 * reaches for a line codec. Answers are plain English lines.
 *
 * ```text
 *   s output 1 in source 3!      route input 3 to output 1
 *   output 1->input 3
 *
 *   r output 0 in source!        ask about every output (0 = all)
 *   output 1->input 3
 *   output 2->input 2
 *   ...
 * ```
 *
 * **`0` means "all"** in the output position, on both the read and the write.
 * That is how the whole table is fetched, and it is also a live grenade: `s
 * output 0 in source 1!` puts input 1 on every output at once. Nothing in this
 * driver ever sends output 0 as a write, and `route()` rejects it, because the
 * only way to reach it is a bug in the caller — `core/patch.js` counts
 * destinations from 1.
 *
 * Errors come back as a bare code: `E00` unknown command, `E01` parameter out
 * of range, `E02` bad EDID data.
 *
 * ## It volunteers nothing, so it is polled
 *
 * The manual documents a reply for every command and no unsolicited output. A
 * route taken at the front panel or in the web GUI is therefore invisible here
 * until the next poll — a real limitation of the protocol, stated in the UI,
 * not hidden.
 *
 * ## How big is it
 *
 * The device does not serve a port count. Two sources, in this order:
 *
 * 1. **The routing reply.** `r output 0 in source!` answers one line per
 *    output, so counting them is authoritative for the output side.
 * 2. **The model name.** `r type!` answers `HDP-MXB88VW`, in which `88` is
 *    8 in by 8 out. An even run of digits is split down the middle; an odd one
 *    is not guessed at. This is a *hint* and is only ever used to fill in the
 *    input count, which the routing reply cannot give — an input nothing is
 *    routed to never appears in it.
 */

import { MatrixDriver, LineParser } from './driver.js';

const CMD = {
  type: 'r type!',
  allRoutes: 'r output 0 in source!',
  route: (output, input) => `s output ${output} in source ${input}!`,
};

export class TurtleDriver extends MatrixDriver {
  static get kind() { return 'turtle'; }

  constructor(options) {
    super({ port: 8000, ...options });
    this.parser = new LineParser();
    /* Nothing is pushed. See the header. */
    this.pollMs = 4000;
    /* Lines seen since the last `output N->input M` run started, so a full
       reply can be counted as a table rather than folded in one line at a
       time — the count of outputs is the length of the run. */
    this.runLength = 0;
  }

  onOpen() {
    this.parser = new LineParser();
    this.write(CMD.type + '\n');
    this.write(CMD.allRoutes + '\n');
  }

  onPoll() { this.write(CMD.allRoutes + '\n'); }

  onData(text) {
    let touched = false;
    for (const line of this.parser.push(text)) {
      if (this.handleLine(line.trim())) touched = true;
    }
    if (touched) this.changed();
  }

  handleLine(line) {
    if (!line) return false;

    /* `output 1->input 3`, with or without spaces around the arrow. */
    const route = /^output\s+(\d+)\s*->\s*input\s+(\d+)$/i.exec(line);
    if (route) {
      const output = Number(route[1]);
      const input = Number(route[2]);
      this.current.routing[output] = input;
      this.current.outputs = Math.max(this.current.outputs, output);
      this.current.inputs = Math.max(this.current.inputs, input);
      return true;
    }

    /* `HDP-MXB88VW` — the answer to `r type!`, and the only size hint there is. */
    if (/^[A-Z0-9-]+$/i.test(line) && /MXB\d+/i.test(line)) {
      this.current.model = line;
      if (!this.current.name) this.current.name = line;
      const size = sizeFromModel(line);
      if (size) {
        this.current.inputs = Math.max(this.current.inputs, size.inputs);
        this.current.outputs = Math.max(this.current.outputs, size.outputs);
      }
      return true;
    }

    const error = /^E0(\d)$/.exec(line);
    if (error) {
      const why = { 0: 'unknown command', 1: 'parameter out of range', 2: 'bad EDID data' }[error[1]]
        ?? 'unknown error';
      this.lastError = `${line}: ${why}`;
      this.log(`turtle ${this.id} answered ${line} (${why})`);
      return true;
    }

    /* Everything else — boot banners, `power on`, fan and lcd chatter — is
       ignored. The device narrates a great deal and none of it is routing. */
    return false;
  }

  /** 1-based, and output 0 is refused. See the header. */
  route(output, input) {
    if (!Number.isInteger(output) || output < 1) {
      this.log(`turtle ${this.id}: refusing output ${output} — 0 would route every output at once`);
      return false;
    }
    if (!Number.isInteger(input) || input < 1) return false;
    const sent = this.write(CMD.route(output, input) + '\n');
    /* The device answers a write with the new crosspoint, so the state comes
       back on its own. Nothing is written locally. */
    return sent;
  }
}

/**
 * `HDP-MXB88VW` -> `{inputs: 8, outputs: 8}`; `…MXB1616…` -> 16x16.
 *
 * An odd-length digit run is ambiguous (`168` is 16x8 or 1x68) so it returns
 * null rather than picking one. A hint that is sometimes absent is fine; a
 * hint that is sometimes wrong is not.
 */
export function sizeFromModel(model) {
  const match = /MXB(\d+)/i.exec(String(model));
  if (!match) return null;
  const digits = match[1];
  if (digits.length % 2 !== 0) return null;
  const half = digits.length / 2;
  const inputs = Number(digits.slice(0, half));
  const outputs = Number(digits.slice(half));
  if (!inputs || !outputs) return null;
  return { inputs, outputs };
}
