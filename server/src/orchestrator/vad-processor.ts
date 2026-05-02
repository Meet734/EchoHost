// Voice Activity Detection with sliding window probability smoother
// Frame size: 512 samples = 32ms at 16 kHz (Silero VAD requirement)

import { EventEmitter } from "node:events";
import type { VADConfig, VADResult } from "@echohost/shared";

export const VAD_FRAME_SIZE = 512 as const;
export const VAD_SAMPLE_RATE = 16_000 as const;

export const DEFAULT_VAD_CONFIG: VADConfig = {
  threshold: 0.4,
  windowSize: 6,
  minSpeechFrames: 3,
  silencePaddingFrames: 15,
};

type VADEvents = {
  "speech:start": [timestamp: number];
  "speech:end": [audioBuffer: Int16Array, startTimestamp: number];
  "probability": [result: VADResult];
};

export class VADProcessor extends EventEmitter<VADEvents> {
  private readonly _config: VADConfig;
  private readonly _probabilityWindow: number[];
  private _isSpeechActive = false;
  private _consecutiveSpeechFrames = 0;
  private _consecutiveSilenceFrames = 0;
  private _speechStartTimestamp = 0;

  private _speechBuffer: Int16Array[] = [];
  private _residual: Int16Array = new Int16Array(0);

  constructor(config: Partial<VADConfig> = {}) {
    super();
    this._config = { ...DEFAULT_VAD_CONFIG, ...config };
    this._probabilityWindow = new Array<number>(this._config.windowSize).fill(0);
  }

  // Process PCM chunk, emits "probability" per frame, "speech:start" and "speech:end"
  processChunk(pcm: Int16Array, timestamp: number): void {
    const combined = this._concat(this._residual, pcm);
    let offset = 0;

    while (offset + VAD_FRAME_SIZE <= combined.length) {
      const frame = combined.subarray(offset, offset + VAD_FRAME_SIZE);
      this._processFrame(frame, timestamp);
      offset += VAD_FRAME_SIZE;
    }

    this._residual = combined.subarray(offset);
  }

  // Flush residual and close open speech segment
  flush(): void {
    if (this._isSpeechActive) {
      this._endSpeech();
    }
    this._residual = new Int16Array(0);
  }

  reset(): void {
    this._isSpeechActive = false;
    this._consecutiveSpeechFrames = 0;
    this._consecutiveSilenceFrames = 0;
    this._speechStartTimestamp = 0;
    this._speechBuffer = [];
    this._residual = new Int16Array(0);
    this._probabilityWindow.fill(0);
  }

  get isSpeechActive(): boolean {
    return this._isSpeechActive;
  }

  private _processFrame(frame: Int16Array, timestamp: number): void {
    const rawProbability = this._inferProbability(frame);
    const smoothedProbability = this._updateWindow(rawProbability);
    const isSpeech = smoothedProbability >= this._config.threshold;

    const result: VADResult = {
      probability: smoothedProbability,
      isSpeech,
      frameTimestamp: timestamp,
    };

    this.emit("probability", result);

    if (isSpeech) {
      this._consecutiveSpeechFrames++;
      this._consecutiveSilenceFrames = 0;

      this._speechBuffer.push(new Int16Array(frame));

      if (
        !this._isSpeechActive &&
        this._consecutiveSpeechFrames >= this._config.minSpeechFrames
      ) {
        this._isSpeechActive = true;
        this._speechStartTimestamp = timestamp;
        // this._speechBuffer = [];
        this.emit("speech:start", timestamp);
        console.log(`[VAD] speech:start at ${timestamp} (consecutiveSpeechFrames=${this._consecutiveSpeechFrames}, prob=${smoothedProbability.toFixed(3)})`);
      }
    } else {
      this._consecutiveSilenceFrames++;
      this._consecutiveSpeechFrames = 0;

      if (this._isSpeechActive) {
        this._speechBuffer.push(new Int16Array(frame));

        if (
          this._consecutiveSilenceFrames >= this._config.silencePaddingFrames
        ) {
          console.log(`[VAD] consecutiveSilenceFrames ${this._consecutiveSilenceFrames} >= ${this._config.silencePaddingFrames}; ending speech`);
          this._endSpeech();
        } else if (this._consecutiveSilenceFrames % 5 === 0) {
          console.log(`[VAD] silence frames=${this._consecutiveSilenceFrames}/${this._config.silencePaddingFrames}`);
        }
      }
    }
  }

  private _endSpeech(): void {
    const fullAudio = this._mergeBuffers(this._speechBuffer);
    const startTimestamp = this._speechStartTimestamp;

    this._isSpeechActive = false;
    this._consecutiveSpeechFrames = 0;
    this._consecutiveSilenceFrames = 0;
    this._speechBuffer = [];

    console.log(`[VAD] _endSpeech() called. Emitting speech:end (samples=${fullAudio.length}, startTs=${startTimestamp})`);
    this.emit("speech:end", fullAudio, startTimestamp);
  }

  // Silero VAD inference placeholder (energy-based heuristic for dev)
  // PRODUCTION: Replace with ONNX Runtime inference
  private _inferProbability(frame: Int16Array): number {
    let sumSquares = 0;
    for (let i = 0; i < frame.length; i++) {
      const sample = frame[i] ?? 0;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / frame.length);
    // Divisor tuned for speech detection: 1500 provides good balance
    return Math.min(1.0, rms / 1500);
  }

  private _updateWindow(probability: number): number {
    this._probabilityWindow.shift();
    this._probabilityWindow.push(probability);
    const sum = this._probabilityWindow.reduce((a, b) => a + b, 0);
    return sum / this._probabilityWindow.length;
  }

  private _concat(a: Int16Array, b: Int16Array): Int16Array {
    if (a.length === 0) return b;
    if (b.length === 0) return a;
    const out = new Int16Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  private _mergeBuffers(buffers: Int16Array[]): Int16Array {
    const totalLength = buffers.reduce((acc, b) => acc + b.length, 0);
    const merged = new Int16Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
      merged.set(buf, offset);
      offset += buf.length;
    }
    return merged;
  }
}
