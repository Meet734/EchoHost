/**
 * EchoHost PCM AudioWorklet
 * Runs in the browser's dedicated audio thread.
 * Downsamples from the AudioContext sample rate (44100/48000) to 16000 Hz.
 * Accumulates samples into 512-sample frames, converts Float32 → Int16,
 * and posts raw Int16 ArrayBuffers to the main thread via zero-copy transfer.
 */

const TARGET_SAMPLE_RATE = 16000;
const FRAME_SIZE = 512; // 32ms at 16kHz — matches Silero VAD frame size

class EchoHostPCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._inputSampleRate = sampleRate; // AudioWorkletGlobalScope.sampleRate
    this._buffer = [];
    this._downsampleRatio = this._inputSampleRate / TARGET_SAMPLE_RATE;
    this._inputIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0];
    if (!channelData || channelData.length === 0) return true;

    // Simple averaging downsampler (adequate for speech)
    const ratio = this._downsampleRatio;
    const outputLength = Math.floor(channelData.length / ratio);

    for (let i = 0; i < outputLength; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.floor((i + 1) * ratio);
      let sum = 0;
      let count = 0;
      for (let j = start; j < end && j < channelData.length; j++) {
        sum += channelData[j];
        count++;
      }
      this._buffer.push(count > 0 ? sum / count : 0);
    }

    // Emit complete FRAME_SIZE chunks
    while (this._buffer.length >= FRAME_SIZE) {
      const frame = this._buffer.splice(0, FRAME_SIZE);
      const int16 = new Int16Array(FRAME_SIZE);
      for (let i = 0; i < FRAME_SIZE; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        int16[i] = s < 0 ? s * 32768 : s * 32767;
      }
      // Zero-copy transfer — int16.buffer is neutered after this
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('echohost-pcm-worklet', EchoHostPCMWorklet);
