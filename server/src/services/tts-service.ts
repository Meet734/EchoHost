// Text-to-speech via NVIDIA Riva TTS (NIM endpoint)
// Streams audio chunks to client, supports barge-in abort mechanism

export interface TTSServiceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly voice: string;
  readonly sampleRateHz: number;
  readonly timeoutMs: number;
}

export const DEFAULT_TTS_CONFIG: TTSServiceConfig = {
  apiKey: process.env["NVIDIA_API_KEY"] ?? "",
  baseUrl:
    process.env["NVIDIA_TTS_BASE_URL"] ??
    "https://integrate.api.nvidia.com/v1",
  voice: process.env["NVIDIA_TTS_VOICE"] ?? "English-US.Female-1",
  sampleRateHz: 22_050,
  timeoutMs: 20_000,
};

export type AudioChunkCallback = (chunk: ArrayBuffer) => void;

interface NIMTTSResponse {
  audio?: string;
  error?: { message: string };
}

export class TTSService {
  private readonly _config: TTSServiceConfig;
  private readonly _activeRequests = new Map<string, AbortController>();

  constructor(config: Partial<TTSServiceConfig> = {}) {
    this._config = { ...DEFAULT_TTS_CONFIG, ...config };
  }

  // Synthesise text and stream audio chunks
  async synthesize(
    text: string,
    sessionId: string,
    onChunk: AudioChunkCallback
  ): Promise<void> {
    if (!text.trim()) return;

    const controller = new AbortController();
    this._activeRequests.set(sessionId, controller);

    const timeout = setTimeout(
      () => controller.abort(),
      this._config.timeoutMs
    );

    try {
      const response = await fetch(`${this._config.baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this._config.apiKey}`,
        },
        body: JSON.stringify({
          model: "nvidia/fastpitch-hifigan-tts",
          input: text,
          voice: this._config.voice,
          response_format: "wav",
          sample_rate: this._config.sampleRateHz,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "<unreadable>");
        throw new Error(`TTS request failed: ${response.status} ${body}`);
      }

      if (response.body) {
        await this._streamResponseBody(response.body, onChunk, controller.signal);
      } else {
        const data = (await response.json()) as NIMTTSResponse;
        if (data.error) throw new Error(`TTS error: ${data.error.message}`);
        if (data.audio) {
          const audioBytes = Buffer.from(data.audio, "base64");
          onChunk(
            audioBytes.buffer.slice(
              audioBytes.byteOffset,
              audioBytes.byteOffset + audioBytes.byteLength
            )
          );
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      throw err;
    } finally {
      clearTimeout(timeout);
      this._activeRequests.delete(sessionId);
    }
  }

  // Abort synthesis for session (barge-in)
  abort(sessionId: string): void {
    const controller = this._activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this._activeRequests.delete(sessionId);
    }
  }

  private async _streamResponseBody(
    body: NodeJS.ReadableStream,
    onChunk: AudioChunkCallback,
    signal: AbortSignal
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        resolve();
        return;
      }

      const onAbort = () => {
        body.destroy?.();
        resolve();
      };

      signal.addEventListener("abort", onAbort, { once: true });

      body.on("data", (chunk: Buffer | Uint8Array) => {
        const buffer =
          chunk instanceof Buffer
            ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
            : chunk.buffer;
        onChunk(buffer);
      });

      body.on("end", () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });

      body.on("error", (err: Error) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      });
    });
  }
