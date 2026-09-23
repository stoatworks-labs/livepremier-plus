/*
 * Timecode — the plugin's server half: timecode pushed in from outside.
 *
 * The browser can read MTC over Web MIDI and LTC off an audio input all by
 * itself, and does (`source.js`). This is the third way in: a generator on
 * another machine, a lighting desk, a script — anything that can make an HTTP
 * request — POSTs a timecode to `/__lpp/timecode` and every open page hears it
 * on `/__lpp/timecode/stream`.
 *
 * Held in memory and never written down. Timecode is a *now* value; a
 * position restored from disk at startup would be a lie about the present.
 */

/**
 * Accept a timecode in either of the two shapes a caller will reach for.
 *
 * `"01:02:03:04"` because that is what a person types and what most tools
 * print, with `;` before the frames meaning drop-frame as the industry spells
 * it; or the object form for anything generating it programmatically.
 *
 * Out-of-range fields are refused rather than clamped. A frame number of 40 is
 * a bug in whatever sent it, and a clamped 29 would hide it behind a plausible
 * value that a cue stack would then act on.
 */
export function normaliseTimecode(input) {
  let parts = input;
  if (typeof input === 'string' || typeof input?.timecode === 'string') {
    const text = typeof input === 'string' ? input : input.timecode;
    const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})([:;.])(\d{1,2})$/.exec(text.trim());
    if (!m) return null;
    parts = {
      hours: +m[1], minutes: +m[2], seconds: +m[3], frames: +m[5],
      dropFrame: m[4] === ';',
      rate: typeof input === 'object' ? input.rate : undefined
    };
  }
  if (!parts || typeof parts !== 'object') return null;

  const int = (v) => (Number.isInteger(v) ? v : null);
  const hours = int(parts.hours);
  const minutes = int(parts.minutes);
  const seconds = int(parts.seconds);
  const frames = int(parts.frames);
  if (hours === null || minutes === null || seconds === null || frames === null) return null;
  if (hours > 23 || minutes > 59 || seconds > 59 || frames > 59) return null;
  if (hours < 0 || minutes < 0 || seconds < 0 || frames < 0) return null;

  const rate = int(parts.rate);
  return {
    hours, minutes, seconds, frames,
    /* A rate the sender did not give is left null for the page to fill in from
       its own setting — the same thing LTC does, and for the same reason. */
    rate: rate && rate > 0 && rate <= 120 ? rate : null,
    dropFrame: parts.dropFrame === true
  };
}

export default function activate(ctx) {
  let last = null;
  /* A page that connects is told the last known position at once, so it does
     not sit blank until the next message. */
  const stream = ctx.stream('/stream', { onOpen: (first) => { if (last) first.send('timecode', last); } });

  ctx.route('GET', '/', (req, res, h) => h.json(200, { timecode: last }));
  const push = async (req, res, h) => {
    const tc = normaliseTimecode(await h.readJson(4096));
    if (!tc) throw new ctx.HttpError(400, 'expected {hours,minutes,seconds,frames} or "hh:mm:ss:ff"');
    last = tc;
    stream.send('timecode', tc);
    h.json(200, { ok: true, timecode: tc, listeners: stream.size });
  };
  ctx.route('PUT', '/', push);
  ctx.route('POST', '/', push);
}
