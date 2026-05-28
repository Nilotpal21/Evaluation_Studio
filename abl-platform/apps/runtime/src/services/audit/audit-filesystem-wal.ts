import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@abl/compiler/platform';
import type { AuditEvent, AuditStream } from '@abl/compiler/platform/stores/audit-pipeline.js';

const log = createLogger('audit-filesystem-wal');
const SUPPORTED_WAL_STREAMS = new Set<AuditStream>([
  'shared',
  'kms',
  'pii',
  'connector',
  'crawl',
  'arch',
  'omnichannel',
]);

export interface AuditWALConfig {
  directory: string;
  maxFileSizeBytes?: number;
  maxRetentionHours?: number;
  flushIntervalMs?: number;
  maxBufferSize?: number;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_RETENTION_HOURS = 24;
const DEFAULT_FLUSH_INTERVAL_MS = 100;
const DEFAULT_MAX_BUFFER_SIZE = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseAuditEvent(payload: unknown): AuditEvent {
  if (!isRecord(payload)) {
    throw new Error('WAL payload must be an object');
  }

  const timestampValue = payload.timestamp;
  const timestamp =
    timestampValue instanceof Date ? timestampValue : new Date(String(timestampValue));
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error('WAL payload is missing a valid timestamp');
  }

  if (typeof payload.auditId !== 'string' || payload.auditId.length === 0) {
    throw new Error('WAL payload is missing auditId');
  }

  if (
    typeof payload.stream !== 'string' ||
    !SUPPORTED_WAL_STREAMS.has(payload.stream as AuditStream)
  ) {
    throw new Error('WAL payload has unsupported stream');
  }

  return {
    ...(payload as Omit<AuditEvent, 'timestamp'>),
    timestamp,
  };
}

export class AuditFileSystemWAL {
  private currentFile: string | null = null;
  private currentSize = 0;
  private readonly maxSize: number;
  private readonly maxRetentionMs: number;
  private readonly maxBufferSize: number;
  private writeBuffer: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInProgress = false;

  constructor(private readonly config: AuditWALConfig) {
    this.maxSize = config.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    this.maxRetentionMs =
      (config.maxRetentionHours ?? DEFAULT_MAX_RETENTION_HOURS) * 60 * 60 * 1000;
    this.maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;

    void mkdir(config.directory, { recursive: true, mode: 0o700 }).catch((err) => {
      log.error('Failed to create audit WAL directory', {
        directory: config.directory,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    this.flushTimer = setInterval(() => {
      void this.flushBuffer().catch((err) => {
        log.error('Periodic audit WAL flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);

    this.flushTimer.unref?.();
  }

  append(event: AuditEvent): void {
    this.writeBuffer.push(JSON.stringify(event) + '\n');

    if (this.writeBuffer.length >= this.maxBufferSize) {
      void this.flushBuffer().catch((err) => {
        log.error('Forced audit WAL flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    if (this.writeBuffer.length > this.maxBufferSize * 2) {
      const dropped = this.writeBuffer.length - this.maxBufferSize;
      this.writeBuffer = this.writeBuffer.slice(dropped);
      log.warn('Audit WAL buffer overflow dropped oldest entries', { dropped });
    }
  }

  appendBatch(events: AuditEvent[]): void {
    for (const event of events) {
      this.append(event);
    }
  }

  async flushBuffer(): Promise<void> {
    if (this.writeBuffer.length === 0 || this.flushInProgress) {
      return;
    }

    this.flushInProgress = true;
    try {
      const batch = this.writeBuffer;
      this.writeBuffer = [];

      if (!this.currentFile || this.currentSize >= this.maxSize) {
        await this.rotateFile();
      }

      const payload = batch.join('');
      const filePath = join(this.config.directory, this.currentFile!);

      try {
        await appendFile(filePath, payload, 'utf8');
        this.currentSize += payload.length;
      } catch (err) {
        this.writeBuffer = batch.concat(this.writeBuffer);
        throw err;
      }
    } finally {
      this.flushInProgress = false;
    }
  }

  async replay(): Promise<{ events: AuditEvent[]; files: string[] }> {
    const files = await readdir(this.config.directory);
    const walFiles = files.filter((file) => file.startsWith('wal-') && file.endsWith('.jsonl'));

    if (walFiles.length === 0) {
      return { events: [], files: [] };
    }

    const events: AuditEvent[] = [];

    for (const file of walFiles) {
      const filePath = join(this.config.directory, file);
      const content = await readFile(filePath, 'utf8');
      const lines = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      for (const line of lines) {
        try {
          events.push(parseAuditEvent(JSON.parse(line) as unknown));
        } catch (err) {
          log.warn('Skipping unparseable WAL record', {
            file,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { events, files: walFiles };
  }

  async clearProcessed(fileNames: string[]): Promise<void> {
    for (const file of fileNames) {
      await unlink(join(this.config.directory, file));
    }
  }

  async cleanup(): Promise<void> {
    const files = await readdir(this.config.directory);
    const now = Date.now();

    for (const file of files) {
      if (!file.startsWith('wal-') || !file.endsWith('.jsonl')) {
        continue;
      }

      const filePath = join(this.config.directory, file);
      const fileStats = await stat(filePath);
      if (now - fileStats.mtimeMs > this.maxRetentionMs) {
        await unlink(filePath);
      }
    }
  }

  getBufferLength(): number {
    return this.writeBuffer.length;
  }

  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    while (this.flushInProgress) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }

    await this.flushBuffer();
  }

  private async rotateFile(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.currentFile = `wal-${timestamp}-${randomUUID()}.jsonl`;
    this.currentSize = 0;
  }
}
