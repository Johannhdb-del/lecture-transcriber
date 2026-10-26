// AudioWorklet: mic input (any sample rate) -> mono -> 16 kHz -> Int16 little endian.
// Posts an ArrayBuffer of 1600 samples (about 100 ms) to the main thread for every full frame.
// Loaded with audioContext.audioWorklet.addModule(new URL("./pcm-worklet.js", import.meta.url)).

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 1600;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global of the AudioWorkletGlobalScope (the context's rate).
    this.ratio = sampleRate / TARGET_RATE; // e.g. 3 for 48000, 2.75625 for 44100
    this.acc = 0; // sum of the input samples of the current output sample
    this.count = 0;
    this.phase = 0; // input samples consumed towards the next output sample
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;
    const channels = input.length;
    const len = input[0].length;
    for (let i = 0; i < len; i++) {
      let x = 0;
      for (let c = 0; c < channels; c++) x += input[c][i];
      this.acc += x / channels;
      this.count++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.acc / this.count)); // box filter over the window
        this.acc = 0;
        this.count = 0;
        this.frame[this.filled++] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
        if (this.filled === FRAME_SAMPLES) {
          const buf = this.frame.buffer;
          // Int16Array uses platform byte order; every browser target is little endian.
          this.port.postMessage(buf, [buf]);
          this.frame = new Int16Array(FRAME_SAMPLES);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-downsampler", PcmDownsampler);
