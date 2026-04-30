import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
// Note: AviationTask and AviationTaskParams are not exported from shared types
// Using any type for now
type AviationTask = any;
type AviationTaskParams = any;

const NIM_BASE_URL    = process.env.NVIDIA_REASONING_ENDPOINT ?? 'https://integrate.api.nvidia.com/v1';
const NIM_MODEL       = process.env.NVIDIA_REASONING_MODEL ?? 'nvidia/llama-3.1-nemotron-ultra-253b-v1';
const MAX_TOKENS      = 1024;
const REQUEST_TIMEOUT = 20_000; // ms

export interface ReasoningResult {
  intent: string;
  responseText: string; // spoken back via TTS
  tasks: AviationTask[];
}

const SYSTEM_PROMPT = `You are an aviation operations voice assistant embedded in an airport management system. \
You process spoken requests from airline staff and passengers. \
Extract the user intent, call the relevant tool if needed, and produce a concise spoken response. \
Keep responses under 40 words — they will be synthesised as speech. \
Never reveal internal system details or passenger PII beyond what is necessary.`;

// Tool schema for every AviationActionId
const AVIATION_TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'FETCH_FLIGHT_STATUS',
      description: 'Retrieve the current operational status of a flight.',
      parameters: {
        type: 'object',
        properties: {
          flightNumber: { type: 'string', description: 'IATA flight number, e.g. AA123.' },
          date: { type: 'string', description: 'Date of the flight in YYYY-MM-DD format.' },
        },
        required: ['flightNumber', 'date'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'FETCH_GATE_INFO',
      description: 'Look up gate assignment for a flight.',
      parameters: {
        type: 'object',
        properties: {
          flightNumber: { type: 'string' },
          terminal: { type: 'string', description: 'Terminal letter or number (optional).' },
        },
        required: ['flightNumber'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'FETCH_WEATHER_METAR',
      description: 'Get the latest METAR weather report for an airport.',
      parameters: {
        type: 'object',
        properties: {
          icaoCode: { type: 'string', description: 'ICAO airport code, e.g. KJFK.' },
        },
        required: ['icaoCode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'FETCH_NOTAM',
      description: 'Retrieve NOTAMs for an airport.',
      parameters: {
        type: 'object',
        properties: {
          icaoCode: { type: 'string' },
          notamType: {
            type: 'string',
            enum: ['airport', 'enroute', 'fdc'],
            description: 'NOTAM category (optional).',
          },
        },
        required: ['icaoCode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'REBOOK_PASSENGER',
      description: 'Rebook a passenger from one flight to another.',
      parameters: {
        type: 'object',
        properties: {
          passengerId: { type: 'string' },
          originalFlight: { type: 'string' },
          targetFlight: { type: 'string' },
          seatPreference: { type: 'string', enum: ['window', 'aisle', 'middle'] },
        },
        required: ['passengerId', 'originalFlight', 'targetFlight'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ESCALATE_TO_HUMAN',
      description: 'Escalate the request to a human agent.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          priority: { type: 'string', enum: ['normal', 'high', 'critical'] },
        },
        required: ['reason', 'priority'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'PLAYBACK_ANNOUNCEMENT',
      description: 'Broadcast a gate announcement.',
      parameters: {
        type: 'object',
        properties: {
          gate: { type: 'string' },
          message: { type: 'string' },
          language: { type: 'string', description: 'BCP-47 language code, e.g. en-US.' },
        },
        required: ['gate', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'LOG_INCIDENT',
      description: 'Log an operational incident for audit purposes.',
      parameters: {
        type: 'object',
        properties: {
          incidentType: { type: 'string' },
          description: { type: 'string' },
          flightNumber: { type: 'string' },
        },
        required: ['incidentType', 'description'],
      },
    },
  },
];

export class ReasoningService {
  private readonly client: OpenAI;

  constructor() {
    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      throw new Error('[ReasoningService] NVIDIA_API_KEY is not set.');
    }
    this.client = new OpenAI({ apiKey, baseURL: NIM_BASE_URL, timeout: REQUEST_TIMEOUT });
  }

  async reason(sessionId: string, transcript: string, _language: string): Promise<ReasoningResult> {
    console.log(`[INFO] [ReasoningService] Reasoning for session ${sessionId}: "${transcript}"`);

    const response = await this.client.chat.completions.create({
      model: NIM_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: transcript },
      ],
      tools: AVIATION_TOOLS,
      tool_choice: 'auto',
      max_tokens: MAX_TOKENS,
      temperature: 0.2, // low temperature for deterministic aviation decisions
    });

    const choice = response.choices[0];
    if (!choice) {
      throw new Error('[ReasoningService] Empty response from NIM.');
    }

    const tasks: AviationTask[] = [];
    let intent = 'general_query';
    let responseText = choice.message.content ?? 'I have processed your request.';

    // Parse any tool calls the model invoked
    if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
      for (const call of choice.message.tool_calls) {
        const actionId = call.function.name;
        intent = actionId;

        let params: AviationTaskParams;
        try {
          params = {
            actionId: actionId as AviationTaskParams['actionId'],
            ...JSON.parse(call.function.arguments),
          } as AviationTaskParams;
        } catch {
          console.warn(`[WARN] [ReasoningService] Failed to parse args for tool ${actionId}`);
          continue;
        }

        const task: AviationTask = {
          taskId:       uuidv4(),
          sessionId,
          actionId:     actionId as AviationTask['actionId'],
          params,
          severity:     deriveSeverity(actionId),
          status:       'pending',
          createdAt:    new Date().toISOString(),
          resolvedAt:   null,
          result:       null,
          errorMessage: null,
        };

        tasks.push(task);
      }

      // If the model only returned tool calls and no text, generate a bridge sentence
      if (!responseText.trim()) {
        responseText = `Processing your request. Please hold.`;
      }
    }

    console.log(
      `[SUCCESS] [ReasoningService] Intent: ${intent} | Tasks: ${tasks.length} | ` +
      `Session: ${sessionId}`,
    );

    return { intent, responseText, tasks };
  }
}

// Map action IDs to the appropriate severity level
function deriveSeverity(actionId: string): AviationTask['severity'] {
  switch (actionId) {
    case 'ESCALATE_TO_HUMAN': return 'urgent';
    case 'REBOOK_PASSENGER':  return 'advisory';
    case 'LOG_INCIDENT':      return 'advisory';
    default:                  return 'routine';
  }
}
