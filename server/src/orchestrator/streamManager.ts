import { Server, Socket } from 'socket.io';
import { v4 as uuidv4 } from 'uuid';
import { vadProcessor } from '../utils/vadProcessor';
import type {
  AudioPacket,
  SystemState,
  PipelinePhase,
  TurnLatency,
  SessionConfig,
  PipelineError,
  PipelineErrorCode,
  AviationTask,
  ServerToClientEvents,
  ClientToServerEvents,
} from '../../../shared/types';

// ─── Service interfaces (implementations live in services/) ──────────────────

export interface ASRService {
  // Opens a streaming ASR session, returns an async iterator of transcript tokens
  startStream(sessionId: string, language: string): AsyncIterable<ASRToken>;
  // Feed a raw PCM-S16LE chunk into the active stream
  pushChunk(sessionId: string, chunk: Buffer): Promise<void>;
  // Signal end-of-speech and await the final transcript
  finalise(sessionId: string): Promise<string>;
  // Abort without waiting for result
  abort(sessionId: string): void;
}

export interface ReasoningService {
  // Takes a final transcript, returns intent + ordered list of aviation tasks
  reason(sessionId: string, transcript: string, language: string): Promise<ReasoningResult>;
}

export interface TTSService {
  // Synthesise text and stream raw PCM-S16LE chunks via callback
  synthesise(
    sessionId: string,
    text: string,
    onChunk: (pcm: Buffer) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): Promise<void>;
  // Stop an in-progress synthesis
  abort(sessionId: string): void;
}

export interface ReasoningResult {
  intent: string;
  responseText: string; // fed into TTS
  tasks: AviationTask[];
}

// ─── Per-connection session context ──────────────────────────────────────────

interface SessionContext {
  sessionId: string;
  config: SessionConfig;
  phase: PipelinePhase;
  transcript: string;
  isFinal: boolean;
  intent: string | null;
  lastTurnLatency: TurnLatency | null;
  error: PipelineError | null;

  // Latency timestamps — all in epoch ms
  vadOnsetAt: number | null;
  asrFirstTokenAt: number | null;
  reasoningDoneAt: number | null;
  ttsFirstByteAt: number | null;

  // Guards against concurrent turn processing
  isProcessing: boolean;

  // Tracks silence duration after speech ends (ms)
  silenceStartAt: number | null;
}

// How long of continuous silence triggers ASR finalise (ms)
const SILENCE_TIMEOUT_MS = 800;

// ─── StreamManager ────────────────────────────────────────────────────────────

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

export class StreamManager {
  private io: TypedServer;
  private asr: ASRService;
  private reasoning: ReasoningService;
  private tts: TTSService;

  // Active session contexts, keyed by socket.id
  private sessions: Map<string, SessionContext> = new Map();

  // Silence watchdog timers, keyed by socket.id
  private silenceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  constructor(io: TypedServer, asr: ASRService, reasoning: ReasoningService, tts: TTSService) {
    this.io = io;
    this.asr = asr;
    this.reasoning = reasoning;
    this.tts = tts;
    this.attachConnectionHandler();
  }

  // ─── Socket.io connection lifecycle ────────────────────────────────────────

  private attachConnectionHandler(): void {
    this.io.on('connection', (socket: TypedSocket) => {
      console.log(`[StreamManager] Client connected: ${socket.id}`);

      socket.on('session:config', (config) => this.handleSessionConfig(socket, config));
      socket.on('audio:chunk', (packet) => this.handleAudioChunk(socket, packet));
      socket.on('session:abort', (sessionId) => this.handleSessionAbort(socket, sessionId));
      socket.on('disconnect', (reason) => this.handleDisconnect(socket, reason));
    });
  }

  // ─── Event Handlers ────────────────────────────────────────────────────────

  private handleSessionConfig(socket: TypedSocket, config: SessionConfig): void {
    // Tear down any previous session on this socket
    this.teardownSession(socket.id);

    const sessionId = uuidv4();

    const ctx: SessionContext = {
      sessionId,
      config,
      phase: 'idle',
      transcript: '',
      isFinal: false,
      intent: null,
      lastTurnLatency: null,
      error: null,
      vadOnsetAt: null,
      asrFirstTokenAt: null,
      reasoningDoneAt: null,
      ttsFirstByteAt: null,
      isProcessing: false,
      silenceStartAt: null,
    };

    this.sessions.set(socket.id, ctx);
    vadProcessor.createSession(sessionId);

    socket.emit('session:start', sessionId);
    this.broadcastState(socket, ctx);

    console.log(`[StreamManager] Session created: ${sessionId} for client ${config.clientId}`);
  }

  private async handleAudioChunk(
    socket: TypedSocket,
    packet: Omit<AudioPacket, 'isSpeech' | 'rmsDb'>,
  ): Promise<void> {
    const ctx = this.sessions.get(socket.id);
    if (!ctx) return; // client sent audio before session:config

    // Skip incoming audio while the system is speaking (half-duplex)
    if (ctx.phase === 'speaking' || ctx.phase === 'processing') return;

    const pcm = Buffer.from(packet.payload as ArrayBuffer);

    let vadResult;
    try {
      vadResult = await vadProcessor.process(ctx.sessionId, pcm);
    } catch (err) {
      this.transitionToError(socket, ctx, 'vad', 'VAD_STREAM_ERROR' as PipelineErrorCode, String(err));
      return;
    }

    // Attach VAD metadata back into the packet for downstream use
    const enrichedPacket: AudioPacket = {
      ...packet,
      isSpeech: vadResult.isSpeech,
      rmsDb: vadResult.rmsDb,
    };

    if (vadResult.isSpeech) {
      this.clearSilenceTimer(socket.id);
      ctx.silenceStartAt = null;

      if (ctx.phase === 'idle') {
        // Speech onset — start listening
        ctx.vadOnsetAt = Date.now();
        this.transition(socket, ctx, 'listening');

        try {
          // Kick off ASR stream — tokens arrive asynchronously
          this.consumeASRStream(socket, ctx);
        } catch (err) {
          this.transitionToError(socket, ctx, 'asr', 'ASR_STREAM_TIMEOUT', String(err));
          return;
        }
      }

      // Feed chunk into the live ASR stream
      if (ctx.phase === 'listening') {
        try {
          await this.asr.pushChunk(ctx.sessionId, pcm);
        } catch (err) {
          this.transitionToError(socket, ctx, 'asr', 'ASR_STREAM_TIMEOUT', String(err));
        }
      }
    } else {
      // Silence frame — start the watchdog if we were listening
      if (ctx.phase === 'listening' && !this.silenceTimers.has(socket.id)) {
        ctx.silenceStartAt = ctx.silenceStartAt ?? Date.now();
        this.startSilenceTimer(socket, ctx);
      }
    }
  }

  private handleSessionAbort(socket: TypedSocket, sessionId: string): void {
    const ctx = this.sessions.get(socket.id);
    if (!ctx || ctx.sessionId !== sessionId) return;

    console.log(`[StreamManager] Abort requested for session ${sessionId}`);
    this.asr.abort(ctx.sessionId);
    this.tts.abort(ctx.sessionId);
    this.clearSilenceTimer(socket.id);
    this.transition(socket, ctx, 'idle');
    this.resetTurnState(ctx);
  }

  private handleDisconnect(socket: TypedSocket, reason: string): void {
    console.log(`[StreamManager] Client disconnected: ${socket.id} (${reason})`);
    this.teardownSession(socket.id);
  }

  // ─── Core Pipeline ─────────────────────────────────────────────────────────

  // Consumes ASR token stream and keeps transcript updated in real-time
  private async consumeASRStream(socket: TypedSocket, ctx: SessionContext): Promise<void> {
    try {
      for await (const token of this.asr.startStream(ctx.sessionId, ctx.config.language)) {
        if (ctx.phase !== 'listening') break; // aborted mid-stream

        if (ctx.asrFirstTokenAt === null) {
          ctx.asrFirstTokenAt = Date.now();
        }

        ctx.transcript = token.partial;
        ctx.isFinal = token.isFinal;
        this.broadcastState(socket, ctx);
      }
    } catch (err) {
      this.transitionToError(socket, ctx, 'asr', 'ASR_STREAM_TIMEOUT', String(err));
    }
  }

  // Triggered when silence watchdog fires — finalise the turn and start reasoning
  private async finaliseTurn(socket: TypedSocket, ctx: SessionContext): Promise<void> {
    if (ctx.isProcessing || ctx.phase !== 'listening') return;
    ctx.isProcessing = true;

    let finalTranscript: string;
    try {
      finalTranscript = await this.asr.finalise(ctx.sessionId);
    } catch (err) {
      this.transitionToError(socket, ctx, 'asr', 'ASR_STREAM_TIMEOUT', String(err));
      ctx.isProcessing = false;
      return;
    }

    if (!finalTranscript.trim()) {
      // Empty transcript — false trigger, reset silently
      this.transition(socket, ctx, 'idle');
      this.resetTurnState(ctx);
      ctx.isProcessing = false;
      return;
    }

    ctx.transcript = finalTranscript;
    ctx.isFinal = true;
    this.transition(socket, ctx, 'processing');
    this.broadcastState(socket, ctx);

    // ── Reasoning ────────────────────────────────────────────────────────────

    let reasoningResult: ReasoningResult;
    try {
      reasoningResult = await this.reasoning.reason(
        ctx.sessionId,
        finalTranscript,
        ctx.config.language,
      );
    } catch (err) {
      this.transitionToError(socket, ctx, 'reasoning', 'NIM_UNAVAILABLE', String(err));
      ctx.isProcessing = false;
      return;
    }

    ctx.reasoningDoneAt = Date.now();
    ctx.intent = reasoningResult.intent;

    // Broadcast any aviation tasks the reasoning layer queued
    for (const task of reasoningResult.tasks) {
      socket.emit('task:update', task);
    }

    this.broadcastState(socket, ctx);

    // ── TTS ──────────────────────────────────────────────────────────────────

    this.transition(socket, ctx, 'speaking');

    try {
      await this.tts.synthesise(
        ctx.sessionId,
        reasoningResult.responseText,
        (pcm: Buffer) => {
          if (ctx.ttsFirstByteAt === null) {
            ctx.ttsFirstByteAt = Date.now();
          }
          // Stream raw PCM back to the client for playback
          socket.emit('audio:chunk', pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength));
        },
        () => this.onTTSDone(socket, ctx),
        (err) => this.transitionToError(socket, ctx, 'tts', 'TTS_STREAM_ERROR', err.message),
      );
    } catch (err) {
      this.transitionToError(socket, ctx, 'tts', 'TTS_STREAM_ERROR', String(err));
      ctx.isProcessing = false;
    }
  }

  // Called when TTS finishes streaming — close out the turn
  private onTTSDone(socket: TypedSocket, ctx: SessionContext): void {
    const latency = this.computeLatency(ctx);
    ctx.lastTurnLatency = latency;

    socket.emit('session:end', ctx.sessionId, latency);

    this.transition(socket, ctx, 'idle');
    this.resetTurnState(ctx);
    ctx.isProcessing = false;

    console.log(
      `[StreamManager] Turn complete — e2e: ${latency.e2eMs}ms | ` +
      `asr: ${latency.asrMs}ms | reasoning: ${latency.reasoningMs}ms | tts: ${latency.ttsMs}ms`,
    );
  }

  // ─── Silence Watchdog ──────────────────────────────────────────────────────

  private startSilenceTimer(socket: TypedSocket, ctx: SessionContext): void {
    const timer = setTimeout(() => {
      this.silenceTimers.delete(socket.id);
      this.finaliseTurn(socket, ctx).catch((err) => {
        console.error(`[StreamManager] finaliseTurn threw: ${err}`);
      });
    }, SILENCE_TIMEOUT_MS);

    this.silenceTimers.set(socket.id, timer);
  }

  private clearSilenceTimer(socketId: string): void {
    const timer = this.silenceTimers.get(socketId);
    if (timer) {
      clearTimeout(timer);
      this.silenceTimers.delete(socketId);
    }
  }

  // ─── FSM Transitions ───────────────────────────────────────────────────────

  private transition(socket: TypedSocket, ctx: SessionContext, next: PipelinePhase): void {
    if (ctx.phase === next) return;
    console.log(`[StreamManager] ${ctx.sessionId} | ${ctx.phase} → ${next}`);
    ctx.phase = next;
    ctx.error = null;
    this.broadcastState(socket, ctx);
  }

  private transitionToError(
    socket: TypedSocket,
    ctx: SessionContext,
    layer: PipelineError['layer'],
    code: PipelineErrorCode,
    message: string,
  ): void {
    const err: PipelineError = {
      code,
      message,
      timestamp: new Date().toISOString(),
      layer,
    };

    ctx.error = err;
    ctx.phase = 'error';
    this.broadcastState(socket, ctx);
    socket.emit('error', err);

    console.error(`[StreamManager] Error [${layer}/${code}]: ${message}`);

    // Clean up resources attached to the failed turn
    this.asr.abort(ctx.sessionId);
    this.tts.abort(ctx.sessionId);
    this.clearSilenceTimer(socket.id);
    this.resetTurnState(ctx);
    ctx.isProcessing = false;
  }

  // ─── State Broadcasting ────────────────────────────────────────────────────

  private broadcastState(socket: TypedSocket, ctx: SessionContext): void {
    const state: SystemState = {
      phase: ctx.phase,
      sessionId: ctx.sessionId,
      transcript: ctx.transcript,
      isFinal: ctx.isFinal,
      intent: ctx.intent,
      lastTurnLatency: ctx.lastTurnLatency,
      updatedAt: Date.now(),
      error: ctx.error,
    };
    socket.emit('state:update', state);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private computeLatency(ctx: SessionContext): TurnLatency {
    const now = Date.now();
    const onset = ctx.vadOnsetAt ?? now;
    const asrFirst = ctx.asrFirstTokenAt ?? now;
    const reasoningDone = ctx.reasoningDoneAt ?? now;
    const ttsFirst = ctx.ttsFirstByteAt ?? now;

    return {
      asrMs: asrFirst - onset,
      reasoningMs: reasoningDone - asrFirst,
      ttsMs: ttsFirst - reasoningDone,
      e2eMs: ttsFirst - onset,
    };
  }

  // Zero out per-turn tracking fields without destroying session identity
  private resetTurnState(ctx: SessionContext): void {
    ctx.transcript = '';
    ctx.isFinal = false;
    ctx.intent = null;
    ctx.error = null;
    ctx.vadOnsetAt = null;
    ctx.asrFirstTokenAt = null;
    ctx.reasoningDoneAt = null;
    ctx.ttsFirstByteAt = null;
    ctx.silenceStartAt = null;
  }

  // Full teardown — called on disconnect or reconfigure
  private teardownSession(socketId: string): void {
    const ctx = this.sessions.get(socketId);
    if (!ctx) return;

    this.clearSilenceTimer(socketId);
    this.asr.abort(ctx.sessionId);
    this.tts.abort(ctx.sessionId);
    vadProcessor.destroySession(ctx.sessionId);
    this.sessions.delete(socketId);

    console.log(`[StreamManager] Session torn down: ${ctx.sessionId}`);
  }
}

// ASR token shape — partial updates stream in, isFinal marks the last one
export interface ASRToken {
  partial: string;
  isFinal: boolean;
  confidence?: number;
}
