/*
 * An audio worklet that decodes nothing.
 *
 * It forwards mono sample blocks to the main thread and stops there, on
 * purpose. A worklet runs in its own realm with no module imports — `addModule`
 * loads a classic script — so decoding in here would mean a second copy of
 * `core/timecode.js` living in a file nobody would remember to keep in step.
 * One decoder, fed from wherever the samples come from, is worth the postMessage.
 *
 * 48 kHz of mono Float32 is about 190 KB/s across the port, which is nothing
 * next to the device store this app already mirrors.
 */
class LtcTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    /* No input connected yet, or a block of silence the graph skipped. */
    if (channel && channel.length) this.port.postMessage(channel.slice());
    /* Keep the node alive even when the source is briefly silent. */
    return true;
  }
}

registerProcessor('lpp-ltc-tap', LtcTapProcessor);
