// Aviation intent extraction + tool orchestration via NVIDIA NIM
// Two-phase design: extract intent from transcript, then execute the corresponding tool

import type {
  ExtractedIntent,
  AviationIntent,
  ToolCall,
} from "@echohost/shared";
import { AviationIntent as AviationIntentEnum } from "@echohost/shared";
import {
  fetchFlightStatus,
  fetchWeatherBriefing,
  trackBaggage,
  fetchGateInfo,
  fetchLoadFactor,
  checkCrewStatus,
  reportLostItem,
} from "../tools/tool-registry.js";

export interface ReasoningEngineConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export const DEFAULT_REASONING_CONFIG: ReasoningEngineConfig = {
  apiKey: process.env["NVIDIA_API_KEY"] ?? "",
  baseUrl:
    process.env["NVIDIA_LLM_BASE_URL"] ??
    "https://integrate.api.nvidia.com/v1",
  model:
    process.env["NVIDIA_LLM_MODEL"] ??
    "nvidia/llama-3.1-nemotron-70b-instruct",
  maxTokens: 512,
  timeoutMs: 15_000,
};

interface NIMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface NIMResponse {
  choices?: Array<{
    message?: { content?: string };
    delta?: { content?: string };
    finish_reason?: string;
  }>;
  error?: { message: string };
}

interface IntentExtractionResult {
  intent: AviationIntent;
  entities: Record<string, string>;
  confidence: number;
}

export type ToolCallCallback = (toolCall: ToolCall) => void;

export class ReasoningEngine {
  private readonly _config: ReasoningEngineConfig;

  constructor(config: Partial<ReasoningEngineConfig> = {}) {
    this._config = { ...DEFAULT_REASONING_CONFIG, ...config };
  }

  async reason(
    transcript: string,
    sessionId: string,
    onToolCall: ToolCallCallback
  ): Promise<{
    response: string;
    intent: ExtractedIntent;
    toolCalls: ToolCall[];
  }> {
    const collectedToolCalls: ToolCall[] = [];

    // Phase 1: Extract structured intent
    const extracted = await this._extractIntent(transcript);

    const intent: ExtractedIntent = {
      ...extracted,
      transcript,
    };

    // Governance guard — refuse non-aviation queries
    if (extracted.intent === AviationIntentEnum.UNKNOWN) {
      return {
        response:
          "I'm sorry, I can only assist with aviation-related requests. " +
          "Please ask about flights, gates, baggage, or airport services.",
        intent,
        toolCalls: [],
      };
    }

    // Phase 2: Execute the tool for this intent
    const toolResult = await this._executeTool(
      extracted,
      sessionId,
      (toolCall) => {
        collectedToolCalls.push(toolCall);
        onToolCall(toolCall);
      }
    );

    // Phase 3: Generate natural-language response
    const response = await this._generateResponse(
      transcript,
      extracted,
      toolResult
    );

    return { response, intent, toolCalls: collectedToolCalls };
  }

  // Extract structured intent from transcript
  private async _extractIntent(
    transcript: string
  ): Promise<IntentExtractionResult> {
    const systemPrompt = `You are an aviation intent parser. Extract the user's intent from their query.
Respond ONLY with valid JSON matching this schema exactly:
{"intent":"<INTENT>","entities":{"key":"value"},"confidence":0.0-1.0}

Valid intents: ${Object.values(AviationIntentEnum).join(", ")}

Entity extraction rules:
- CHECK_FLIGHT_STATUS / CHECK_GATE / CHECK_CONNECTION_TIME: extract "flightNumber" (e.g. "AI202")
- TRACK_BAGGAGE: extract "baggageId"
- GET_WEATHER_BRIEFING: extract "icaoCode" (4-letter ICAO airport code)
- CHECK_LOAD_FACTOR / CHECK_CREW_STATUS / CHECK_BAGGAGE_LOAD / CHECK_FUELING / CHECK_CATERING: extract "flightNumber"
- REPORT_LOST_ITEM: extract "description" and optionally "location"
- REPORT_SECURITY_ALERT: extract "location" and "alertType"
- If query is not aviation-related: use intent "UNKNOWN"

Be concise. Output JSON only.`;

    const messages: NIMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: transcript },
    ];

    try {
      const raw = await this._callNIM(messages);
      return this._parseIntentJSON(raw);
    } catch {
      return {
        intent: AviationIntentEnum.UNKNOWN,
        entities: {},
        confidence: 0,
      };
    }
  }

  // Execute tool based on extracted intent
  private async _executeTool(
    extracted: IntentExtractionResult,
    _sessionId: string,
    onToolCall: ToolCallCallback
  ): Promise<unknown> {
    const { intent, entities } = extracted;
    const invokedAt = Date.now();

    const recordCall = async <T>(
      toolName: string,
      fn: () => Promise<T>
    ): Promise<T> => {
      let result: T | undefined;
      let error: string | undefined;
      try {
        result = await fn();
      } catch (err) {
        error = err instanceof Error ? err.message : "Tool error";
      } finally {
        const toolCall: ToolCall = {
          toolName,
          parameters: entities,
          invokedAt,
          resolvedAt: Date.now(),
          result,
          error,
        };
        onToolCall(toolCall);
      }
      if (error !== undefined) throw new Error(error);
      return result!;
    };

    const fn = entities["flightNumber"];
    const bag = entities["baggageId"];
    const icao = entities["icaoCode"];

    switch (intent) {
      case AviationIntentEnum.CHECK_FLIGHT_STATUS:
        return recordCall("fetchFlightStatus", () =>
          fetchFlightStatus(fn ?? "UNKNOWN")
        );
      case AviationIntentEnum.CHECK_GATE:
        return recordCall("fetchGateInfo", () =>
          fetchGateInfo(fn ?? "UNKNOWN")
        );
      case AviationIntentEnum.TRACK_BAGGAGE:
        return recordCall("trackBaggage", () =>
          trackBaggage(bag ?? "UNKNOWN")
        );
      case AviationIntentEnum.GET_WEATHER_BRIEFING:
        return recordCall("fetchWeatherBriefing", () =>
          fetchWeatherBriefing(icao ?? "VABB")
        );
      case AviationIntentEnum.CHECK_LOAD_FACTOR:
        return recordCall("fetchLoadFactor", () =>
          fetchLoadFactor(fn ?? "UNKNOWN")
        );
      case AviationIntentEnum.CHECK_CREW_STATUS:
        return recordCall("checkCrewStatus", () =>
          checkCrewStatus(fn ?? "UNKNOWN")
        );
      case AviationIntentEnum.REPORT_LOST_ITEM:
        return recordCall("reportLostItem", () =>
          reportLostItem(
            entities["description"] ?? "Unknown item",
            entities["location"]
          )
        );
      default:
        return null;
    }
  }

  // Generate natural-language response from tool result
  private async _generateResponse(
    transcript: string,
    extracted: IntentExtractionResult,
    toolResult: unknown
  ): Promise<string> {
    const systemPrompt = `You are EchoHost, an aviation AI assistant. 
Respond in 1-2 short spoken sentences. Be direct and informative.
Aviation domain only. Do NOT use markdown formatting or bullet points.
Your response will be spoken aloud via text-to-speech.`;

    const userContent = `User said: "${transcript}"
Intent detected: ${extracted.intent}
Tool result: ${JSON.stringify(toolResult)}
Generate a spoken response.`;

    const messages: NIMMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ];

    try {
      return await this._callNIM(messages);
    } catch {
      return "I encountered an issue retrieving that information. Please try again.";
    }
  }

  // Call NVIDIA NIM API
  private async _callNIM(messages: NIMMessage[]): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this._config.timeoutMs
    );

    try {
      const response = await fetch(`${this._config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._config.apiKey}`,
        },
        body: JSON.stringify({
          model: this._config.model,
          messages,
          max_tokens: this._config.maxTokens,
          temperature: 0.1,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new Error(`NIM API error ${response.status}: ${body}`);
      }

      const data = (await response.json()) as NIMResponse;

      if (data.error) {
        throw new Error(`NIM error: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("NIM returned empty content");
      }

      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }

  // Parse and validate intent JSON
  private _parseIntentJSON(raw: string): IntentExtractionResult {
    const cleaned = raw.replace(/```(?:json)?/g, "").trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error(`Could not parse intent JSON: ${cleaned.slice(0, 200)}`);
    }

    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("intent" in parsed) ||
      !("entities" in parsed) ||
      !("confidence" in parsed)
    ) {
      throw new Error("Intent JSON missing required fields");
    }

    const obj = parsed as {
      intent: string;
      entities: Record<string, string>;
      confidence: number;
    };

    const knownIntents = Object.values(AviationIntentEnum) as string[];
    const intent: AviationIntent = knownIntents.includes(obj.intent)
      ? (obj.intent as AviationIntent)
      : AviationIntentEnum.UNKNOWN;

    return {
      intent,
      entities: obj.entities ?? {},
      confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
    };
  }
