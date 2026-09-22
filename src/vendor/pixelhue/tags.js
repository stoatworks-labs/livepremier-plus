// Message tags (TLV2 command codes) the console's UCenter service uses on its WebSocket.
//
// Taken from the vendor's own clients: the on-screen keyboard app (ueckeyboard) and the
// Unico UI's `tag-whitelist.ts` / virtual-console constants. "Verified" here means the
// number appears in shipped code; none of these has been seen on the wire by this project.
//
// Report tags are pushed by the console without subscription — a client that connects
// with `?client-type=5` (what the on-screen keyboard uses) starts receiving them.

export const TAGS = Object.freeze({
  /** TLV1 code the keep-alive carries (the "request head"). */
  REQUEST_HEAD: 0x00102101,

  /** Key state report: array of {key, state, text, page, icon}. state 0 = down, 1 = up;
   *  other values are the key's business state (see docs/protocols.md). 1053441. */
  KEY_STATE: 0x00101301,

  /** Console T-bar report (Unico `panelTBarTag`). Body shape unverified. 1053444. */
  TBAR: 0x00101304,

  /** Console command/business data (Unico `panelKeyboardTag`, ueckeyboard TAG_CommandData):
   *  {layers, inputs, additionInfos, ...}. 1053447. */
  COMMAND_DATA: 0x00101307,

  /** Theme change (ueckeyboard TAG_THEMT). 1053450. */
  THEME: 0x0010130a,

  /** Key self-test report (ueckeyboard TAG_INSPECT). 1053480. */
  KEY_INSPECT: 0x00101328,

  /** Fader ("push rod") report/command: {adcValue, index}. 9442305. */
  FADER: 0x00901401,

  /** Encoder ("knob") report/command: {adcValue, index}. 9442304. */
  ENCODER: 0x00901400,

  /** Custom key configuration changed (ueckeyboard CONFIG_TAG). 9442054. */
  KEY_CONFIG: 0x00901406,
});

export const TAG_NAMES = Object.fromEntries(Object.entries(TAGS).map(([k, v]) => [v, k]));

/** Key-state values that mean a physical press/release rather than a business state. */
export const KEY_DOWN = 0;
export const KEY_UP = 1;

/** Business states of the console's "Companion" key. */
export const COMPANION_STATE = Object.freeze({ UNAVAILABLE: 649, OFF: 650, ON: 651 });
