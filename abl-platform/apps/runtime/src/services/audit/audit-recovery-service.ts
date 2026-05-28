import { createLogger } from '@abl/compiler/platform';
import type {
  AuditEvent,
  AuditMaterializer,
} from '@abl/compiler/platform/stores/audit-pipeline.js';
import { AuditFileSystemWAL } from './audit-filesystem-wal.js';

const log = createLogger('audit-recovery-service');
const DEFAULT_RECOVERY_BATCH_SIZE = 1_000;
const DEFAULT_RECOVERY_INTERVAL_MS = 5 * 60 * 1_000;

export interface AuditRecoveryResult {
  recovered: number;
  failed: number;
  filesProcessed: number;
}

export interface AuditRecoveryHooks {
  onResult?: (result: AuditRecoveryResult) => void;
  onError?: (error: unknown) => void;
}

export class AuditRecoveryService {
  private intervalHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly wal: AuditFileSystemWAL,
    private readonly materializer: AuditMaterializer,
    private readonly hooks: AuditRecoveryHooks = {},
  ) {}

  async recoverFromWAL(): Promise<AuditRecoveryResult> {
    try {
      const { events, files } = await this.wal.replay();
      if (events.length === 0) {
        const result = { recovered: 0, failed: 0, filesProcessed: 0 };
        this.hooks.onResult?.(result);
        return result;
      }

      let recovered = 0;
      let failed = 0;

      for (let index = 0; index < events.length; index += DEFAULT_RECOVERY_BATCH_SIZE) {
        const batch = events.slice(index, index + DEFAULT_RECOVERY_BATCH_SIZE);

        try {
          await this.materializer.handleBatch(batch);
          recovered += batch.length;
        } catch (err) {
          failed += batch.length;
          log.error('Audit WAL recovery batch failed', {
            batchStart: index,
            batchSize: batch.length,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await this.materializer.flush();

      if (failed === 0) {
        await this.wal.clearProcessed(files);
      }

      const result = { recovered, failed, filesProcessed: files.length };
      this.hooks.onResult?.(result);
      return result;
    } catch (error) {
      this.hooks.onError?.(error);
      throw error;
    }
  }

  startPeriodicRecovery(intervalMs: number = DEFAULT_RECOVERY_INTERVAL_MS): void {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = setInterval(() => {
      void this.recoverFromWAL().catch((err) => {
        this.hooks.onError?.(err);
        log.error('Periodic audit WAL recovery failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, intervalMs);

    this.intervalHandle.unref?.();
  }

  stopPeriodicRecovery(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  async cleanup(): Promise<void> {
    await this.wal.cleanup();
  }

  async close(): Promise<void> {
    this.stopPeriodicRecovery();
    await this.wal.close();
  }
}
