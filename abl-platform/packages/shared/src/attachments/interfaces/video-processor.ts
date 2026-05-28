import type { Readable } from 'stream';

export interface VideoProcessor {
  readonly name: string;

  extractAudio(params: {
    videoStream: Readable;
    outputFormat: 'wav' | 'mp3' | 'ogg';
  }): Promise<{ audioStream: Readable; durationSeconds: number }>;

  extractKeyFrames(params: {
    videoStream: Readable;
    strategy: 'interval' | 'scene_change';
    maxFrames: number;
    intervalSeconds?: number;
  }): Promise<{ frames: Buffer[]; timestamps: number[] }>;

  supportedFormats(): string[];

  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
