/*
 * Lightware, both generations, behind one driver.
 *
 * ⚠️ **READ THIS BEFORE TRUSTING A LINE OF IT.** Unlike the Videohub driver —
 * which is a port of code that was exercised against a working implementation
 * of its protocol — **nothing in this file has been run against a Lightware
 * frame.** It is written from Lightware's published protocol documentation.
 * The command spellings are collected in `LW3` and `LW2` below precisely so
 * that correcting them against a real frame is an edit to one table rather
 * than an archaeology expedition through the parser.
 *
 * Where this file is *defensive* — accepting several shapes of the same
 * answer, and polling even after subscribing — that is not belt and braces.
 * It is an admission: the exact framing of an unsolicited change differs
 * across the LW3 families (MX2, UBEX, Taurus UCX) and I cannot prove which
 * one a given frame sends. Polling makes the grid correct regardless, and the
 * subscription makes it fast when it works. Take the polling out only once a
 * real frame has shown you its push format.
 *
 * ## The two protocols are unrelated
 *
 * **LW2** (TCP 10001, legacy MX-series and older) is a terse ASCII protocol:
 * commands in braces, answers in parentheses.
 *
 * ```text
 *   {1@3}        route input 1 to output 3
 *   (O03 I01)    ...done
 * ```
 *
 * **LW3** (TCP 6107, everything current) is a property tree with typed
 * accessors. A crosspoint is a method call on a node, and the routing table is
 * one property holding a semicolon-separated list.
 *
 * ```text
 *   GET /MEDIA/VIDEO/XP.DestinationConnectionList
 *   pr /MEDIA/VIDEO/XP.DestinationConnectionList=I1;I1;I5;I2
 *   CALL /MEDIA/VIDEO/XP:switch(I3:O2)
 *   mO /MEDIA/VIDEO/XP:switch
 * ```
 *
 * In that list the *position* is the destination and the *value* is the
 * source: position 3 holding `I5` means output 3 is showing input 5. Both are
 * 1-based, which is the one mercy this file gets — no conversion, unlike the
 * Videohub.
 *
 * ## Which one am I talking to
 *
 * The port is a strong hint and not a promise, so the driver **asks**. On
 * connect it sends an LW3 read; an LW3 frame answers with a `pr`/`pw` line and
 * an LW2 frame does not. If nothing LW3-shaped arrives inside
 * `DETECT_TIMEOUT_MS`, it tries LW2's product query and listens for a
 * parenthesised answer. A frame that answers neither is reported as connected
 * but unidentified rather than guessed at, because guessing means sending
 * `{1@3}` at something that might take it as part of a different command.
 */

import { MatrixDriver, LineParser } from './driver.js';

/** LW3, TCP 6107. Every LW3 string this driver sends or matches. */
const LW3 = {
  port: 6107,
  productName: '/.ProductName',
  xp: '/MEDIA/VIDEO/XP',
  destinationList: '/MEDIA/VIDEO/XP.DestinationConnectionList',
  sourceCount: '/MEDIA/VIDEO/XP.SourcePortCount',
  destinationCount: '/MEDIA/VIDEO/XP.DestinationPortCount',
  switch: (input, output) => `CALL /MEDIA/VIDEO/XP:switch(I${input}:O${output})\n`,
  get: (path) => `GET ${path}\n`,
  open: (path) => `OPEN ${path}\n`,
};

/** LW2, TCP 10001. As above. */
const LW2 = {
  port: 10001,
  productType: '{i}\r\n',
  /* "View Crosspoint": the whole routing table in one answer. */
  viewCrosspoint: '{VC}\r\n',
  switch: (input, output) => `{${input}@${output}}\r\n`,
};

const DETECT_TIMEOUT_MS = 2500;

export class LightwareDriver extends MatrixDriver {
  static get kind() { return 'lightware'; }

  constructor(options) {
    super({ port: LW3.port, ...options });
    this.parser = new LineParser();
    /** 'lw3' | 'lw2' | null while still working it out. */
    this.dialect = options.protocol === 'lw2' || options.protocol === 'lw3' ? options.protocol : null;
    this.detectTimer = null;
    /* See the header: polled even when subscribed, on purpose. LW2 has no
       subscription at all, so it is the only thing keeping that half right. */
    this.pollMs = 5000;
  }

  onOpen() {
    this.parser = new LineParser();

    if (this.dialect === 'lw2') return this.startLw2();
    /* Either LW3 was configured, or we are detecting — both begin the same
       way, because an LW3 read is harmless to an LW2 frame (it answers with
       an error or with silence, and neither is a command). */
    this.startLw3();

    if (!this.dialect) {
      this.detectTimer = setTimeout(() => {
        this.detectTimer = null;
        if (this.dialect) return;
        this.log(`lightware ${this.id}: no LW3 answer, trying LW2`);
        this.startLw2();
      }, DETECT_TIMEOUT_MS);
      this.detectTimer.unref?.();
    }
  }

  startLw3() {
    this.write(LW3.get(LW3.productName));
    this.write(LW3.get(LW3.sourceCount));
    this.write(LW3.get(LW3.destinationCount));
    this.write(LW3.get(LW3.destinationList));
    /* Ask to be told about changes. If this family does not push, the poll
       below still keeps the grid honest. */
    this.write(LW3.open(LW3.xp));
  }

  startLw2() {
    this.write(LW2.productType);
    this.write(LW2.viewCrosspoint);
  }

  onPoll() {
    if (this.dialect === 'lw2') this.write(LW2.viewCrosspoint);
    else this.write(LW3.get(LW3.destinationList));
  }

  close() {
    if (this.detectTimer) clearTimeout(this.detectTimer);
    this.detectTimer = null;
    super.close();
  }

  onData(text) {
    let touched = false;
    for (const line of this.parser.push(text)) {
      if (this.handleLine(line.trim())) touched = true;
    }
    if (touched) this.changed();
  }

  handleLine(line) {
    if (!line) return false;

    /* ---- LW3 ----------------------------------------------------------- */

    /* `pr`/`pw` is a property; `o-`/`CHG` is a subscribed change. The families
       differ on which they push, so all four are read the same way. */
    const property = /^(?:CHG\s+|pr\s+|pw\s+|o[-s]\s+)(\S+?)=(.*)$/.exec(line);
    if (property) {
      this.settle('lw3');
      return this.applyLw3Property(property[1], property[2]);
    }

    if (/^m[OF]\s/.test(line)) {
      this.settle('lw3');
      if (line.startsWith('mF')) {
        /* A refused switch. Worth a line — it usually means a port number out
           of range or a lock, and the grid simply not moving is otherwise the
           only symptom. */
        this.log(`lightware ${this.id} refused: ${line}`);
      } else {
        /* A switch was accepted. The router does not volunteer the new table
           on every family, so ask. Still never written from our own request. */
        this.write(LW3.get(LW3.destinationList));
      }
      return false;
    }

    /* ---- LW2 ----------------------------------------------------------- */

    /* `(O03 I01)` — one crosspoint, the answer to a switch. */
    const single = /^\(\s*O(\d+)\s+I(\d+)\s*\)$/i.exec(line);
    if (single) {
      this.settle('lw2');
      this.current.routing[Number(single[1])] = Number(single[2]);
      this.current.outputs = Math.max(this.current.outputs, Number(single[1]));
      this.current.inputs = Math.max(this.current.inputs, Number(single[2]));
      return true;
    }

    /* `(ALL I01 I01 I05 I02)` — the whole table, position = destination. */
    const all = /^\(\s*ALL\s+(.*?)\s*\)$/i.exec(line);
    if (all) {
      this.settle('lw2');
      const sources = all[1].split(/\s+/).filter(Boolean);
      sources.forEach((token, i) => {
        const source = /^I?(\d+)/i.exec(token);
        if (source) this.current.routing[i + 1] = Number(source[1]);
      });
      this.current.outputs = Math.max(this.current.outputs, sources.length);
      this.current.inputs = Math.max(this.current.inputs, ...Object.values(this.current.routing));
      return true;
    }

    /* `(I: MX-FR17R)` — the product type, which is also proof of LW2. */
    const product = /^\(\s*I:\s*(.+?)\s*\)$/i.exec(line);
    if (product) {
      this.settle('lw2');
      this.current.model = product[1];
      if (!this.current.name) this.current.name = product[1];
      return true;
    }

    return false;
  }

  applyLw3Property(path, value) {
    if (path.endsWith(LW3.productName)) {
      this.current.model = value;
      if (!this.current.name) this.current.name = value;
      return true;
    }
    if (path.endsWith('.SourcePortCount')) {
      this.current.inputs = Number(value) || this.current.inputs;
      return true;
    }
    if (path.endsWith('.DestinationPortCount')) {
      this.current.outputs = Number(value) || this.current.outputs;
      return true;
    }
    if (path.endsWith('.DestinationConnectionList')) {
      /* Position is the destination, value the source. An entry may be empty
         or `0` for a destination with nothing on it — left absent rather than
         recorded as input 0, which does not exist. */
      const tokens = value.split(';');
      const routing = {};
      tokens.forEach((token, i) => {
        const match = /^I?(\d+)$/i.exec(token.trim());
        if (match && Number(match[1]) > 0) routing[i + 1] = Number(match[1]);
      });
      this.current.routing = routing;
      /* The list's own length is the destination count on families that do not
         serve DestinationPortCount. */
      this.current.outputs = Math.max(this.current.outputs, tokens.length);
      return true;
    }
    return false;
  }

  /** First identifiable answer decides, and stops the detection timer. */
  settle(dialect) {
    if (this.dialect === dialect) return;
    if (!this.dialect) {
      this.dialect = dialect;
      this.log(`lightware ${this.id} speaks ${dialect.toUpperCase()}`);
      if (this.detectTimer) { clearTimeout(this.detectTimer); this.detectTimer = null; }
      if (dialect === 'lw2') this.startLw2();
    }
  }

  describe() {
    return { ...super.describe(), protocol: this.dialect };
  }

  /** 1-based both sides, and no conversion — Lightware counts as we do. */
  route(output, input) {
    if (this.dialect === 'lw2') return this.write(LW2.switch(input, output));
    if (this.dialect === 'lw3') return this.write(LW3.switch(input, output));
    /* Not yet identified. Refusing is right: sending LW2 braces at an LW3
       frame, or the reverse, is how you find out what a parser does with
       garbage on a show day. */
    this.log(`lightware ${this.id}: refusing to route before the protocol is known`);
    return false;
  }
}
