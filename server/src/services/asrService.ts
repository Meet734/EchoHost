import { EventEmitter } from 'events';
import WebSocket from 'ws';

const NIM_REALTIME_URL =
  process.env.NIM_REALTIME_URL ?? 'ws://localhost:9000/v1/realtime?intent=transcription';

interface ASRSession {
  socket: WebSocket;
  isOpen: boolean;
  queue: Buffer[];
  language: string;
  lastPartial: string; // last partial transcript seen — used as fallback final on WS close
}

export interface TranscriptEvent {
  sessionId: string;
  text: string;
  isFinal: boolean;
}

export interface StreamErrorEvent {
  sessionId: string;
  message: string;
}

interface ASRServiceEvents {
  transcript: (event: TranscriptEvent) => void;
  'stream:error': (event: StreamErrorEvent) => void;
}

export class ASRService extends EventEmitter {
  private readonly sessions: Map<string, ASRSession> = new Map();

  public override on<K extends keyof ASRServiceEvents>(
    eventName: K,
    listener: ASRServiceEvents[K],
  ): this {
    return super.on(eventName, listener);
  }

  public createSession(sessionId: string, language: string): void {
    this.destroySession(sessionId);

    const socket = new WebSocket(NIM_REALTIME_URL);
    const session: ASRSession = {
      socket,
      isOpen: false,
      queue: [],
      language,
      lastPartial: '',
    };

    socket.on('open', () => {
      session.isOpen = true;
      console.log(`[SUCCESS] [ASRService] Connected to NIM for session ${sessionId}`);

      socket.send(
        JSON.stringify({
          type: 'session.start',
          sessionId,
          audio: {
            encoding: 'pcm_s16le',
            sampleRateHz: 16000,
            channels: 1,
          },
          language,
        }),
      );

      for (const bufferedChunk of session.queue) {
        socket.send(bufferedChunk);
      }
      session.queue.length = 0;
    });

    socket.on('message', (data) => {
      this.handleNIMMessage(sessionId, session, data);
    });

    socket.on('close', () => {
      session.isOpen = false;
      console.log(`[INFO] [ASRService] NIM stream closed for session ${sessionId}`);

      // If NIM closed without sending an isFinal event, synthesise one from the last partial
      if (session.lastPartial) {
        this.emit('transcript', { sessionId, text: session.lastPartial, isFinal: true });
        session.lastPartial = '';
      }

      this.sessions.delete(sessionId);
    });

    socket.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[ERROR] [ASRService] NIM stream error for ${sessionId}: ${message}`);
      this.emit('stream:error', { sessionId, message });
    });

    this.sessions.set(sessionId, session);
  }

  // Send audio chunk — queues it if the WS is not yet open
  public async pushAudio(sessionId: string, pcmChunk: Buffer): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.isOpen || session.socket.readyState !== WebSocket.OPEN) {
      session.queue.push(Buffer.from(pcmChunk));
      return;
    }

    session.socket.send(pcmChunk);
  }

  // Signal end-of-utterance to NIM — keeps the WS alive to receive the final transcript
  public finalise(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isOpen) return;

    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'session.stop', sessionId }));
      console.log(`[INFO] [ASRService] Sent session.stop for ${sessionId}`);
    }
    // Do NOT delete session or close socket here — wait for NIM to send isFinal + close
  }

  // Hard teardown — send stop signal and close connection immediately
  public destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.socket.readyState === WebSocket.OPEN) {
      session.socket.send(JSON.stringify({ type: 'session.stop', sessionId }));
      session.socket.close(1000, 'session closed');
    }

    this.sessions.delete(sessionId);
    console.log(`[INFO] [ASRService] Session destroyed: ${sessionId}`);
  }

  public async dispose(): Promise<void> {
    for (const sessionId of Array.from(this.sessions.keys())) {
      this.destroySession(sessionId);
    }
  }

  private handleNIMMessage(
    sessionId: string,
    session: ASRSession,
    data: WebSocket.RawData,
  ): void {
    const rawText = typeof data === 'string' ? data : data.toString('utf8');

    let payload: unknown;
    try {
      payload = JSON.parse(rawText);
    } catch {
      return;
    }

    const parsed = parseTranscriptPayload(payload);
    if (!parsed) return;

    // Track last partial so the WS close handler can emit a fallback final
    if (!parsed.isFinal) {
      session.lastPartial = parsed.text;
    } else {
      session.lastPartial = '';
    }

    this.emit('transcript', { sessionId, text: parsed.text, isFinal: parsed.isFinal });
  }
}

function parseTranscriptPayload(payload: unknown): { text: string; isFinal: boolean } | null {
  if (!isObject(payload)) return null;

  const type = asString(payload['type']);
  if (
    type !== 'transcript.delta' &&
    type !== 'transcript.final' &&
    type !== 'transcription'
  ) {
    return null;
  }

  const text =
    asString(payload['text']) ??
    asString(payload['delta']) ??
    asString(payload['transcript']) ??
    '';

  const isFinal =
    asBoolean(payload['isFinal']) ??
    asBoolean(payload['final']) ??
    type === 'transcript.final';

  if (!text) return null;

  return { text, isFinal };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
