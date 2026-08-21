/*
 * MIDI bytes in, structured messages out — and back.
 *
 * Deliberately free of any port API. Web MIDI hands out Uint8Arrays and so
 * does node's usual binding, so the same codec serves the browser extension,
 * the local server and the tests, and a "controller" in a test is just an
 * array of bytes.
 */

export const NOTE_OFF = 0x80;
export const NOTE_ON = 0x90;
export const POLY_PRESSURE = 0xa0;
export const CONTROL_CHANGE = 0xb0;
export const PROGRAM_CHANGE = 0xc0;
export const CHANNEL_PRESSURE = 0xd0;
export const PITCH_BEND = 0xe0;
export const SYSEX = 0xf0;
export const SYSEX_END = 0xf7;

/**
 * Decode one MIDI message.
 *
 * Returns null for anything malformed or for realtime bytes, which a surface
 * has no use for and which would otherwise have to be filtered at every call
 * site. Running status is not handled: no controller in scope uses it on USB,
 * where every packet is already framed.
 */
export function decode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (!b.length || b[0] < 0x80) return null;
  if (b[0] === SYSEX) {
    const end = b[b.length - 1] === SYSEX_END ? b.length - 1 : b.length;
    return { type: 'sysex', data: Array.from(b.slice(1, end)) };
  }
  if (b[0] >= 0xf1) return null;

  const status = b[0] & 0xf0;
  const channel = b[0] & 0x0f;
  switch (status) {
    case NOTE_ON:
      /* A note-on at velocity 0 is a note-off. Surfaces do use this — treating
         it as a press would leave every button latched down. */
      return b[2] === 0
        ? { type: 'noteOff', channel, note: b[1], velocity: 0 }
        : { type: 'noteOn', channel, note: b[1], velocity: b[2] };
    case NOTE_OFF:
      return { type: 'noteOff', channel, note: b[1], velocity: b[2] ?? 0 };
    case CONTROL_CHANGE:
      return { type: 'cc', channel, controller: b[1], value: b[2] };
    case POLY_PRESSURE:
      return { type: 'polyPressure', channel, note: b[1], value: b[2] };
    case PROGRAM_CHANGE:
      return { type: 'programChange', channel, program: b[1] };
    case CHANNEL_PRESSURE:
      return { type: 'channelPressure', channel, value: b[1] };
    case PITCH_BEND:
      return { type: 'pitchBend', channel, value: (b[2] << 7) | b[1] };
    default:
      return null;
  }
}

/** Encode a structured message back to bytes. */
export function encode(msg) {
  const ch = (msg.channel ?? 0) & 0x0f;
  switch (msg.type) {
    case 'noteOn':
      return Uint8Array.from([NOTE_ON | ch, msg.note & 0x7f, (msg.velocity ?? 127) & 0x7f]);
    case 'noteOff':
      return Uint8Array.from([NOTE_OFF | ch, msg.note & 0x7f, (msg.velocity ?? 0) & 0x7f]);
    case 'cc':
      return Uint8Array.from([CONTROL_CHANGE | ch, msg.controller & 0x7f, msg.value & 0x7f]);
    case 'polyPressure':
      return Uint8Array.from([POLY_PRESSURE | ch, msg.note & 0x7f, msg.value & 0x7f]);
    case 'programChange':
      return Uint8Array.from([PROGRAM_CHANGE | ch, msg.program & 0x7f]);
    case 'channelPressure':
      return Uint8Array.from([CHANNEL_PRESSURE | ch, msg.value & 0x7f]);
    case 'pitchBend': {
      const v = Math.max(0, Math.min(16383, msg.value | 0));
      return Uint8Array.from([PITCH_BEND | ch, v & 0x7f, (v >> 7) & 0x7f]);
    }
    case 'sysex':
      return Uint8Array.from([SYSEX, ...msg.data, SYSEX_END]);
    default:
      throw new Error(`cannot encode ${msg.type}`);
  }
}

/**
 * A stable identity for the control a message came from.
 *
 * Value is deliberately excluded: a fader at 0 and the same fader at 127 must
 * produce the same id, because this is what a mapping is keyed on and what
 * MIDI-learn stores. Note-off shares its id with note-on for the same reason.
 */
export function controlId(msg) {
  switch (msg.type) {
    case 'noteOn':
    case 'noteOff':
      return `note:${msg.channel}:${msg.note}`;
    case 'cc':
      return `cc:${msg.channel}:${msg.controller}`;
    case 'pitchBend':
      return `pb:${msg.channel}`;
    case 'polyPressure':
      return `pp:${msg.channel}:${msg.note}`;
    case 'programChange':
      return `pc:${msg.channel}`;
    case 'channelPressure':
      return `cp:${msg.channel}`;
    default:
      return null;
  }
}

/** Parse a control id back into the fields needed to address it for feedback. */
export function parseControlId(id) {
  const [kind, a, b] = String(id).split(':');
  const channel = Number(a);
  switch (kind) {
    case 'note': return { kind, channel, note: Number(b) };
    case 'cc': return { kind, channel, controller: Number(b) };
    case 'pb': return { kind, channel };
    case 'pp': return { kind, channel, note: Number(b) };
    case 'pc': return { kind, channel };
    case 'cp': return { kind, channel };
    default: return null;
  }
}
