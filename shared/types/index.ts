export const PROTOCOL_VERSION = "1.0.0" as const;

// Audio Pipeline Types
export interface AudioChunk {
  readonly pcm: Int16Array;
  readonly capturedAt: number;
  readonly seq: number;
}

// Binary wire format: [seq: Uint32 (4 bytes)] [capturedAt: Float64 (8 bytes)] [pcm: Int16[] (N bytes)]
export const AUDIO_HEADER_BYTES = 12 as const;

// Audio specification (16 kHz mono PCM)
export const AUDIO_SPEC = {
  sampleRate: 16_000 as const,
  channels: 1 as const,
  bitDepth: 16 as const,
  frameSize: 512 as const,
} as const;

export interface AudioPacket {
  readonly seq: number;
  readonly capturedAt: number;
  readonly pcmBuffer: ArrayBuffer;
}

// Session configuration
export interface SessionConfig {
  readonly clientId?: string;
  readonly language?: string;
  readonly guardrailsEnabled?: boolean;
  readonly audioSpec?: typeof AUDIO_SPEC;
}

// Overall system state
export interface SystemState {
  readonly sessionId: string;
  readonly isActive: boolean;
  readonly currentPhase: PipelineState;
  readonly transcript?: string;
  readonly response?: string;
  readonly error?: string;
}

// FSM Pipeline Phases - IDLE → LISTENING → VAD_ACTIVE → TRANSCRIBING → REASONING → SPEAKING → IDLE
export const PipelineState = {
  IDLE: "IDLE",
  LISTENING: "LISTENING",
  VAD_ACTIVE: "VAD_ACTIVE",
  TRANSCRIBING: "TRANSCRIBING",
  REASONING: "REASONING",
  SPEAKING: "SPEAKING",
  ERROR: "ERROR",
} as const;

export type PipelineState = (typeof PipelineState)[keyof typeof PipelineState];

// Valid state transitions
export const VALID_TRANSITIONS: Readonly<
  Record<PipelineState, readonly PipelineState[]>
> = {
  IDLE: [PipelineState.LISTENING],
  LISTENING: [PipelineState.VAD_ACTIVE, PipelineState.IDLE],
  VAD_ACTIVE: [PipelineState.TRANSCRIBING, PipelineState.LISTENING],
  TRANSCRIBING: [PipelineState.REASONING, PipelineState.ERROR],
  REASONING: [PipelineState.SPEAKING, PipelineState.ERROR],
  SPEAKING: [PipelineState.IDLE],
  ERROR: [],
} as const;

// FSM transition event
export interface StateTransitionEvent {
  readonly from: PipelineState;
  readonly to: PipelineState;
  readonly timestamp: number;
  readonly sessionId: string;
}

// VAD Types
export interface VADResult {
  readonly probability: number;
  readonly isSpeech: boolean;
  readonly frameTimestamp: number;
}

export interface VADConfig {
  readonly threshold: number;
  readonly windowSize: number;
  readonly minSpeechFrames: number;
  readonly silencePaddingFrames: number;
}

// Aviation Intents
export const AviationIntent = {
  CHECK_GATE: "CHECK_GATE",
  TRACK_BAGGAGE: "TRACK_BAGGAGE",
  CHECK_FLIGHT_STATUS: "CHECK_FLIGHT_STATUS",
  GET_WEATHER_BRIEFING: "GET_WEATHER_BRIEFING",
  CHECK_CONNECTION_TIME: "CHECK_CONNECTION_TIME",
  CHECK_LOUNGE_LOCATION: "CHECK_LOUNGE_LOCATION",
  REQUEST_MEAL_PREFERENCE: "REQUEST_MEAL_PREFERENCE",
  CHECK_UPGRADE_AVAILABILITY: "CHECK_UPGRADE_AVAILABILITY",
  REPORT_LOST_ITEM: "REPORT_LOST_ITEM",
  GET_WIFI_ACCESS: "GET_WIFI_ACCESS",
  CHECK_LOAD_FACTOR: "CHECK_LOAD_FACTOR",
  CHECK_CREW_STATUS: "CHECK_CREW_STATUS",
  LOG_MAINTENANCE: "LOG_MAINTENANCE",
  CHECK_BAGGAGE_LOAD: "CHECK_BAGGAGE_LOAD",
  CHECK_FUELING: "CHECK_FUELING",
  CHECK_CATERING: "CHECK_CATERING",
  GET_STAND_ALLOCATION: "GET_STAND_ALLOCATION",
  REPORT_SECURITY_ALERT: "REPORT_SECURITY_ALERT",
  UNKNOWN: "UNKNOWN",
} as const;

export type AviationIntent =
  (typeof AviationIntent)[keyof typeof AviationIntent];

// Intent extracted by ReasoningEngine
export interface ExtractedIntent {
  readonly intent: AviationIntent;
  readonly entities: Readonly<Record<string, string>>;
  readonly confidence: number;
  readonly transcript: string;
}

// Tool call made by LLM
export interface ToolCall {
  readonly toolName: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly invokedAt: number;
  readonly resolvedAt?: number;
  readonly result?: unknown;
  readonly error?: string;
}

// Latency breakdown for a turn (in ms)
export interface TurnLatency {
  readonly vadMs: number;
  readonly asrMs: number;
  readonly llmMs: number;
  readonly ttsFirstByteMs: number;
  readonly totalRoundTripMs: number;
}

// Telemetry snapshot for dashboard
export interface TelemetrySnapshot {
  readonly sessionId: string;
  readonly turnNumber: number;
  readonly timestamp: number;
  readonly latency: TurnLatency;
  readonly currentState: PipelineState;
  readonly vadProbability: number;
  readonly toolCalls: readonly ToolCall[];
  readonly transcript?: string;
  readonly response?: string;
}

// Socket.io typed events
export interface ServerToClientEvents {
  "pipeline:state": (event: StateTransitionEvent) => void;
  "asr:partial": (data: { text: string; sessionId: string }) => void;
  "asr:final": (data: { text: string; sessionId: string }) => void;
  "reasoning:intent": (intent: ExtractedIntent) => void;
  "tts:audio_chunk": (chunk: ArrayBuffer) => void;
  "tts:complete": (data: { sessionId: string }) => void;
  "telemetry:snapshot": (snapshot: TelemetrySnapshot) => void;
  "vad:probability": (data: { probability: number; isSpeech: boolean }) => void;
  "session:error": (data: { code: string; message: string }) => void;
  "session:ready": (data: { sessionId: string; protocolVersion: string }) => void;
}

export interface ClientToServerEvents {
  "audio:chunk": (packet: ArrayBuffer) => void;
  "session:start": (data: { clientVersion: string }) => void;
  "session:stop": () => void;
  "tts:interrupt": () => void;
}

// API Response Types
export interface FlightStatusResponse {
  readonly flightNumber: string;
  readonly status: "ON_TIME" | "DELAYED" | "CANCELLED" | "LANDED" | "UNKNOWN";
  readonly scheduledDeparture: string;
  readonly estimatedDeparture?: string;
  readonly gate?: string;
  readonly terminal?: string;
  readonly delayMinutes?: number;
  readonly source: "live" | "mock";
}

export interface BaggageTrackingResponse {
  readonly baggageId: string;
  readonly carousel?: number;
  readonly status:
    | "IN_TRANSIT"
    | "AT_CAROUSEL"
    | "DELIVERED"
    | "DELAYED"
    | "LOST";
  readonly lastUpdated: string;
}

export interface WeatherBriefingResponse {
  readonly airport: string;
  readonly icaoCode: string;
  readonly rawMetar: string;
  readonly windDirection: number;
  readonly windSpeedKts: number;
  readonly visibilityMiles: number;
  readonly conditions: string;
  readonly timestamp: string;
}

export interface GateInfoResponse {
  readonly flightNumber: string;
  readonly gate: string;
  readonly terminal: string;
  readonly boardingTime?: string;
  readonly walkingMinutes?: number;
}

// Error Codes
export const ErrorCode = {
  INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION",
  AUDIO_BUFFER_OVERFLOW: "AUDIO_BUFFER_OVERFLOW",
  ASR_CONNECTION_FAILED: "ASR_CONNECTION_FAILED",
  LLM_RATE_LIMITED: "LLM_RATE_LIMITED",
  LLM_INVALID_RESPONSE: "LLM_INVALID_RESPONSE",
  TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED",
  TTS_CONNECTION_FAILED: "TTS_CONNECTION_FAILED",
  SESSION_TIMEOUT: "SESSION_TIMEOUT",
  PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH",
  GOVERNANCE_VIOLATION: "GOVERNANCE_VIOLATION",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
