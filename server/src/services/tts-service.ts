// Text-to-speech via NVIDIA Riva TTS (NIM endpoint)
// Streams audio chunks to client, supports barge-in abort

import fetch from 'node-fetch';

export interface TTSServiceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly voice: string;
  readonly sampleRateHz: number;
  readonly timeoutMs: number;
}

export const DEFAULT_TTS_CONFIG: TTSServiceConfig = {
  apiKey: process.env['NVIDIA_API_KEY'] ?? '',
  baseUrl: process.env['NVIDIA_TTS_BASE_URL'] ?? 'https://integrate.api.nvidia.com/v1',
  voice: process.env['NVIDIA_TTS_VOICE'] ?? 'English-US.Female-1',
  sampleRateHz: 22_050,
  timeoutMs: 20_000,
};

export type AudioChunkCallback = (chunk: ArrayBuffer) => void;

export class TTSService {
  private readonly _config: TTSServiceConfig;
  private readonly _activeRequests = new Map<string, AbortController>();

  constructor(config: Partial<TTSServiceConfig> = {}) {
    this._config = { ...DEFAULT_TTS_CONFIG, ...config };
  }

  async synthesize(
    text: string,
    sessionId: string,
    onChunk: AudioChunkCallback,
  ): Promise<void> {
    if (!text.trim()) return;

    const controller = new AbortController();
    this._activeRequests.set(sessionId, controller);
    const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);

    try {
      const response = await fetch(`${this._config.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this._config.apiKey}`,
        },
        body: JSON.stringify({
          model: 'nvidia/fastpitch-hifigan-tts',
          input: text,
          voice: this._config.voice,
          response_format: 'wav',
          sample_rate: this._config.sampleRateHz,
        }),
        signal: controller.signal as any,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new Error(`TTS request failed: ${response.status} ${body}`);
      }

      // node-fetch v2: response.body is a Node.js Readable stream
      const body = response.body;
      if (!body) {
        throw new Error('TTS response body is null');
      }

      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          (body as NodeJS.ReadableStream).destroy?.();
          resolve();
        };
        controller.signal.addEventListener('abort', onAbort, { once: true });

        (body as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
          const ab = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
          onChunk(ab as ArrayBuffer);
        });
        (body as NodeJS.ReadableStream).on('end', () => {
          controller.signal.removeEventListener('abort', onAbort);
          resolve();
        });
        (body as NodeJS.ReadableStream).on('error', (err: Error) => {
          controller.signal.removeEventListener('abort', onAbort);
          reject(err);
        });
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      throw err;
    } finally {
      clearTimeout(timeout);
      this._activeRequests.delete(sessionId);
    }
  }

  abort(sessionId: string): void {
    const controller = this._activeRequests.get(sessionId);
    if (controller) {
      controller.abort();
      this._activeRequests.delete(sessionId);
    }
  }
}
