import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import {
  AUDIO_SPEC,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type SessionConfig,
  type SystemState,
} from '../../../shared/types';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8080';

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

  const emitSessionConfig = useCallback((): void => {
    const config: SessionConfig = {
      clientId: options.clientId ?? 'web-client',
      language: options.language ?? 'en-US',
      guardrailsEnabled: true,
      audioSpec: AUDIO_SPEC,
    };
    socket.emit('session:config', config);
  }, [options.clientId, options.language, socket]);

  useEffect(() => {
    const onConnect = (): void => {
      console.log('[DEBUG] Socket connected');
      setSocketConnected(true);
      emitSessionConfig();
    };

    const onDisconnect = (): void => {
      console.log('[DEBUG] Socket disconnected');
      setSocketConnected(false);
      setSessionId(null);
    };

    const onSessionStart = (incomingSessionId: string): void => {
      console.log('[DEBUG] Session started:', incomingSessionId);
      setSessionId(incomingSessionId);
      sequenceRef.current = 0;
    };

    const onStateUpdate = (nextState: SystemState): void => {
      console.log('[DEBUG] State updated:', nextState.phase);
      setState(nextState);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('session:start', onSessionStart);
    socket.on('state:update', onStateUpdate);

    // Log initial connection status
    if (socket.connected) {
      console.log('[DEBUG] Socket already connected on effect mount');
      onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('session:start', onSessionStart);
      socket.off('state:update', onStateUpdate);
    };
  }, [emitSessionConfig, socket]);

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

    const audioContext = new AudioContext({ sampleRate: AUDIO_SPEC.SAMPLE_RATE });
    await audioContext.audioWorklet.addModule(
      URL.createObjectURL(new Blob([buildWorkletScript()], { type: 'application/javascript' })),
    );

    const sourceNode = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'echohost-pcm-worklet', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      processorOptions: {
        targetSampleRate: AUDIO_SPEC.SAMPLE_RATE,
        chunkSamples: AUDIO_SPEC.CHUNK_BYTES / 2,
      },
    });

    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!sessionId) {
        return;
      }

      const payload = event.data;
      if (!(payload instanceof ArrayBuffer)) {
        return;
      }

      socket.emit('audio:chunk', {
        seq: sequenceRef.current,
        capturedAt: Date.now(),
        payload,
        sessionId,
      });

      if (sequenceRef.current % 50 === 0) {
        console.log(`[DEBUG] Audio chunk sent: seq=${sequenceRef.current}`);
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
