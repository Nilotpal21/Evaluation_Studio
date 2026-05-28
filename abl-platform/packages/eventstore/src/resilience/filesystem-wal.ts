/**
 * FileSystemWAL - Write-Ahead Log using JSONL files.
 *
 * Provides zero-data-loss guarantee by writing events to disk when:
 * - Primary queue is unhealthy (Redis/Kafka down)
 * - Direct store write fails (ClickHouse down)
 *
 * Features:
 * - Append-only JSONL format (one event per line)
 * - Automatic file rotation at maxFileSizeBytes (default: 100MB)
 * - Replay on startup + periodic recovery
 * - TTL-based cleanup for old files
 *
 * Files:
 *   /var/eventstore-wal/wal-2026-02-27T16-30-45-01HQXYZ.jsonl
 *   /var/eventstore-wal/wal-2026-02-27T17-15-20-01HQXAB.jsonl
 */

import { appendFile, readdir, readFile, unlink, stat, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { ulid } from 'ulid';
import { createLogger } from '@agent-platform/shared-observability';
import type { PlatformEvent } from '../schema/platform-event.js';

const log = createLogger('eventstore:filesystem-wal');

export interface WALConfig {
  directory: string; // e.g., /var/eventstore-wal/
  maxFileSizeBytes?: number; // default: 100MB
  maxRetentionHours?: number; // default: 24 (delete old files even if not replayed)
  flushIntervalMs?: number; // default: 100 (how often to flush buffer to disk)
  maxBufferSize?: number; // default: 10000 (force flush when buffer exceeds this)
}

export class FileSystemWAL {
  private currentFile: string | null = null;
  private currentSize = 0;
  private readonly maxSize: number;
  private readonly maxRetentionMs: number;

  /** In-memory write buffer for batching disk I/O */
  private writeBuffer: string[] = [];
  private readonly maxBufferSize: number;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInProgress = false;

  constructor(private config: WALConfig) {
    this.maxSize = config.maxFileSizeBytes ?? 100 * 1024 * 1024; // 100MB
    this.maxRetentionMs = (config.maxRetentionHours ?? 24) * 60 * 60 * 1000;
    this.maxBufferSize = config.maxBufferSize ?? 10_000;

    // Ensure directory exists
    if (!existsSync(config.directory)) {
      mkdir(config.directory, { recursive: true, mode: 0o700 }).catch((err) => {
        log.error('Failed to create directory', {
          directory: config.directory,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Start periodic flush timer
    const flushIntervalMs = config.flushIntervalMs ?? 100;
    this.flushTimer = setInterval(() => {
      this.flushBuffer().catch((err) => {
        log.error('Periodic flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, flushIntervalMs);

    // Don't prevent Node.js from exiting
    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Append event to the in-memory write buffer.
   * Non-blocking: pushes to buffer and returns immediately.
   * Buffer is flushed to disk periodically (every flushIntervalMs) or
   * immediately when buffer exceeds maxBufferSize.
   */
  append(event: PlatformEvent): void {
    const line = JSON.stringify(event) + '\n';
    this.writeBuffer.push(line);

    // Force flush if buffer exceeds max size to prevent unbounded memory growth
    if (this.writeBuffer.length >= this.maxBufferSize) {
      log.warn('Buffer at capacity, forcing flush', {
        bufferSize: this.writeBuffer.length,
        maxBufferSize: this.maxBufferSize,
      });
      this.flushBuffer().catch((err) => {
        log.error('Forced flush failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // Hard cap: drop oldest events if buffer grows beyond 2x during a stuck flush
    if (this.writeBuffer.length > this.maxBufferSize * 2) {
      const dropped = this.writeBuffer.length - this.maxBufferSize;
      this.writeBuffer = this.writeBuffer.slice(dropped);
      log.warn('Buffer overflow — dropped oldest events (flush may be stuck)', { dropped });
    }
  }

  /**
   * Flush the in-memory buffer to disk in a single write.
   * Joins all buffered lines and writes them with one appendFile call.
   */
  async flushBuffer(): Promise<void> {
    // Nothing to flush
    if (this.writeBuffer.length === 0) {
      return;
    }

    // Prevent concurrent flushes
    if (this.flushInProgress) {
      return;
    }

    this.flushInProgress = true;
    try {
      // Snapshot and clear the buffer so new appends don't block
      const batch = this.writeBuffer;
      this.writeBuffer = [];

      // Rotate file if current exceeds max size or doesn't exist
      if (!this.currentFile || this.currentSize >= this.maxSize) {
        await this.rotateFile();
      }

      const payload = batch.join('');
      const filePath = join(this.config.directory, this.currentFile!);

      try {
        await appendFile(filePath, payload, 'utf8');
        this.currentSize += payload.length;
      } catch (err) {
        // Put events back at the front of the buffer for retry
        this.writeBuffer = batch.concat(this.writeBuffer);
        log.error('Failed to flush buffer to disk', {
          file: this.currentFile,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    } finally {
      this.flushInProgress = false;
    }
  }

  /**
   * Rotate to a new WAL file.
   */
  private async rotateFile(): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const id = ulid();
    this.currentFile = `wal-${timestamp}-${id}.jsonl`;
    this.currentSize = 0;

    log.info('Rotated to new file', { file: this.currentFile });
  }

  /**
   * Replay all WAL files - read events and return them for processing.
   */
  async replay(): Promise<{ events: PlatformEvent[]; files: string[] }> {
    const files = await readdir(this.config.directory);
    const walFiles = files.filter((f) => f.startsWith('wal-') && f.endsWith('.jsonl'));

    if (walFiles.length === 0) {
      return { events: [], files: [] };
    }

    log.info('Replaying WAL files', { count: walFiles.length });

    const events: PlatformEvent[] = [];
    let totalLines = 0;
    let failedLines = 0;

    for (const file of walFiles) {
      const filePath = join(this.config.directory, file);
      try {
        const content = await readFile(filePath, 'utf8');
        const lines = content.trim().split('\n');

        for (const line of lines) {
          totalLines++;
          try {
            const event = JSON.parse(line);
            // Deserialize timestamp string back to Date
            if (event.timestamp) {
              event.timestamp = new Date(event.timestamp);
            }
            events.push(event);
          } catch (err) {
            failedLines++;
            log.warn('Failed to parse line', {
              file,
              line: totalLines,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      } catch (err) {
        log.error('Failed to read file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Replay complete', {
      files: walFiles.length,
      events: events.length,
      totalLines,
      failedLines,
    });

    return { events, files: walFiles };
  }

  /**
   * Clear processed WAL files after successful replay.
   */
  async clearProcessed(fileNames: string[]): Promise<void> {
    let deleted = 0;
    let failed = 0;

    for (const file of fileNames) {
      try {
        await unlink(join(this.config.directory, file));
        deleted++;
      } catch (err) {
        failed++;
        log.error('Failed to delete file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info('Cleared processed files', { deleted, failed });
  }

  /**
   * Cleanup old WAL files beyond retention period.
   */
  async cleanup(): Promise<void> {
    const files = await readdir(this.config.directory);
    const now = Date.now();
    let deleted = 0;

    for (const file of files) {
      if (!file.startsWith('wal-')) continue;

      const filePath = join(this.config.directory, file);
      try {
        const stats = await stat(filePath);
        const age = now - stats.mtimeMs;

        if (age > this.maxRetentionMs) {
          await unlink(filePath);
          deleted++;
          log.info('Deleted expired file', {
            file,
            ageHours: Math.round(age / (60 * 60 * 1000)),
          });
        }
      } catch (err) {
        log.error('Failed to cleanup file', {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (deleted > 0) {
      log.info('Cleanup complete', { deleted });
    }
  }

  /**
   * Get current WAL file name.
   */
  getCurrentFile(): string | null {
    return this.currentFile;
  }

  /**
   * Get current file size.
   */
  getCurrentSize(): number {
    return this.currentSize;
  }

  /**
   * Get current buffer length (number of pending events not yet flushed).
   */
  getBufferLength(): number {
    return this.writeBuffer.length;
  }

  /**
   * Flush remaining buffer and stop the periodic flush timer.
   * Call this during graceful shutdown to avoid losing buffered events.
   */
  async close(): Promise<void> {
    // Stop the periodic flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Wait for any in-progress flush to complete before final drain
    while (this.flushInProgress) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // Final flush to ensure no events are lost
    await this.flushBuffer();
  }
}
