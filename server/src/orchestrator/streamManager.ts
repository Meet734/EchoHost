import type { Server, Socket } from 'socket.io';
import { randomUUID } from 'crypto';
import { AUDIO_SPEC } from '../../../shared/types';
import type {
  AudioPacket,
  AviationTask,
  ClientToServerEvents,
  PipelineError,
  PipelineErrorCode,
  PipelinePhase,
  ServerToClientEvents,
  SessionConfig,
  SystemState,
  TurnLatency,
} from '../../../shared/types';
import { vadProcessor } from '../utils/vadProcessor';
import { ASRService, type TranscriptEvent } from '../services/asrService';
import { ReasoningService } from '../services/reasoningService';
import { TTSService } from '../services/ttsService';

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

// How long silence must persist before we finalise the ASR turn
const SILENCE_DEBOUNCE_MS = 800;

interface SessionContext {
  socketId: string;
  sessionId: string;
  phase: PipelinePhase;
  transcript: string;
  language: string;
  clientId: string;
  isFinal: boolean;
  intent: string | null;
  lastTurnLatency: TurnLatency | null;
  asrInitialised: boolean;
  isFinalizingTurn: boolean; // guard against duplicate finalise calls

  // Latency tracking — all epoch ms
  vadOnsetAt: number | null;
  asrFirstTokenAt: number | null;
  reasoningDoneAt: number | null;
  ttsFirstByteAt: number | null;
}

const DEFAULT_CONFIG: SessionConfig = {
  clientId: 'web-client',
  audioSpec: AUDIO_SPEC,
  language: 'en-US',
  guardrailsEnabled: true,
};

export class StreamManager {
  private readonly io: TypedServer;
  private readonly asrService: ASRService;
  private readonly reasoningService: ReasoningService;
  private readonly ttsService: TTSService;

  private readonly socketToSession: Map<string, SessionContext> = new Map();
  private readonly sessionToSocket: Map<string, string> = new Map();
  private readonly audioSerial: Map<string, Promise<void>> = new Map();
  private readonly silenceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(
    io: TypedServer,
    asrService: ASRService,
    reasoningService: ReasoningService,
    ttsService: TTSService,
  ) {
    this.io = io;
    this.asrService = asrService;
    this.reasoningService = reasoningService;
    this.ttsService = ttsService;

    this.asrService.on('transcript', (event) => this.handleTranscriptEvent(event));
    this.asrService.on('stream:error', (event) => this.handleASRError(event.sessionId, event.message));
  }

  public handleConnection(socket: TypedSocket): void {
    console.log(`[INFO] [StreamManager] Client connected: ${socket.id}`);
    this.createOrResetSession(socket, DEFAULT_CONFIG);

    socket.on('session:config', (config) => this.createOrResetSession(socket, config));
    socket.on('audio:chunk',    (packet) => this.enqueueAudioChunk(socket, packet));
    socket.on('session:abort',  (sessionId) => this.handleAbort(socket, sessionId));
    socket.on('disconnect', () => {
      this.destroySession(socket.id);
      console.log(`[INFO] [StreamManager] Client disconnected: ${socket.id}`);
    });
  }

  public async dispose(): Promise<void> {
    for (const socketId of Array.from(this.socketToSession.keys())) {
      this.destroySession(socketId);
    }
    await this.asrService.dispose();
    this.ttsService.dispose();
  }

  // ─── Session Lifecycle ─────────────────────────────────────────────────────

  private createOrResetSession(socket: TypedSocket, config: SessionConfig): void {
    this.destroySession(socket.id);

    const sessionId = randomUUID();
    const context: SessionContext = {
      socketId: socket.id,
      sessionId,
      phase: 'idle',
      transcript: '',
      language: config.language,
      clientId: config.clientId,
      isFinal: false,
      intent: null,
      lastTurnLatency: null,
      asrInitialised: false,
      isFinalizingTurn: false,
      vadOnsetAt: null,
      asrFirstTokenAt: null,
      reasoningDoneAt: null,
      ttsFirstByteAt: null,
    };

    this.socketToSession.set(socket.id, context);
    this.sessionToSocket.set(sessionId, socket.id);
    vadProcessor.createSession(sessionId);

    socket.emit('session:start', sessionId);
    this.emitState(socket, context);
    console.log(`[SUCCESS] [StreamManager] Session started: ${sessionId}`);
  }

  private destroySession(socketId: string): void {
    const context = this.socketToSession.get(socketId);
    if (!context) return;

    this.clearSilenceTimer(socketId);
    this.ttsService.abort(context.sessionId);

    if (context.asrInitialised) {
      this.asrService.destroySession(context.sessionId);
    }

    vadProcessor.destroySession(context.sessionId);
    this.sessionToSocket.delete(context.sessionId);
    this.socketToSession.delete(socketId);
    this.audioSerial.delete(socketId);

    console.log(`[INFO] [StreamManager] Session destroyed: ${context.sessionId}`);
  }

  // ─── Audio Ingestion ───────────────────────────────────────────────────────

  // Serialises per-socket audio processing to prevent out-of-order VAD/ASR calls
  private enqueueAudioChunk(
    socket: TypedSocket,
    packet: Omit<AudioPacket, 'isSpeech' | 'rmsDb'>,
  ): void {
    const previous = this.audioSerial.get(socket.id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => this.handleAudioChunk(socket, packet));

    this.audioSerial.set(socket.id, next);
    void next.finally(() => {
      if (this.audioSerial.get(socket.id) === next) {
        this.audioSerial.delete(socket.id);
      }
    });
  }

  private async handleAudioChunk(
    socket: TypedSocket,
    packet: Omit<AudioPacket, 'isSpeech' | 'rmsDb'>,
  ): Promise<void> {
    const context = this.socketToSession.get(socket.id);
    if (!context) return;

    // Drop audio while reasoning or speaking — half-duplex mode
    if (context.phase === 'processing' || context.phase === 'speaking') return;

    const pcmChunk = toBuffer(packet.payload);
    if (!pcmChunk || pcmChunk.byteLength === 0) {
      console.error(`[ERROR] [StreamManager] Undecodable audio payload for session ${context.sessionId}`);
      return;
    }

    if ((pcmChunk.byteLength & 1) !== 0 || pcmChunk.byteLength !== AUDIO_SPEC.CHUNK_BYTES) {
      console.error(
        `[ERROR] [StreamManager] Invalid chunk size: ${pcmChunk.byteLength}B ` +
        `(expected ${AUDIO_SPEC.CHUNK_BYTES}B)`,
      );
      return;
    }

    try {
      const vadResult = await vadProcessor.process(context.sessionId, pcmChunk);

      if (vadResult.isSpeech) {
        this.clearSilenceTimer(socket.id);

        // Speech onset — open ASR stream and begin listening
        if (!context.asrInitialised) {
          this.asrService.createSession(context.sessionId, context.language);
          context.asrInitialised = true;
          context.vadOnsetAt = Date.now();
        }

        if (context.phase === 'idle') {
          this.transition(socket, context, 'listening');
        }

        await this.asrService.pushAudio(context.sessionId, pcmChunk);

      } else if (context.phase === 'listening') {
        // Start the silence debounce — do not transition immediately
        if (!this.silenceTimers.has(socket.id)) {
          this.startSilenceTimer(socket, context);
        }
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.emitError(socket, context, 'vad', 'UNKNOWN', message);
    }
  }

  // ─── Silence Debounce ──────────────────────────────────────────────────────

  private startSilenceTimer(socket: TypedSocket, context: SessionContext): void {
    const timer = setTimeout(() => {
      this.silenceTimers.delete(socket.id);
      this.onSilenceTimeout(socket, context);
    }, SILENCE_DEBOUNCE_MS);

    this.silenceTimers.set(socket.id, timer);
  }

  private clearSilenceTimer(socketId: string): void {
    const timer = this.silenceTimers.get(socketId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(socketId);
    }
  }

  private onSilenceTimeout(socket: TypedSocket, context: SessionContext): void {
    if (context.phase !== 'listening' || context.isFinalizingTurn) return;

    // Tell NIM to stop accepting audio and send the final transcript
    this.asrService.finalise(context.sessionId);
    this.transition(socket, context, 'processing');
  }

  // ─── Transcript Events ─────────────────────────────────────────────────────

  private handleTranscriptEvent(event: TranscriptEvent): void {
    const socketId = this.sessionToSocket.get(event.sessionId);
    if (!socketId) return;

    const socket  = this.io.sockets.sockets.get(socketId) as TypedSocket | undefined;
    const context = this.socketToSession.get(socketId);
    if (!socket || !context) return;

    // Track first-token latency
    if (context.asrFirstTokenAt === null) {
      context.asrFirstTokenAt = Date.now();
    }

    context.transcript = event.text;
    context.isFinal    = event.isFinal;

    if (!event.isFinal) {
      // Partial transcript — update the client in real-time
      this.emitState(socket, context);
      return;
    }

    // Final transcript received — start the reasoning pipeline
    if (context.isFinalizingTurn) return; // guard against duplicate isFinal

    // isFinal can arrive while still in 'listening' (NIM beat our silence timer)
    if (context.phase === 'listening') {
      this.clearSilenceTimer(socketId);
      this.transition(socket, context, 'processing');
    }

    if (context.phase === 'processing') {
      void this.finalizeTurn(socket, context, event.text);
    }
  }

  private handleASRError(sessionId: string, message: string): void {
    const socketId = this.sessionToSocket.get(sessionId);
    if (!socketId) return;

    const socket  = this.io.sockets.sockets.get(socketId) as TypedSocket | undefined;
    const context = this.socketToSession.get(socketId);
    if (!socket || !context || context.phase === 'idle') return;

    this.emitError(socket, context, 'asr', 'NIM_UNAVAILABLE', message);
  }

  // ─── Full Turn Pipeline ────────────────────────────────────────────────────

  private async finalizeTurn(
    socket: TypedSocket,
    context: SessionContext,
    finalTranscript: string,
  ): Promise<void> {
    context.isFinalizingTurn = true;

    if (!finalTranscript.trim()) {
      // Empty — false VAD trigger, reset silently
      this.resetTurnState(context);
      this.transition(socket, context, 'idle');
      return;
    }

    // ── Reasoning ───────────────────────────────────────────────────────────
    let reasoningResult;
    try {
      reasoningResult = await this.reasoningService.reason(
        context.sessionId,
        finalTranscript,
        context.language,
      );
    } catch (err: unknown) {
      this.emitError(socket, context, 'reasoning', 'NIM_UNAVAILABLE', String(err));
      this.resetTurnState(context);
      return;
    }

    context.intent          = reasoningResult.intent;
    context.reasoningDoneAt = Date.now();

    // Broadcast any aviation tasks that were queued
    for (const task of reasoningResult.tasks) {
      socket.emit('task:update', task as AviationTask);
    }

    this.emitState(socket, context);

    // ── TTS ──────────────────────────────────────────────────────────────────
    this.transition(socket, context, 'speaking');

    try {
      await this.ttsService.synthesise(
        context.sessionId,
        reasoningResult.responseText,
        (pcm: Buffer) => {
          if (context.ttsFirstByteAt === null) {
            context.ttsFirstByteAt = Date.now();
          }
          // Stream raw PCM to the client for AudioWorklet playback
          // Cast required: pcm.buffer may be a SharedArrayBuffer in some runtimes
          socket.emit(
            'audio:chunk',
            pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer,
          );
        },
        () => this.onTTSDone(socket, context),
        (err) => this.emitError(socket, context, 'tts', 'TTS_STREAM_ERROR', err.message),
      );
    } catch (err: unknown) {
      this.emitError(socket, context, 'tts', 'TTS_STREAM_ERROR', String(err));
      this.resetTurnState(context);
    }
  }

  private onTTSDone(socket: TypedSocket, context: SessionContext): void {
    const latency = this.computeLatency(context);
    context.lastTurnLatency = latency;

    socket.emit('session:end', context.sessionId, latency);

    console.log(
      `[SUCCESS] [StreamManager] Turn complete — e2e: ${latency.e2eMs}ms | ` +
      `asr: ${latency.asrMs}ms | reasoning: ${latency.reasoningMs}ms | tts: ${latency.ttsMs}ms`,
    );

    // Tear down the ASR session for this turn
    if (context.asrInitialised) {
      this.asrService.destroySession(context.sessionId);
    }

    this.resetTurnState(context);
    this.transition(socket, context, 'idle');
  }

  // ─── Abort ─────────────────────────────────────────────────────────────────

  private handleAbort(socket: TypedSocket, sessionId: string): void {
    const context = this.socketToSession.get(socket.id);
    if (!context || context.sessionId !== sessionId) return;

    this.clearSilenceTimer(socket.id);
    this.ttsService.abort(context.sessionId);

    if (context.asrInitialised) {
      this.asrService.destroySession(context.sessionId);
    }

    this.resetTurnState(context);
    this.transition(socket, context, 'idle');
  }

  // ─── FSM Helpers ───────────────────────────────────────────────────────────

  private transition(socket: TypedSocket, context: SessionContext, next: PipelinePhase): void {
    if (context.phase === next) return;
    console.log(`[INFO] [FSM] ${context.sessionId}: ${context.phase} -> ${next}`);
    context.phase = next;
    this.emitState(socket, context);
  }

  private emitState(socket: TypedSocket, context: SessionContext): void {
    const state: SystemState = {
      phase: context.phase,
      sessionId: context.sessionId,
      transcript: context.transcript,
      isFinal: context.isFinal,
      intent: context.intent,
      lastTurnLatency: context.lastTurnLatency,
      updatedAt: Date.now(),
      error: null,
    };
    socket.emit('state:update', state);
  }

  private emitError(
    socket: TypedSocket,
    context: SessionContext,
    layer: PipelineError['layer'],
    code: PipelineErrorCode,
    message: string,
  ): void {
    const errorPayload: PipelineError = { code, message, timestamp: new Date().toISOString(), layer };
    context.phase = 'error';

    const state: SystemState = {
      phase: 'error',
      sessionId: context.sessionId,
      transcript: context.transcript,
      isFinal: context.isFinal,
      intent: context.intent,
      lastTurnLatency: context.lastTurnLatency,
      updatedAt: Date.now(),
      error: errorPayload,
    };

    socket.emit('state:update', state);
    socket.emit('error', errorPayload);
    console.error(`[ERROR] [StreamManager] ${layer}/${code}: ${message}`);
  }

  // ─── Latency & State Reset ─────────────────────────────────────────────────

  private computeLatency(context: SessionContext): TurnLatency {
    const now           = Date.now();
    const onset         = context.vadOnsetAt      ?? now;
    const asrFirst      = context.asrFirstTokenAt  ?? now;
    const reasoningDone = context.reasoningDoneAt  ?? now;
    const ttsFirst      = context.ttsFirstByteAt   ?? now;

    return {
      asrMs:       asrFirst      - onset,
      reasoningMs: reasoningDone - asrFirst,
      ttsMs:       ttsFirst      - reasoningDone,
      e2eMs:       ttsFirst      - onset,
    };
  }

  private resetTurnState(context: SessionContext): void {
    context.transcript       = '';
    context.isFinal          = false;
    context.intent           = null;
    context.asrInitialised   = false;
    context.isFinalizingTurn = false;
    context.vadOnsetAt       = null;
    context.asrFirstTokenAt  = null;
    context.reasoningDoneAt  = null;
    context.ttsFirstByteAt   = null;
  }
}

function toBuffer(payload: AudioPacket['payload']): Buffer | null {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return null;
}
