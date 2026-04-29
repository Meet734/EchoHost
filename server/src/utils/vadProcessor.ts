import * as ort from 'onnxruntime-node';
import * as path from 'path';
import * as fs from 'fs';

const SAMPLE_RATE           = 16_000;
const MODEL_FRAME_SIZE      = 512;
const LSTM_STATE_SIZE       = 64;        // Silero v5: h and c are each [2, 1, 64]
const INTERNAL_BUFFER_CAPACITY = 2048;
const SPEECH_THRESHOLD      = 0.5;
const SILENCE_THRESHOLD     = 0.35;     // hysteresis lower bound
const DEFAULT_MODEL_PATH    = path.resolve(__dirname, '../../models/silero_vad.onnx');

export interface VADResult {
  isSpeech: boolean;
  probability: number; // Silero output [0, 1]
  rmsDb: number;       // dBFS energy for the HUD
}

// Isolated per-session LSTM state — never shared across sessions
interface SessionState {
  h: Float32Array;          // hidden state  shape [2, 1, 64]
  c: Float32Array;          // cell state    shape [2, 1, 64]
  sampleBuffer: Float32Array;
  bufferFill: number;
  currentlySpeaking: boolean;
  lastResult: VADResult;
}

export class VADProcessor {
  private session: ort.InferenceSession | null = null;
  private sessionStates: Map<string, SessionState> = new Map();
  private modelPath: string;
  private initPromise: Promise<void> | null = null;

  constructor(modelPath: string = DEFAULT_MODEL_PATH) {
    this.modelPath = modelPath;
  }

  // Call once at server startup — idempotent
  async init(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      if (!fs.existsSync(this.modelPath)) {
        throw new Error(
          `[VADProcessor] Model not found: ${this.modelPath}\n` +
          `Download: https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx`,
        );
      }

      console.log(`[INFO] [VADProcessor] Loading model from ${this.modelPath}`);

      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['cpu'], // swap to 'cuda' on GPU nodes
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true,
        executionMode: 'sequential', // single-threaded: predictable latency
        logSeverityLevel: 3,
      });

      console.log('[SUCCESS] [VADProcessor] Model ready.');
    })();

    return this.initPromise;
  }

  // Call on session:start — allocates fresh zeroed LSTM state
  createSession(sessionId: string): void {
    if (this.sessionStates.has(sessionId)) {
      console.warn(`[WARN] [VADProcessor] Resetting existing session ${sessionId}`);
    }
    this.sessionStates.set(sessionId, {
      h: new Float32Array(2 * 1 * LSTM_STATE_SIZE), // all zeros
      c: new Float32Array(2 * 1 * LSTM_STATE_SIZE),
      sampleBuffer: new Float32Array(INTERNAL_BUFFER_CAPACITY),
      bufferFill: 0,
      currentlySpeaking: false,
      lastResult: { isSpeech: false, probability: 0, rmsDb: -96 },
    });
  }

  // Call on session:end — frees LSTM memory
  destroySession(sessionId: string): void {
    this.sessionStates.delete(sessionId);
  }

  // Process one 20 ms PCM-S16LE packet (320 samples, 640 bytes)
  // Accumulates chunks until 512 samples are ready, then runs inference
  async process(sessionId: string, pcmBuffer: Buffer): Promise<VADResult> {
    if (!this.session) {
      throw new Error('[VADProcessor] Not initialised — call init() first.');
    }

    let state = this.sessionStates.get(sessionId);
    if (!state) {
      this.createSession(sessionId);
      state = this.sessionStates.get(sessionId)!;
    }

    const float32 = pcmS16leToFloat32(pcmBuffer);
    const rmsDb   = calculateRmsDb(float32);

    // Soft overflow guard: drain oldest samples instead of crashing
    const free = state.sampleBuffer.length - state.bufferFill;
    if (float32.length > free) {
      const drain = float32.length - free;
      console.warn(
        `[WARN] [VADProcessor] Buffer near-full for session ${sessionId}. ` +
        `Draining ${drain} stale samples.`,
      );
      state.sampleBuffer.copyWithin(0, drain, state.bufferFill);
      state.bufferFill = Math.max(0, state.bufferFill - drain);
    }

    state.sampleBuffer.set(float32, state.bufferFill);
    state.bufferFill += float32.length;

    // Not enough samples for a full frame yet
    if (state.bufferFill < MODEL_FRAME_SIZE) {
      return { ...state.lastResult, rmsDb };
    }

    // Drain the accumulation buffer frame-by-frame
    let latestResult: VADResult = { ...state.lastResult, rmsDb };
    while (state.bufferFill >= MODEL_FRAME_SIZE) {
      const inputFrame = state.sampleBuffer.slice(0, MODEL_FRAME_SIZE);
      latestResult = await this.runInference(state, inputFrame, rmsDb);

      const remaining = state.bufferFill - MODEL_FRAME_SIZE;
      if (remaining > 0) {
        state.sampleBuffer.copyWithin(0, MODEL_FRAME_SIZE, state.bufferFill);
      }
      state.bufferFill = remaining;
    }

    state.lastResult = latestResult;
    return latestResult;
  }

  private async runInference(
    state: SessionState,
    frame: Float32Array,
    rmsDb: number,
  ): Promise<VADResult> {
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor('float32', frame,   [1, MODEL_FRAME_SIZE]),
      sr:    new ort.Tensor('int64',   BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]),
      h:     new ort.Tensor('float32', state.h, [2, 1, LSTM_STATE_SIZE]),
      c:     new ort.Tensor('float32', state.c, [2, 1, LSTM_STATE_SIZE]),
    };

    const results = await this.session!.run(feeds);

    // Persist recurrent state for the next frame
    state.h = results['hn'].data as Float32Array;
    state.c = results['cn'].data as Float32Array;

    const probability = (results['output'].data as Float32Array)[0];

    // Hysteresis prevents rapid toggling at the decision boundary
    let isSpeech: boolean;
    if (state.currentlySpeaking) {
      isSpeech = probability >= SILENCE_THRESHOLD;
    } else {
      isSpeech = probability >= SPEECH_THRESHOLD;
    }
    state.currentlySpeaking = isSpeech;

    return { isSpeech, probability, rmsDb };
  }

  async dispose(): Promise<void> {
    this.sessionStates.clear();
    if (this.session) {
      await (this.session as any).release?.();
      this.session = null;
    }
  }
}

// PCM-S16LE Buffer → normalised Float32 [-1, +1]
export function pcmS16leToFloat32(buf: Buffer): Float32Array {
  const samples = buf.byteLength >> 1;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = buf.readInt16LE(i * 2) / 32768.0;
  }
  return out;
}

// RMS energy in dBFS — returns -96 for silence
export function calculateRmsDb(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / samples.length);
  if (rms < 1e-9) return -96;
  return 20 * Math.log10(rms);
}

// Shared singleton — init once in index.ts before accepting connections
export const vadProcessor = new VADProcessor();
