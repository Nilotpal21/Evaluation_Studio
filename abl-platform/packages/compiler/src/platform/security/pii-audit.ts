/**
 * PII Audit Logger
 *
 * Async, fire-and-forget audit logging for PII access events.
 * Failures are logged but never block the request path.
 */

import { createLogger } from '../logger.js';

const log = createLogger('pii-audit');

export interface PIIAuditEntry {
  tenantId: string;
  projectId: string;
  sessionId: string;
  tokenId: string;
  piiType: string;
  consumer: string;
  action: string;
  /** Detection confidence carried over from the source PIIDetection (0..1). */
  confidence?: number;
  /** Originating recognizer name (e.g. 'core-email', 'eu-iban'). */
  recognizer?: string;
  metadata?: Record<string, unknown>;
  retentionDays?: number;
}

export interface PIIAuditStore {
  insert(entry: PIIAuditEntry & { expireAt: Date }): Promise<void>;
}

const DEFAULT_RETENTION_DAYS = 90;

/** In-memory buffer for batching audit writes */
const MAX_BUFFER_SIZE = 100;
const FLUSH_INTERVAL_MS = 5_000;

export class PIIAuditLogger {
  private buffer: Array<PIIAuditEntry & { expireAt: Date }> = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushPromise: Promise<void> | null = null;
  private readonly store: PIIAuditStore;

  constructor(store: PIIAuditStore) {
    this.store = store;
  }

  log(entry: PIIAuditEntry): void {
    const retentionDays = entry.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const expireAt = new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000);
    this.buffer.push({ ...entry, expireAt });

    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  async flush(): Promise<void> {
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    this.flushPromise = (async () => {
      try {
        await Promise.all(batch.map((entry) => this.store.insert(entry)));
      } catch (err) {
        log.warn('pii-audit-flush-failed', {
          count: batch.length,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        this.flushPromise = null;
      }
    })();

    await this.flushPromise;
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}
