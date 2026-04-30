// Speech-to-text via NVIDIA NIM (Parakeet-TDT-1.1B)
// Encodes PCM to WAV in-process and streams word-by-word partials

import FormData from 'form-data';
import fetch from 'node-fetch';

export interface ASRServiceConfig {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly language: string;
  readonly timeoutMs: number;
}

export const DEFAULT_ASR_CONFIG: ASRServiceConfig = {
  apiKey: process.env['NVIDIA_API_KEY'] ?? '',
  baseUrl: process.env['NVIDIA_ASR_BASE_URL'] ?? 'https://integrate.api.nvidia.com/v1',
  model: process.env['NVIDIA_ASR_MODEL'] ?? 'nvidia/parakeet-tdt-1.1b',
  language: 'en-US',
  timeoutMs: 10_000,
};

const WAV_SAMPLE_RATE = 16_000;
const WAV_BIT_DEPTH = 16;
const WAV_CHANNELS = 1;
const WAV_HEADER_SIZE = 44;

export type PartialTranscriptCallback = (partial: string) => void;

export class ASRService {
  private readonly _config: ASRServiceConfig;

  constructor(config: Partial<ASRServiceConfig> = {}) {
    this._config = { ...DEFAULT_ASR_CONFIG, ...config };
  }

  async transcribe(
    pcm: Int16Array,
    _sessionId: string,
    onPartial: PartialTranscriptCallback,
  ): Promise<string> {
    const wavBuffer = this._encodePcmToWav(pcm);
    const form = new FormData();
    form.append('audio', wavBuffer, {
      filename: 'audio.wav',
      contentType: 'audio/wav',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);

    let response;
    try {
      response = await fetch(`${this._config.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this._config.apiKey}`,
          ...form.getHeaders(),
        },
        body: form as any,
        signal: controller.signal as any,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '<unreadable>');
      throw new Error(`ASR request failed: ${response.status} ${response.statusText} — ${body}`);
    }

    const data = (await response.json()) as { text?: string };
    const transcript = data.text?.trim() ?? '';

    this._simulatePartials(transcript, onPartial);
    return transcript;
  }

  private _encodePcmToWav(pcm: Int16Array): Buffer {
    const dataBytes = pcm.length * 2;
    const totalBytes = WAV_HEADER_SIZE + dataBytes;
    const buf = Buffer.alloc(totalBytes);

    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(totalBytes - 8, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(WAV_CHANNELS, 22);
    buf.writeUInt32LE(WAV_SAMPLE_RATE, 24);
    buf.writeUInt32LE((WAV_SAMPLE_RATE * WAV_CHANNELS * WAV_BIT_DEPTH) / 8, 28);
    buf.writeUInt16LE((WAV_CHANNELS * WAV_BIT_DEPTH) / 8, 32);
    buf.writeUInt16LE(WAV_BIT_DEPTH, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);

    for (let i = 0; i < pcm.length; i++) {
      buf.writeInt16LE(pcm[i] ?? 0, WAV_HEADER_SIZE + i * 2);
    }
    return buf;
  }

  private _simulatePartials(transcript: string, onPartial: PartialTranscriptCallback): void {
    const words = transcript.split(/\s+/).filter(Boolean);
    let accumulated = '';
    words.forEach((word, i) => {
      setTimeout(() => {
        accumulated += (i === 0 ? '' : ' ') + word;
        onPartial(accumulated);
      }, i * 40);
    });
  }
}
