// Riva TTS via NVIDIA NIM — streams raw PCM-S16LE back to the caller
// Uses the OpenAI-compatible /audio/speech endpoint with streaming response body

const NIM_TTS_ENDPOINT =
  process.env.NVIDIA_TTS_ENDPOINT ?? 'https://integrate.api.nvidia.com/v1';
const NIM_TTS_MODEL  = process.env.NVIDIA_TTS_MODEL ?? 'nvidia/riva-tts';
const TTS_VOICE      = process.env.TTS_VOICE ?? 'English-US.Female-1';
const TTS_SAMPLE_RATE = 22050; // Riva default; client resamples to 16kHz for playback
const CHUNK_SIZE_BYTES = 4096; // bytes per onChunk callback
const REQUEST_TIMEOUT_MS = 10_000;

export class TTSService {
  private readonly controllers: Map<string, AbortController> = new Map();

  // Synthesise `text` and stream PCM chunks via callbacks
  async synthesise(
    sessionId: string,
    text: string,
    onChunk: (pcm: Buffer) => void,
    onDone: () => void,
    onError: (err: Error) => void,
  ): Promise<void> {
    // Clean up any previous in-flight synthesis for this session
    this.abort(sessionId);

    const controller = new AbortController();
    this.controllers.set(sessionId, controller);

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      onError(new Error('[TTSService] NVIDIA_API_KEY is not set.'));
      return;
    }

    console.log(`[INFO] [TTSService] Synthesising for session ${sessionId}: "${text.slice(0, 60)}..."`);

    try {
      const response = await fetch(`${NIM_TTS_ENDPOINT}/audio/speech`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type':  'application/json',
          'Accept':        'audio/basic',
        },
        body: JSON.stringify({
          model:       NIM_TTS_MODEL,
          input:       text,
          voice:       TTS_VOICE,
          response_format: 'pcm',
          sample_rate: TTS_SAMPLE_RATE,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errBody = await response.text().catch(() => response.statusText);
        throw new Error(`[TTSService] NIM returned ${response.status}: ${errBody}`);
      }

      const body = response.body;
      if (!body) {
        throw new Error('[TTSService] Response body is null.');
      }

      // Stream the response body, emitting fixed-size PCM chunks
      const reader = body.getReader();
      let carry = Buffer.alloc(0);

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          // Flush any remaining bytes
          if (carry.length > 0) {
            onChunk(carry);
          }
          break;
        }

        // Accumulate into carry and emit full CHUNK_SIZE_BYTES slices
        carry = Buffer.concat([carry, Buffer.from(value)]);
        while (carry.length >= CHUNK_SIZE_BYTES) {
          onChunk(carry.subarray(0, CHUNK_SIZE_BYTES));
          carry = carry.subarray(CHUNK_SIZE_BYTES);
        }
      }

      console.log(`[SUCCESS] [TTSService] Synthesis complete for session ${sessionId}`);
      onDone();

    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Aborted deliberately — not an error condition
        console.log(`[INFO] [TTSService] Synthesis aborted for session ${sessionId}`);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ERROR] [TTSService] ${message}`);
      onError(new Error(message));
    } finally {
      clearTimeout(timeoutId);
      this.controllers.delete(sessionId);
    }
  }

  // Cancel an in-flight synthesis immediately
  abort(sessionId: string): void {
    const controller = this.controllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.controllers.delete(sessionId);
    }
  }

  dispose(): void {
    for (const [sessionId, controller] of this.controllers) {
      controller.abort();
      console.log(`[INFO] [TTSService] Aborted session ${sessionId} on dispose.`);
    }
    this.controllers.clear();
  }
}
