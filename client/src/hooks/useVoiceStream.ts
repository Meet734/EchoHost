import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  AUDIO_SPEC,
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SessionConfig,
  type SystemState,
} from '../../../shared/types';

const SERVER_URL = import.meta.env.VITE_SOCKET_URL ?? 'http://localhost:3001';

export interface UseVoiceStreamOptions {
  clientId?: string;
  language?: string;
}

export interface UseVoiceStreamResult {
  socketConnected: boolean;
  isStreaming: boolean;
  sessionId: string | null;
  state: SystemState | null;
  startStreaming: () => Promise<void>;
  stopStreaming: () => void;
}

type TypedClientSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function useVoiceStream(options: UseVoiceStreamOptions = {}): UseVoiceStreamResult {
  const [socketConnected, setSocketConnected] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [state, setState] = useState<SystemState | null>(null);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sequenceRef = useRef<number>(0);

  const socket = useMemo<TypedClientSocket>(() => {
    console.log('[DEBUG] Creating Socket.io instance, connecting to:', SERVER_URL);
    const newSocket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity,
      autoConnect: true,
      withCredentials: false,
    });

    newSocket.on('connect', () => {
      console.log('[DEBUG] Socket connect event fired');
    });

    newSocket.on('disconnect', () => {
      console.log('[DEBUG] Socket disconnect event fired');
    });

    newSocket.on('connect_error', (error: Error) => {
      console.error('[ERROR] Socket connection error:', error.message);
    });

    newSocket.on('error', (error: Error) => {
      console.error('[ERROR] Socket error:', error.message);
    });

    return newSocket;
  }, []);

  const emitSessionStart = useCallback((): void => {
    console.log('[DEBUG] Emitting session:start');
    socket.emit('session:start', {
      clientVersion: PROTOCOL_VERSION,
    });
  }, [socket]);

  useEffect(() => {
    const onConnect = (): void => {
      console.log('[DEBUG] Socket connected');
      setSocketConnected(true);
      emitSessionStart();
    };

    const onDisconnect = (): void => {
      console.log('[DEBUG] Socket disconnected');
      setSocketConnected(false);
      setSessionId(null);
    };

    const onSessionReady = (data: { sessionId: string; protocolVersion: string }): void => {
      console.log('[DEBUG] Session ready:', data.sessionId);
      setSessionId(data.sessionId);
      sequenceRef.current = 0;
    };

    const onPipelineStateChange = (event: any): void => {
      console.log('[DEBUG] Pipeline state changed:', event.to);
      setState((prev) => prev ? { ...prev, phase: event.to } : null);
    };

    const onASRFinal = (data: { text: string; sessionId: string }): void => {
      console.log('[DEBUG] ASR final:', data.text);
      setState((prev) => prev ? { ...prev, transcript: data.text, isFinal: true } : null);
    };

    const onASRPartial = (data: { text: string; sessionId: string }): void => {
      setState((prev) => prev ? { ...prev, transcript: data.text, isFinal: false } : null);
    };

    const onSessionError = (data: { code: string; message: string }): void => {
      console.error('[ERROR] Session error:', data.code, data.message);
      setState((prev) =>
        prev ? {
          ...prev,
          error: { code: data.code, message: data.message, layer: 'server' },
        } : null
      );
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session:ready', onSessionReady);
    socket.on('pipeline:state', onPipelineStateChange);
    socket.on('asr:final', onASRFinal);
    socket.on('asr:partial', onASRPartial);
    socket.on('session:error', onSessionError);

    // Log initial connection status
    if (socket.connected) {
      console.log('[DEBUG] Socket already connected on effect mount');
      onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session:ready', onSessionReady);
      socket.off('pipeline:state', onPipelineStateChange);
      socket.off('asr:final', onASRFinal);
      socket.off('asr:partial', onASRPartial);
      socket.off('session:error', onSessionError);
    };
  }, [emitSessionStart, socket]);

  const startStreaming = useCallback(async (): Promise<void> => {
    if (isStreaming) {
      return;
    }

    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    const audioContext = new AudioContext({ sampleRate: AUDIO_SPEC.sampleRate });
    await audioContext.audioWorklet.addModule(
      URL.createObjectURL(new Blob([buildWorkletScript()], { type: 'application/javascript' })),
    );

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'echohost-pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: AUDIO_SPEC.sampleRate,
        chunkSamples: AUDIO_SPEC.frameSize,
      },
    });

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!sessionId) {
        return;
      }

      const pcmPayload = event.data;
      if (!(pcmPayload instanceof ArrayBuffer)) {
        return;
      }

      // Construct binary packet: [seq: Uint32][capturedAt: Float64][pcm: Int16[]]
      const totalSize = 4 + 8 + pcmPayload.byteLength;
      const packet = new ArrayBuffer(totalSize);
      const view = new DataView(packet);
      
      view.setUint32(0, sequenceRef.current, true); // seq (little-endian)
      view.setFloat64(4, Date.now(), true); // capturedAt (little-endian)
      
      // Copy PCM data
      new Uint8Array(packet).set(new Uint8Array(pcmPayload), 12);

      socket.emit('audio:chunk', packet);

      if (sequenceRef.current % 50 === 0) {
        console.log(`[DEBUG] Audio chunk sent: seq=${sequenceRef.current}, size=${totalSize}`);
      }
      sequenceRef.current += 1;
    };

    sourceNode.connect(workletNode);

    mediaStreamRef.current = mediaStream;
    audioContextRef.current = audioContext;
    sourceNodeRef.current = sourceNode;
    workletNodeRef.current = workletNode;
    setIsStreaming(true);
  }, [isStreaming, sessionId, socket]);

  const stopStreaming = useCallback((): void => {
    console.log('[DEBUG] stopStreaming called');
    
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect();
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current = null;
      console.log('[DEBUG] Worklet node disconnected');
    }

    if (sourceNodeRef.current) {
      sourceNodeRef.current.disconnect();
      sourceNodeRef.current = null;
      console.log('[DEBUG] Source node disconnected');
    }

    if (mediaStreamRef.current) {
      for (const track of mediaStreamRef.current.getTracks()) {
        track.stop();
      }
      mediaStreamRef.current = null;
      console.log('[DEBUG] Media stream stopped');
    }

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
      console.log('[DEBUG] Audio context closed');
    }

    if (sessionId) {
      console.log('[DEBUG] Sending session:abort for', sessionId);
      socket.emit('session:abort', sessionId);
    }

    setIsStreaming(false);
    console.log('[DEBUG] isStreaming set to false');
  }, [sessionId, socket]);

  return {
    socketConnected,
    isStreaming,
    sessionId,
    state,
    startStreaming,
    stopStreaming,
  };
}

function buildWorkletScript(): string {
  return `
class EchoHostPCMWorklet extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions.targetSampleRate;
    this.chunkSamples = options.processorOptions.chunkSamples;
    this.inputSampleRate = sampleRate;
    this.bufferedSamples = [];
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      return true;
    }

    const channelData = input[0];
    if (!channelData || channelData.length === 0) {
      return true;
    }

    const mono16k = this.downsample(channelData, this.inputSampleRate, this.targetSampleRate);
    for (let i = 0; i < mono16k.length; i += 1) {
      this.bufferedSamples.push(mono16k[i]);
    }

    while (this.bufferedSamples.length >= this.chunkSamples) {
      const int16 = new Int16Array(this.chunkSamples);
      for (let i = 0; i < this.chunkSamples; i += 1) {
        const sample = Math.max(-1, Math.min(1, this.bufferedSamples[i]));
        int16[i] = sample < 0 ? sample * 32768 : sample * 32767;
      }

      const chunk = new Uint8Array(int16.buffer.slice(0));
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
      this.bufferedSamples.splice(0, this.chunkSamples);
    }

    return true;
  }

  downsample(input, inRate, outRate) {
    if (inRate === outRate) {
      return input;
    }

    const ratio = inRate / outRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Float32Array(outputLength);
    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < outputLength) {
      const nextIndex = Math.floor((outputIndex + 1) * ratio);
      let accum = 0;
      let count = 0;

      for (let i = inputIndex; i < nextIndex && i < input.length; i += 1) {
        accum += input[i];
        count += 1;
      }

      output[outputIndex] = count > 0 ? accum / count : 0;
      outputIndex += 1;
      inputIndex = nextIndex;
    }

    return output;
  }
}

registerProcessor('echohost-pcm-worklet', EchoHostPCMWorklet);
`;
}
