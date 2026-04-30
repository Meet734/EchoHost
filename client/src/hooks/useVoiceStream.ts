import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  PipelineState,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type PipelineState as PipelineStateType,
  type TelemetrySnapshot,
  type ExtractedIntent,
} from '../../../shared/types';

const SERVER_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3001';

// ─── Public interface ─────────────────────────────────────────────────────────

export interface VoiceStreamState {
  /** Current FSM phase from server */
  phase: PipelineStateType;
  /** Latest (possibly partial) transcript */
  transcript: string;
  /** True when the transcript is finalised for this turn */
  isFinal: boolean;
  /** Latest LLM response text */
  response: string;
  /** Latest extracted aviation intent */
  intent: ExtractedIntent | null;
  /** VAD probability 0.0–1.0 */
  vadProbability: number;
  /** True when VAD is actively detecting speech */
  isSpeaking: boolean;
  /** Latest completed-turn telemetry */
  telemetry: TelemetrySnapshot | null;
  /** Non-null when a session-level error has occurred */
  error: { code: string; message: string } | null;
}

export interface UseVoiceStreamOptions {
  clientId?: string;
  language?: string;
}

export interface UseVoiceStreamResult {
  socketConnected: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  state: VoiceStreamState;
  startStreaming: () => Promise<void>;
  stopStreaming: () => void;
}

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const INITIAL_STATE: VoiceStreamState = {
  phase: PipelineState.IDLE,
  transcript: '',
  isFinal: false,
  response: '',
  intent: null,
  vadProbability: 0,
  isSpeaking: false,
  telemetry: null,
  error: null,
};

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useVoiceStream(_options: UseVoiceStreamOptions = {}): UseVoiceStreamResult {
  const [socketConnected, setSocketConnected] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<VoiceStreamState>(INITIAL_STATE);

  // Audio pipeline refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sequenceRef = useRef(0);

  // TTS playback refs
  const ttsContextRef = useRef<AudioContext | null>(null);
  const ttsQueueRef = useRef<ArrayBuffer[]>([]);
  const ttsPlayingRef = useRef(false);

  // Socket — created once, auto-connects
  const socket = useMemo<TypedSocket>(() => {
    const s = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
      autoConnect: true,
      withCredentials: false,
    });
    return s;
  }, []);

  // ── TTS playback queue ────────────────────────────────────────────────────

  const drainTTSQueue = useCallback(async () => {
    if (ttsPlayingRef.current) return;
    ttsPlayingRef.current = true;

    if (!ttsContextRef.current || ttsContextRef.current.state === 'closed') {
      ttsContextRef.current = new AudioContext({ sampleRate: 22050 });
    }
    const ctx = ttsContextRef.current;

    while (ttsQueueRef.current.length > 0) {
      const chunk = ttsQueueRef.current.shift();
      if (!chunk) continue;
      try {
        const audioBuffer = await ctx.decodeAudioData(chunk.slice(0));
        const source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(ctx.destination);
        await new Promise<void>((res) => { source.onended = () => res(); source.start(); });
      } catch {
        // malformed chunk — skip
      }
    }
    ttsPlayingRef.current = false;
  }, []);

  // ── Socket event wiring ───────────────────────────────────────────────────

  useEffect(() => {
    const onConnect = (): void => {
      console.log('[EchoHost] Socket connected');
      setSocketConnected(true);
      setState((s) => ({ ...s, error: null }));
      // Emit session:start immediately on connect
      socket.emit('session:start', { clientVersion: PROTOCOL_VERSION });
    };

    const onDisconnect = (): void => {
      console.log('[EchoHost] Socket disconnected');
      setSocketConnected(false);
      setSessionId(null);
    };

    const onSessionReady = (data: { sessionId: string; protocolVersion: string }): void => {
      console.log('[EchoHost] Session ready:', data.sessionId);
      setSessionId(data.sessionId);
      sequenceRef.current = 0;
      setState((s) => ({ ...s, phase: PipelineState.LISTENING, error: null }));
    };

    const onPipelineState = (event: { from: PipelineStateType; to: PipelineStateType }): void => {
      setState((s) => ({ ...s, phase: event.to }));
    };

    const onASRPartial = (data: { text: string }): void => {
      setState((s) => ({ ...s, transcript: data.text, isFinal: false }));
    };

    const onASRFinal = (data: { text: string }): void => {
      setState((s) => ({ ...s, transcript: data.text, isFinal: true }));
    };

    const onReasoningIntent = (intent: ExtractedIntent): void => {
      setState((s) => ({ ...s, intent, response: '' }));
    };

    const onTTSChunk = (chunk: ArrayBuffer): void => {
      ttsQueueRef.current.push(chunk);
      if (!ttsPlayingRef.current) void drainTTSQueue();
    };

    const onTTSComplete = (): void => {
      // Queue drains naturally
    };

    const onVADProbability = (data: { probability: number; isSpeech: boolean }): void => {
      setState((s) => ({ ...s, vadProbability: data.probability, isSpeaking: data.isSpeech }));
    };

    const onTelemetry = (snapshot: TelemetrySnapshot): void => {
      setState((s) => ({
        ...s,
        telemetry: snapshot,
        response: snapshot.response ?? s.response,
      }));
    };

    const onSessionError = (data: { code: string; message: string }): void => {
      console.error('[EchoHost] Session error:', data.code, data.message);
      setState((s) => ({ ...s, error: data, phase: PipelineState.ERROR }));
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session:ready', onSessionReady);
    socket.on('pipeline:state', onPipelineState);
    socket.on('asr:partial', onASRPartial);
    socket.on('asr:final', onASRFinal);
    socket.on('reasoning:intent', onReasoningIntent);
    socket.on('tts:audio_chunk', onTTSChunk);
    socket.on('tts:complete', onTTSComplete);
    socket.on('vad:probability', onVADProbability);
    socket.on('telemetry:snapshot', onTelemetry);
    socket.on('session:error', onSessionError);

    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session:ready', onSessionReady);
      socket.off('pipeline:state', onPipelineState);
      socket.off('asr:partial', onASRPartial);
      socket.off('asr:final', onASRFinal);
      socket.off('reasoning:intent', onReasoningIntent);
      socket.off('tts:audio_chunk', onTTSChunk);
      socket.off('tts:complete', onTTSComplete);
      socket.off('vad:probability', onVADProbability);
      socket.off('telemetry:snapshot', onTelemetry);
      socket.off('session:error', onSessionError);
    };
  }, [socket, drainTTSQueue]);

  // ── Microphone & AudioWorklet ─────────────────────────────────────────────

  const startStreaming = useCallback(async (): Promise<void> => {
    if (isStreaming) return;

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });

    // 16 kHz audio context to match server expectation
    const audioContext = new AudioContext({ sampleRate: 16_000 });

    // Load worklet from /public (avoids Blob URL CSP issues)
    await audioContext.audioWorklet.addModule('/audio-processor.worklet.js');

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'echohost-pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
    });

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!(event.data instanceof ArrayBuffer)) return;

      // Build wire packet: [seq: Uint32 LE][capturedAt: Float64 LE][pcm: Int16[]]
      const pcmPayload = event.data;
      const packet = new ArrayBuffer(4 + 8 + pcmPayload.byteLength);
      const view = new DataView(packet);
      view.setUint32(0, sequenceRef.current, true);
      view.setFloat64(4, Date.now(), true);
      new Uint8Array(packet).set(new Uint8Array(pcmPayload), 12);

      socket.emit('audio:chunk', packet);
      sequenceRef.current += 1;
    };

    sourceNode.connect(workletNode);

    mediaStreamRef.current = mediaStream;
    audioContextRef.current = audioContext;
    sourceNodeRef.current = sourceNode;
    workletNodeRef.current = workletNode;
    setIsStreaming(true);
    console.log('[EchoHost] Microphone streaming started');
  }, [isStreaming, socket]);

  const stopStreaming = useCallback((): void => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    mediaStreamRef.current?.getTracks().forEach((t) => t.stop());
    mediaStreamRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;

    // Correct event: session:stop (not session:abort)
    socket.emit('session:stop');
    setIsStreaming(false);
    console.log('[EchoHost] Microphone streaming stopped');
  }, [socket]);

  return { socketConnected, isStreaming, sessionId, state, startStreaming, stopStreaming };
}
