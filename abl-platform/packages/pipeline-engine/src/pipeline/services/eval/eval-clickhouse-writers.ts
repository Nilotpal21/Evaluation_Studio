/**
 * Eval Buffered ClickHouse Writers
 *
 * Two writer instances for batched inserts into eval tables:
 * - conversationWriter: eval_conversations (batch: 500, flush: 2s)
 * - scoreWriter: eval_scores (batch: 2000, flush: 1s)
 *
 * Writers buffer rows in memory and flush either when the batch
 * size is reached or on a timed interval, whichever comes first.
 * Designed for high-throughput eval runs with many parallel cells.
 */

import { createLogger } from '@abl/compiler/platform';
import type { EvalConversationRow, EvalScoreRow } from './eval-types.js';
import { CH_DATABASE } from './eval-types.js';

const log = createLogger('eval-clickhouse-writers');

interface WriterConfig {
  table: string;
  batchSize: number;
  flushIntervalMs: number;
  maxBufferSize: number;
}

const CONVERSATION_WRITER_CONFIG: WriterConfig = {
  table: `${CH_DATABASE}.eval_conversations`,
  batchSize: 500,
  flushIntervalMs: 2_000,
  maxBufferSize: 5_000,
};

const SCORE_WRITER_CONFIG: WriterConfig = {
  table: `${CH_DATABASE}.eval_scores`,
  batchSize: 2_000,
  flushIntervalMs: 1_000,
  maxBufferSize: 20_000,
};

// ── Buffered Writer ─────────────────────────────────────────────────

class BufferedEvalWriter<T extends object> {
  private buffer: T[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor(
    private readonly config: WriterConfig,
    private readonly getClient: () => Promise<ClickHouseInsertClient | null>,
  ) {}

  /**
   * Add a row to the buffer. Triggers flush if batch size is reached.
   */
  insert(row: T): void {
    if (this.buffer.length >= this.config.maxBufferSize) {
      log.warn('Eval writer buffer full, dropping oldest batch', {
        table: this.config.table,
        bufferSize: this.buffer.length,
        maxBufferSize: this.config.maxBufferSize,
      });
      // Drop oldest entries to make room
      this.buffer.splice(0, this.config.batchSize);
    }

    this.buffer.push(row);
    this.ensureFlushTimer();

    if (this.buffer.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  /**
   * Flush all buffered rows to ClickHouse.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const batch = this.buffer.splice(0, this.config.batchSize);
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      if (!client) {
        log.warn('ClickHouse client not available, re-buffering rows', {
          table: this.config.table,
          rowCount: batch.length,
        });
        this.buffer.unshift(...batch);
        return;
      }

      await client.insert({
        table: this.config.table,
        values: batch,
        format: 'JSONEachRow',
      });

      log.debug('Eval writer flushed', {
        table: this.config.table,
        rowCount: batch.length,
        durationMs: Date.now() - startTime,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error('Eval writer flush failed, re-buffering', {
        table: this.config.table,
        rowCount: batch.length,
        error: msg,
      });
      // Re-add failed batch to front of buffer
      this.buffer.unshift(...batch);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Drain the entire buffer, repeating flush() until empty or maxAttempts reached.
   * Stops the interval timer during drain to prevent concurrent flush races,
   * then restarts it afterwards.
   */
  async flushAll(maxAttempts = 20): Promise<void> {
    // Stop the interval timer to prevent concurrent flushes
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushing = false;

    for (let i = 0; i < maxAttempts; i++) {
      if (this.buffer.length === 0) break;
      await this.flush();
    }
    if (this.buffer.length > 0) {
      log.warn('EvalClickHouseWriter: buffer not drained after flushAll', {
        remaining: this.buffer.length,
        table: this.config.table,
      });
    }

    // Restart the interval timer
    this.flushTimer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
  }

  /**
   * Flush remaining rows and stop the timer. Call on shutdown.
   */
  async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    // Drain remaining rows with max attempts to prevent infinite loop
    const MAX_DRAIN_ATTEMPTS = 3;
    let attempts = 0;
    while (this.buffer.length > 0 && attempts < MAX_DRAIN_ATTEMPTS) {
      const sizeBefore = this.buffer.length;
      await this.flush();
      // If buffer didn't shrink, count as a failed attempt
      if (this.buffer.length >= sizeBefore) attempts++;
      else attempts = 0;
    }
    if (this.buffer.length > 0) {
      process.stderr.write(
        `[EvalWriter] close: abandoned ${this.buffer.length} rows after ${MAX_DRAIN_ATTEMPTS} drain attempts\n`,
      );
    }
  }

  /** Current buffer size (for diagnostics). */
  get pendingRows(): number {
    return this.buffer.length;
  }

  private ensureFlushTimer(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => void this.flush(), this.config.flushIntervalMs);
    if (this.flushTimer && typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
      this.flushTimer.unref();
    }
  }
}

// ── Minimal ClickHouse Client Interface ─────────────────────────────

interface ClickHouseInsertClient {
  insert(params: { table: string; values: unknown[]; format: 'JSONEachRow' }): Promise<unknown>;
}

// ── Lazy Client Resolution ──────────────────────────────────────────

let clientPromise: Promise<ClickHouseInsertClient | null> | null = null;

async function getClient(): Promise<ClickHouseInsertClient | null> {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const mod = await import('@agent-platform/database/clickhouse');
        return mod.getClickHouseClient() as unknown as ClickHouseInsertClient;
      } catch {
        log.warn('ClickHouse client not available — eval writes will be buffered');
        return null;
      }
    })();
  }
  return clientPromise;
}

// ── Singleton Instances ─────────────────────────────────────────────

let _conversationWriter: BufferedEvalWriter<EvalConversationRow> | null = null;
let _scoreWriter: BufferedEvalWriter<EvalScoreRow> | null = null;

/**
 * Get the buffered writer for eval_conversations.
 */
export function getConversationWriter(): BufferedEvalWriter<EvalConversationRow> {
  if (!_conversationWriter) {
    _conversationWriter = new BufferedEvalWriter<EvalConversationRow>(
      CONVERSATION_WRITER_CONFIG,
      getClient,
    );
  }
  return _conversationWriter;
}

/**
 * Get the buffered writer for eval_scores.
 */
export function getScoreWriter(): BufferedEvalWriter<EvalScoreRow> {
  if (!_scoreWriter) {
    _scoreWriter = new BufferedEvalWriter<EvalScoreRow>(SCORE_WRITER_CONFIG, getClient);
  }
  return _scoreWriter;
}

/**
 * Flush and close both writers. Call on process shutdown.
 */
export async function closeEvalWriters(): Promise<void> {
  await Promise.all([_conversationWriter?.close(), _scoreWriter?.close()]);
  _conversationWriter = null;
  _scoreWriter = null;
  clientPromise = null;
}
