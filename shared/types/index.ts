// Immutable audio spec negotiated at WebSocket handshake
export const AUDIO_SPEC = {
  SAMPLE_RATE: 16_000,
  CHANNELS: 1,
  BIT_DEPTH: 16,
  CHUNK_DURATION_MS: 20,
  CHUNK_BYTES: 640,
} as const;

export type AudioSpec = typeof AUDIO_SPEC;

// One 20 ms chunk of PCM-S16LE audio flowing over the WebSocket
export interface AudioPacket {
  seq: number;
  capturedAt: number;
  payload: ArrayBuffer | Buffer;
  isSpeech: boolean;
  rmsDb: number;
  sessionId: string;
}

// All FSM phases: idle → listening → processing → speaking → idle
// 'error' is terminal — client must reconnect
export type PipelinePhase =
  | 'idle'
  | 'listening'
  | 'processing'
  | 'speaking'
  | 'error';

// Latency breakdown per turn — all values in ms
export interface TurnLatency {
  asrMs: number;
  reasoningMs: number;
  ttsMs: number;
  e2eMs: number;
}

// Broadcast on every FSM transition
export interface SystemState {
  phase: PipelinePhase;
  sessionId: string | null;
  transcript: string;
  isFinal: boolean;
  intent: string | null;
  lastTurnLatency: TurnLatency | null;
  updatedAt: number;
  error: PipelineError | null;
}

export interface PipelineError {
  code: PipelineErrorCode;
  message: string;
  timestamp: string;
  layer: 'vad' | 'asr' | 'reasoning' | 'tts' | 'guardrails' | 'transport';
}

export type PipelineErrorCode =
  | 'AUDIO_BUFFER_OVERFLOW'
  | 'ASR_STREAM_TIMEOUT'
  | 'NIM_RATE_LIMIT'
  | 'NIM_UNAVAILABLE'
  | 'GUARDRAILS_VIOLATION'
  | 'TTS_STREAM_ERROR'
  | 'UNKNOWN';

// All tool IDs the reasoning layer can invoke
export type AviationActionId =
  | 'FETCH_FLIGHT_STATUS'
  | 'FETCH_GATE_INFO'
  | 'FETCH_WEATHER_METAR'
  | 'FETCH_NOTAM'
  | 'REBOOK_PASSENGER'
  | 'ESCALATE_TO_HUMAN'
  | 'PLAYBACK_ANNOUNCEMENT'
  | 'LOG_INCIDENT';

export type TaskSeverity = 'routine' | 'advisory' | 'urgent' | 'emergency';

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

// One agentic tool call produced by the reasoning layer
export interface AviationTask {
  taskId: string;     // UUID-v4
  sessionId: string;
  actionId: AviationActionId;
  params: AviationTaskParams;
  severity: TaskSeverity;
  status: TaskStatus;
  createdAt: string;
  resolvedAt: string | null;
  result: AviationTaskResult | null;
  errorMessage: string | null;
}

// Discriminated union — one params type per action
export type AviationTaskParams =
  | FetchFlightStatusParams
  | FetchGateInfoParams
  | FetchWeatherMetarParams
  | FetchNotamParams
  | RebookPassengerParams
  | EscalateToHumanParams
  | PlaybackAnnouncementParams
  | LogIncidentParams;

export interface FetchFlightStatusParams {
  actionId: 'FETCH_FLIGHT_STATUS';
  flightNumber: string;
  date: string;
}

export interface FetchGateInfoParams {
  actionId: 'FETCH_GATE_INFO';
  flightNumber: string;
  terminal?: string;
}

export interface FetchWeatherMetarParams {
  actionId: 'FETCH_WEATHER_METAR';
  icaoCode: string;
}

export interface FetchNotamParams {
  actionId: 'FETCH_NOTAM';
  icaoCode: string;
  notamType?: 'airport' | 'enroute' | 'fdc';
}

export interface RebookPassengerParams {
  actionId: 'REBOOK_PASSENGER';
  passengerId: string;
  originalFlight: string;
  targetFlight: string;
  seatPreference?: 'window' | 'aisle' | 'middle';
}

export interface EscalateToHumanParams {
  actionId: 'ESCALATE_TO_HUMAN';
  reason: string;
  priority: 'normal' | 'high' | 'critical';
}

export interface PlaybackAnnouncementParams {
  actionId: 'PLAYBACK_ANNOUNCEMENT';
  gate: string;
  message: string;
  language?: string;
}

export interface LogIncidentParams {
  actionId: 'LOG_INCIDENT';
  incidentType: string;
  description: string;
  flightNumber?: string;
}

export interface AviationTaskResult {
  success: boolean;
  data: Record<string, unknown>;
  summary: string;
}

// Socket.io typed event maps
export interface ServerToClientEvents {
  'state:update':  (state: SystemState) => void;
  'task:update':   (task: AviationTask) => void;
  'audio:chunk':   (chunk: ArrayBuffer) => void;
  'session:start': (sessionId: string) => void;
  'session:end':   (sessionId: string, latency: TurnLatency) => void;
  'error':         (err: PipelineError) => void;
}

export interface ClientToServerEvents {
  'audio:chunk':    (packet: Omit<AudioPacket, 'isSpeech' | 'rmsDb'>) => void;
  'session:abort':  (sessionId: string) => void;
  'session:config': (config: SessionConfig) => void;
}

export interface SessionConfig {
  clientId: string;
  audioSpec: AudioSpec;
  language: string;
  guardrailsEnabled: boolean;
}
