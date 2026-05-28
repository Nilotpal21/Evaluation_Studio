/**
 * EventRecoveryService - replays WAL files to recover from failures.
 *
 * Two recovery modes:
 * 1. Startup recovery: replay WAL files on pod startup
 * 2. Periodic recovery: check for new WAL files every 5 minutes
 *
 * Flow:
 *   WAL files → replay() → writeBatch() to IEventStore → delete WAL files
 *
 * Use cases:
 * - Pod crashed while queue was down → startup recovery replays WAL
 * - Queue was down for hours → periodic recovery catches up
 * - ClickHouse was down → WAL accumulated → recovery replays when CH returns
 */

import { createLogger } from '@agent-platform/shared-observability';
import type { IEventStore } from '../interfaces/event-store.js';
import { FileSystemWAL } from './filesystem-wal.js';

const log = createLogger('eventstore:recovery-service');

export interface RecoveryResult {
  recovered: number;
  failed: number;
  filesProcessed: number;
}

export class EventRecoveryService {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private wal: FileSystemWAL,
    private store: IEventStore,
  ) {}

  /**
   * Recover from WAL - replay all events to store.
   */
  async recoverFromWAL(): Promise<RecoveryResult> {
    const { events, files } = await this.wal.replay();

    if (events.length === 0) {
      log.info('No WAL events to recover');
      return { recovered: 0, failed: 0, filesProcessed: 0 };
    }

    log.info('Starting recovery', {
      events: events.length,
      files: files.length,
    });

    let recovered = 0;
    let failed = 0;

    // Write events in batches (10K per batch)
    const batchSize = 10_000;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);

      try {
        this.store.writeBatch(batch);
        recovered += batch.length;

        log.info('Batch written', {
          batchStart: i,
          batchSize: batch.length,
          total: events.length,
        });
      } catch (err) {
        failed += batch.length;
        log.error('Batch write failed', {
          batchStart: i,
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Flush to ensure all batches are persisted
    await this.store.flush();

    // If all events recovered successfully, delete WAL files
    if (failed === 0) {
      await this.wal.clearProcessed(files);
      log.info('Recovery complete, WAL files deleted', {
        recovered,
        files: files.length,
      });
    } else {
      log.warn('Partial recovery, WAL files retained', {
        recovered,
        failed,
        files: files.length,
      });
    }

    return { recovered, failed, filesProcessed: files.length };
  }

  /**
   * Start periodic recovery - check for new WAL files every intervalMs.
   */
  startPeriodicRecovery(intervalMs: number = 5 * 60 * 1000): void {
    if (this.intervalHandle) {
      log.warn('Periodic recovery already running');
      return;
    }

    log.info('Starting periodic recovery', {
      intervalMs,
      intervalMinutes: Math.round(intervalMs / 60_000),
    });

    this.intervalHandle = setInterval(() => {
      this.recoverFromWAL().catch((err) => {
        log.error('Periodic recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    // Don't prevent Node.js from exiting
    if (this.intervalHandle.unref) {
      this.intervalHandle.unref();
    }
  }

  /**
   * Stop periodic recovery.
   */
  stopPeriodicRecovery(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('Stopped periodic recovery');
    }
  }

  /**
   * Cleanup old WAL files (beyond retention period).
   */
  async cleanup(): Promise<void> {
    await this.wal.cleanup();
  }
}
