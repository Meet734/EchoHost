export declare const PROTOCOL_VERSION: "1.0.0";
export interface AudioChunk {
    readonly pcm: Int16Array;
    readonly capturedAt: number;
    readonly seq: number;
}
export declare const AUDIO_HEADER_BYTES: 12;
export declare const AUDIO_SPEC: {
    readonly sampleRate: 16000;
    readonly channels: 1;
    readonly bitDepth: 16;
    readonly frameSize: 512;
};
export interface AudioPacket {
    readonly seq: number;
    readonly capturedAt: number;
    readonly pcmBuffer: ArrayBuffer;
}
export interface SessionConfig {
    readonly clientId?: string;
    readonly language?: string;
    readonly guardrailsEnabled?: boolean;
    readonly audioSpec?: typeof AUDIO_SPEC;
}
export interface SystemState {
    readonly sessionId: string;
    readonly isActive: boolean;
    readonly currentPhase: PipelineState;
    readonly transcript?: string;
    readonly response?: string;
    readonly error?: string;
}
export declare const PipelineState: {
    readonly IDLE: "IDLE";
    readonly LISTENING: "LISTENING";
    readonly VAD_ACTIVE: "VAD_ACTIVE";
    readonly TRANSCRIBING: "TRANSCRIBING";
    readonly REASONING: "REASONING";
    readonly SPEAKING: "SPEAKING";
    readonly ERROR: "ERROR";
};
export type PipelineState = (typeof PipelineState)[keyof typeof PipelineState];
export declare const VALID_TRANSITIONS: Readonly<Record<PipelineState, readonly PipelineState[]>>;
export interface StateTransitionEvent {
    readonly from: PipelineState;
    readonly to: PipelineState;
    readonly timestamp: number;
    readonly sessionId: string;
}
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
export declare const AviationIntent: {
    readonly CHECK_GATE: "CHECK_GATE";
    readonly TRACK_BAGGAGE: "TRACK_BAGGAGE";
    readonly CHECK_FLIGHT_STATUS: "CHECK_FLIGHT_STATUS";
    readonly GET_WEATHER_BRIEFING: "GET_WEATHER_BRIEFING";
    readonly CHECK_CONNECTION_TIME: "CHECK_CONNECTION_TIME";
    readonly CHECK_LOUNGE_LOCATION: "CHECK_LOUNGE_LOCATION";
    readonly REQUEST_MEAL_PREFERENCE: "REQUEST_MEAL_PREFERENCE";
    readonly CHECK_UPGRADE_AVAILABILITY: "CHECK_UPGRADE_AVAILABILITY";
    readonly REPORT_LOST_ITEM: "REPORT_LOST_ITEM";
    readonly GET_WIFI_ACCESS: "GET_WIFI_ACCESS";
    readonly CHECK_LOAD_FACTOR: "CHECK_LOAD_FACTOR";
    readonly CHECK_CREW_STATUS: "CHECK_CREW_STATUS";
    readonly LOG_MAINTENANCE: "LOG_MAINTENANCE";
    readonly CHECK_BAGGAGE_LOAD: "CHECK_BAGGAGE_LOAD";
    readonly CHECK_FUELING: "CHECK_FUELING";
    readonly CHECK_CATERING: "CHECK_CATERING";
    readonly GET_STAND_ALLOCATION: "GET_STAND_ALLOCATION";
    readonly REPORT_SECURITY_ALERT: "REPORT_SECURITY_ALERT";
    readonly UNKNOWN: "UNKNOWN";
};
export type AviationIntent = (typeof AviationIntent)[keyof typeof AviationIntent];
export interface ExtractedIntent {
    readonly intent: AviationIntent;
    readonly entities: Readonly<Record<string, string>>;
    readonly confidence: number;
    readonly transcript: string;
}
export interface ToolCall {
    readonly toolName: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    readonly invokedAt: number;
    readonly resolvedAt?: number;
    readonly result?: unknown;
    readonly error?: string;
}
export interface TurnLatency {
    readonly vadMs: number;
    readonly asrMs: number;
    readonly llmMs: number;
    readonly ttsFirstByteMs: number;
    readonly totalRoundTripMs: number;
}
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
export interface ServerToClientEvents {
    "pipeline:state": (event: StateTransitionEvent) => void;
    "asr:partial": (data: {
        text: string;
        sessionId: string;
    }) => void;
    "asr:final": (data: {
        text: string;
        sessionId: string;
    }) => void;
    "reasoning:intent": (intent: ExtractedIntent) => void;
    "tts:audio_chunk": (chunk: ArrayBuffer) => void;
    "tts:complete": (data: {
        sessionId: string;
    }) => void;
    "telemetry:snapshot": (snapshot: TelemetrySnapshot) => void;
    "vad:probability": (data: {
        probability: number;
        isSpeech: boolean;
    }) => void;
    "session:error": (data: {
        code: string;
        message: string;
    }) => void;
    "session:ready": (data: {
        sessionId: string;
        protocolVersion: string;
    }) => void;
}
export interface ClientToServerEvents {
    "audio:chunk": (packet: ArrayBuffer) => void;
    "session:start": (data: {
        clientVersion: string;
    }) => void;
    "session:stop": () => void;
    "tts:interrupt": () => void;
}
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
    readonly status: "IN_TRANSIT" | "AT_CAROUSEL" | "DELIVERED" | "DELAYED" | "LOST";
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
export declare const ErrorCode: {
    readonly INVALID_STATE_TRANSITION: "INVALID_STATE_TRANSITION";
    readonly AUDIO_BUFFER_OVERFLOW: "AUDIO_BUFFER_OVERFLOW";
    readonly ASR_CONNECTION_FAILED: "ASR_CONNECTION_FAILED";
    readonly LLM_RATE_LIMITED: "LLM_RATE_LIMITED";
    readonly LLM_INVALID_RESPONSE: "LLM_INVALID_RESPONSE";
    readonly TOOL_EXECUTION_FAILED: "TOOL_EXECUTION_FAILED";
    readonly TTS_CONNECTION_FAILED: "TTS_CONNECTION_FAILED";
    readonly SESSION_TIMEOUT: "SESSION_TIMEOUT";
    readonly PROTOCOL_VERSION_MISMATCH: "PROTOCOL_VERSION_MISMATCH";
    readonly GOVERNANCE_VIOLATION: "GOVERNANCE_VIOLATION";
};
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
