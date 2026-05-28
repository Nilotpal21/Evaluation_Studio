import type { Readable } from 'stream';
import type { ScanStatus } from '../types.js';

export interface ScanProvider {
  readonly name: string;

  scan(params: { fileStream: Readable; filename: string; sizeBytes: number }): Promise<{
    status: Exclude<ScanStatus, 'pending'>;
    engine: string;
    threats?: string[];
    scannedAt: Date;
  }>;

  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
