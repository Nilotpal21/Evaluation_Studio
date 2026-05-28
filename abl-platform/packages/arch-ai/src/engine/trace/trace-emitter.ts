/**
 * TraceEmitter — engine-side port for emitting trace log records.
 *
 * Inlined from arch-observability-contracts. The engine holds one TraceEmitter
 * reference; if undefined, trace emission is a no-op.
 *
 * Contract: emit() is fire-and-forget; it NEVER throws to the caller.
 * flush() is awaitable for graceful shutdown.
 */

import type { TraceLogRecord } from './trace-log-record.js';

export interface TraceEmitter {
  emit(record: TraceLogRecord): void;
  flush(deadlineMs?: number): Promise<void>;
}
