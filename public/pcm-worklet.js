// AudioContext rate can be 44.1/48 kHz. Carry fractional input samples across
// process() calls so output time does not drift at 128-sample block boundaries.
class Pcm16kProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.inputPerOutput = sampleRate / 16000;
    this.remaining = this.inputPerOutput;
    this.sum = 0;
    this.weight = 0;
    this.frame = new Float32Array(640); // 40 ms at 16 kHz
    this.frameLength = 0;
  }

  emitFrame() {
    const bytes = new ArrayBuffer(this.frameLength * 2);
    const view = new DataView(bytes);
    for (let i = 0; i < this.frameLength; i++) {
      const value = Math.max(-1, Math.min(1, this.frame[i]));
      view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    this.port.postMessage(bytes, [bytes]);
    this.frameLength = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i];
      mono /= channels.length;
      let available = 1;
      while (available > 1e-8) {
        const taken = Math.min(available, this.remaining);
        this.sum += mono * taken;
        this.weight += taken;
        this.remaining -= taken;
        available -= taken;
        if (this.remaining <= 1e-8) {
          this.frame[this.frameLength++] = this.sum / this.weight;
          this.sum = this.weight = 0;
          this.remaining = this.inputPerOutput;
          if (this.frameLength === this.frame.length) this.emitFrame();
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm16k', Pcm16kProcessor);
