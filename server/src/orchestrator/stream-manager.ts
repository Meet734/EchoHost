// Per-session orchestrator for the speech-to-speech pipeline
// One instance per WebSocket connection — manages FSM, audio buffer, and service coordination

import { randomUUID } from "node:crypto";
import type { Socket } from "socket.io";
import {
  PipelineState,
  ErrorCode,
  AUDIO_HEADER_BYTES,
  PROTOCOL_VERSION,
  type ServerToClientEvents,
  type ClientToServerEvents,
  type TurnLatency,
  type TelemetrySnapshot,
  type ToolCall,
} from "@echohost/shared";

import { PipelineFSM, FsmError } from "./fsm.js";
import { AudioRingBuffer } from "./audio-buffer.js";
import { VADProcessor, DEFAULT_VAD_CONFIG } from "./vad-processor.ts";
import type { ASRService } from "../services/asr-service.js";
import type { ReasoningEngine } from "../services/reasoning-engine.js";
import type { TTSService } from "../services/tts-service.js";

export interface StreamManagerServices {
  readonly asr: ASRService;
  readonly reasoning: ReasoningEngine;
  readonly tts: TTSService;
}

interface TurnMetrics {
  speechEndTime: number;
  asrStartTime: number;
  asrEndTime: number;
  llmStartTime: number;
  llmEndTime: number;
  ttsFirstByteTime: number;
  vadDetectedAt: number;
}

// 60 seconds of audio at 16 kHz
const RING_BUFFER_CAPACITY = 16_000 * 60;

export class StreamManager {
  public readonly sessionId: string;

  private readonly _fsm: PipelineFSM;
  private readonly _ringBuffer: AudioRingBuffer;
  private readonly _vad: VADProcessor;
  private readonly _socket: Socket<ClientToServerEvents, ServerToClientEvents>;
  private readonly _services: StreamManagerServices;

  private _turnNumber = 0;
  private _currentToolCalls: ToolCall[] = [];
  private _currentTranscript = "";
  private _currentResponse = "";
  private _metrics: Partial<TurnMetrics> = {};
  private _isDisposed = false;

  private readonly _cleanupFns: Array<() => void> = [];

  constructor(
    socket: Socket<ClientToServerEvents, ServerToClientEvents>,
    services: StreamManagerServices
  ) {
    this.sessionId = randomUUID();
    this._socket = socket;
    this._services = services;

    this._fsm = new PipelineFSM(this.sessionId);
    this._ringBuffer = new AudioRingBuffer(RING_BUFFER_CAPACITY);
    this._vad = new VADProcessor(DEFAULT_VAD_CONFIG);

    this._wireUpFSMBroadcast();
    this._wireUpVAD();
  }

  // Called once on "session:start"
  start(clientVersion: string): void {
    this._assertNotDisposed();

    if (clientVersion !== PROTOCOL_VERSION) {
      this._emitError(
        ErrorCode.PROTOCOL_VERSION_MISMATCH,
        `Client version ${clientVersion} !== server version ${PROTOCOL_VERSION}`
      );
      return;
    }

    this._fsm.transition(PipelineState.LISTENING);

    this._socket.emit("session:ready", {
      sessionId: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  // Decode wire format: [seq: Uint32][capturedAt: Float64][pcm: Int16[]]
  handleAudioChunk(packet: ArrayBuffer): void {
    if (this._isDisposed) return;
    if (!this._fsm.is(PipelineState.LISTENING)) return;

    if (packet.byteLength <= AUDIO_HEADER_BYTES) return;

    const view = new DataView(packet);
    const capturedAt = view.getFloat64(4, true);
    const pcmBytes = packet.byteLength - AUDIO_HEADER_BYTES;
    const pcm = new Int16Array(packet, AUDIO_HEADER_BYTES, pcmBytes / 2);

    this._ringBuffer.write(pcm);
    this._vad.processChunk(pcm, capturedAt);
  }

  // Interrupt TTS playback (barge-in)
  handleInterrupt(): void {
    if (this._isDisposed) return;
    if (this._fsm.is(PipelineState.SPEAKING)) {
      this._services.tts.abort(this.sessionId);
      this._fsm.transition(PipelineState.IDLE);
      this._fsm.transition(PipelineState.LISTENING);
    }
  }

  // Graceful teardown
  async dispose(): Promise<void> {
    if (this._isDisposed) return;
    this._isDisposed = true;

    if (this._fsm.is(PipelineState.SPEAKING)) {
      this._services.tts.abort(this.sessionId);
    }

    this._vad.flush();
    this._ringBuffer.reset();

    for (const cleanup of this._cleanupFns) {
      cleanup();
    }
  }

  private _wireUpFSMBroadcast(): void {
    const unsub = this._fsm.onTransition((event) => {
      this._socket.emit("pipeline:state", event);
    });
    this._cleanupFns.push(unsub);
  }

  private _wireUpVAD(): void {
    this._vad.on("probability", (result) => {
      this._socket.emit("vad:probability", {
        probability: result.probability,
        isSpeech: result.isSpeech,
      });
    });

    this._vad.on("speech:start", (timestamp) => {
      this._metrics.vadDetectedAt = timestamp;
      if (this._fsm.is(PipelineState.SPEAKING)) {
        this.handleInterrupt();
      }
      this._fsm.tryTransition(PipelineState.LISTENING, PipelineState.VAD_ACTIVE);
    });

    this._vad.on("speech:end", (audioBuffer, startTimestamp) => {
      if (!this._fsm.is(PipelineState.VAD_ACTIVE)) return;
      this._metrics.speechEndTime = Date.now();
      this._runPipeline(audioBuffer, startTimestamp).catch((err) => {
        this._handlePipelineError(err);
      });
    });
  }

  // Core pipeline: VAD_ACTIVE → TRANSCRIBING → REASONING → SPEAKING → IDLE
  private async _runPipeline(
    audioBuffer: Int16Array,
    _speechStartTimestamp: number
  ): Promise<void> {
    this._assertNotDisposed();
    this._turnNumber++;
    this._currentToolCalls = [];
    this._currentTranscript = "";
    this._currentResponse = "";

    // Phase: TRANSCRIBING
    this._fsm.transition(PipelineState.TRANSCRIBING);
    this._metrics.asrStartTime = Date.now();

    const transcript = await this._services.asr.transcribe(
      audioBuffer,
      this.sessionId,
      (partial) =>
        this._socket.emit("asr:partial", { text: partial, sessionId: this.sessionId })
    );

    this._metrics.asrEndTime = Date.now();
    this._currentTranscript = transcript;
    this._socket.emit("asr:final", { text: transcript, sessionId: this.sessionId });

    // Phase: REASONING
    this._fsm.transition(PipelineState.REASONING);
    this._metrics.llmStartTime = Date.now();

    const { response, intent, toolCalls } = await this._services.reasoning.reason(
      transcript,
      this.sessionId,
      (toolCall) => {
        this._currentToolCalls.push(toolCall);
      }
    );

    this._metrics.llmEndTime = Date.now();
    this._currentResponse = response;
    this._socket.emit("reasoning:intent", intent);

    // Phase: SPEAKING
    this._fsm.transition(PipelineState.SPEAKING);
    this._metrics.ttsFirstByteTime = 0;

    await this._services.tts.synthesize(response, this.sessionId, (audioChunk) => {
      if (this._metrics.ttsFirstByteTime === 0) {
        this._metrics.ttsFirstByteTime = Date.now();
      }
      this._socket.emit("tts:audio_chunk", audioChunk);
    });

    this._socket.emit("tts:complete", { sessionId: this.sessionId });

    // Phase: IDLE + Telemetry
    this._fsm.transition(PipelineState.IDLE);
    this._fsm.transition(PipelineState.LISTENING);
    this._emitTelemetry(toolCalls);
  }

  private _emitTelemetry(toolCalls: ToolCall[]): void {
    const m = this._metrics;
    if (
      !m.speechEndTime ||
      !m.asrStartTime ||
      !m.asrEndTime ||
      !m.llmStartTime ||
      !m.llmEndTime ||
      !m.ttsFirstByteTime ||
      !m.vadDetectedAt
    ) {
      return;
    }

    const latency: TurnLatency = {
      vadMs: m.speechEndTime - m.vadDetectedAt,
      asrMs: m.asrEndTime - m.asrStartTime,
      llmMs: m.llmEndTime - m.llmStartTime,
      ttsFirstByteMs: m.ttsFirstByteTime - m.llmEndTime,
      totalRoundTripMs: m.ttsFirstByteTime - m.speechEndTime,
    };

    const snapshot: TelemetrySnapshot = {
      sessionId: this.sessionId,
      turnNumber: this._turnNumber,
      timestamp: Date.now(),
      latency,
      currentState: this._fsm.state,
      vadProbability: 0,
      toolCalls,
      transcript: this._currentTranscript,
      response: this._currentResponse,
    };

    this._socket.emit("telemetry:snapshot", snapshot);
  }

  private _handlePipelineError(err: unknown): void {
    const isFsmError = err instanceof FsmError;
    const code = isFsmError
      ? ErrorCode.INVALID_STATE_TRANSITION
      : ErrorCode.TOOL_EXECUTION_FAILED;
    const message =
      err instanceof Error ? err.message : "Unknown pipeline error";

    console.error(`[StreamManager][${this.sessionId}] Pipeline error:`, err);

    this._fsm.forceError();
    this._emitError(code, message);
    void this.dispose();
  }

  private _emitError(code: string, message: string): void {
    this._socket.emit("session:error", { code, message });
  }

  private _assertNotDisposed(): void {
    if (this._isDisposed) {
      throw new Error(
        `[StreamManager][${this.sessionId}] Operation on disposed session`
      );
    }
  }
