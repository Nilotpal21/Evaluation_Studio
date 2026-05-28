/**
 * AuditLogEmitter — buffered, non-blocking audit log writer.
 *
 * Created per-request in the Arch AI message route. Buffers events in
 * memory and flushes through an injected writer via insertMany. Write failures are
 * swallowed and logged — never propagated to the SSE stream.
 *
 * Design decision D-1: accepts a writer abstraction via constructor DI
 * for testability without vi.mock.
 */

import { createLogger } from '@abl/compiler/platform';
import type { AuditLogEntry, AuditEmitterContext } from './types.js';
import { redactAuditPayloadContent, type AuditPayloadType } from './payload-redactor.js';

const log = createLogger('arch-ai:audit');

const DEFAULT_BUFFER_THRESHOLD = 50;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFER_SIZE = 100;
const MAX_PAYLOAD_BUFFER_SIZE = 100;

export interface BufferedArchAuditLogEntry {
  tenantId: string;
  userId: string;
  sessionId: string;
  projectId?: string;
  category: AuditLogEntry['category'];
  severity: AuditLogEntry['severity'];
  summary: string;
  detail: Record<string, unknown>;
  specialist?: string;
  phase?: string;
  durationMs?: number;
  tokens?: AuditLogEntry['tokens'];
  timestamp: Date;
  turnId?: string;
  parentEventId?: string;
  phaseLabel?: string;
  retryOf?: string;
  retryIndex?: number;
  nestingDepth?: number;
  spanKind?: AuditLogEntry['spanKind'];
}

interface BufferedArchAuditPayload {
  tenantId: string;
  sessionId: string;
  eventId: string;
  payloadType: AuditPayloadType;
  content: string;
  toolName?: string;
}

export interface ArchAuditLogWriter {
  insertMany(
    entries: BufferedArchAuditLogEntry[],
    options?: { ordered?: boolean },
  ): Promise<unknown>;
  emitPayload?(payload: {
    tenantId: string;
    sessionId: string;
    eventId: string;
    payloadType: AuditPayloadType;
    content: string;
    toolName?: string;
  }): void;
}

export interface AuditLogEmitterOpts {
  bufferThreshold?: number;
  flushIntervalMs?: number;
}

export class AuditLogEmitter {
  private buffer: BufferedArchAuditLogEntry[] = [];
  private payloadBuffer: BufferedArchAuditPayload[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly threshold: number;
  private readonly flushIntervalMs: number;
  private readonly enabled: boolean;
  private flushing = false;

  constructor(
    private readonly ctx: AuditEmitterContext,
    private readonly writer: ArchAuditLogWriter,
    opts?: AuditLogEmitterOpts,
  ) {
    this.threshold = opts?.bufferThreshold ?? DEFAULT_BUFFER_THRESHOLD;
    this.flushIntervalMs = opts?.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.enabled = process.env.ARCH_AUDIT_LOG_ENABLED !== 'false';

    if (this.enabled) {
      log.debug('AuditLogEmitter created', {
        tenantId: ctx.tenantId,
        sessionId: ctx.sessionId,
      });
    }
  }

  /**
   * Buffer an audit log entry. Non-blocking — just an array push.
   * Auto-flushes when the buffer reaches the threshold.
   */
  emit(entry: AuditLogEntry): void {
    if (!this.enabled) return;

    this.buffer.push({
      tenantId: this.ctx.tenantId,
      userId: this.ctx.userId,
      sessionId: this.ctx.sessionId,
      projectId: entry.projectId ?? undefined,
      category: entry.category,
      severity: entry.severity,
      summary: entry.summary,
      detail: entry.detail,
      specialist: entry.specialist ?? undefined,
      phase: entry.phase ?? undefined,
      durationMs: entry.durationMs ?? undefined,
      tokens: entry.tokens ?? undefined,
      timestamp: new Date(),
      turnId: entry.turnId ?? undefined,
      parentEventId: entry.parentEventId ?? undefined,
      phaseLabel: entry.phaseLabel ?? undefined,
      retryOf: entry.retryOf ?? undefined,
      retryIndex: entry.retryIndex ?? undefined,
      nestingDepth: entry.nestingDepth ?? undefined,
      spanKind: entry.spanKind ?? undefined,
    });

    // Hard cap prevents memory leak if flush keeps failing
    if (this.buffer.length >= MAX_BUFFER_SIZE) {
      this.doFlush();
      return;
    }

    if (this.buffer.length >= this.threshold) {
      this.doFlush();
    } else {
      this.scheduleFlush();
    }
  }

  emitPayload(payload: {
    eventId: string;
    payloadType: AuditPayloadType;
    content: string;
    toolName?: string;
  }): void {
    if (!this.enabled) return;
    if (!this.writer.emitPayload) return;
    this.payloadBuffer.push({
      tenantId: this.ctx.tenantId,
      sessionId: this.ctx.sessionId,
      eventId: payload.eventId,
      payloadType: payload.payloadType,
      content: redactAuditPayloadContent(payload.content, {
        payloadType: payload.payloadType,
        toolName: payload.toolName,
      }),
      toolName: payload.toolName,
    });

    if (this.payloadBuffer.length >= MAX_PAYLOAD_BUFFER_SIZE) {
      this.doFlush();
      return;
    }

    this.scheduleFlush();
  }

  /**
   * Flush remaining buffered events through the configured writer.
   * Call this when the SSE stream ends (done event) to drain the buffer.
   */
  async flush(): Promise<void> {
    if (!this.enabled) return;
    this.clearTimer();
    await this.doFlush();
  }

  /**
   * Clear the flush timer. Call this when the request ends to
   * prevent the timer from firing after the response is sent.
   */
  destroy(): void {
    this.clearTimer();
  }

  /** Current buffer length (for testing/monitoring) */
  get bufferSize(): number {
    return this.buffer.length;
  }

  get payloadBufferSize(): number {
    return this.payloadBuffer.length;
  }

  // ─── Private ────────────────────────────────────────────────────────

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.doFlush();
    }, this.flushIntervalMs);
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async doFlush(): Promise<void> {
    if ((this.buffer.length === 0 && this.payloadBuffer.length === 0) || this.flushing) return;
    this.flushing = true;
    this.clearTimer();

    const batch = this.buffer.splice(0);
    const payloadBatch = this.payloadBuffer.splice(0);

    try {
      if (batch.length > 0) {
        await this.writer.insertMany(batch, { ordered: false });
      }
      for (const payload of payloadBatch) {
        this.writer.emitPayload?.(payload);
      }
      log.debug('Audit log flush', {
        count: batch.length,
        payloadCount: payloadBatch.length,
        sessionId: this.ctx.sessionId,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Audit log flush failed (non-fatal)', {
        count: batch.length,
        payloadCount: payloadBatch.length,
        sessionId: this.ctx.sessionId,
        error: message,
      });
      // Events are discarded on failure — best-effort telemetry
    } finally {
      this.flushing = false;
    }
  }
}
