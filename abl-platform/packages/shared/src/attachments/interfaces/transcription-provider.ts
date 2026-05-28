import type { Readable } from 'stream';

export interface TranscriptionProvider {
  readonly name: string;

  transcribe(params: {
    audioStream: Readable;
    mimeType: string;
    language?: string;
    options?: {
      diarization?: boolean;
      punctuation?: boolean;
      wordTimestamps?: boolean;
    };
  }): Promise<{
    text: string;
    language: string;
    durationSeconds: number;
    segments?: Array<{
      start: number;
      end: number;
      text: string;
      speaker?: string;
    }>;
    engine: string;
  }>;

  supportedFormats(): string[];
}
