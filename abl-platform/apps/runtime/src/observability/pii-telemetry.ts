/**
 * PII detection telemetry — emits trace events on the canonical
 * TraceStore channel (no Prometheus / OTel coupling at this layer; the
 * existing trace bridge handles export).
 *
 * Two event kinds:
 *   - `pii.detect.latency_ms` — per-call wall time on production entry points
 *   - `pii.detect.degraded`   — recognizer threw / async budget exceeded /
 *                              unknown pack name
 *
 * Wraps `TraceStoreInterface.addEvent` (apps/runtime/src/services/trace-store.ts:72).
 * Helpers accept the trace store via parameter so unit tests can spy via
 * constructor DI rather than module mocking (CLAUDE.md test architecture).
 */

import { randomUUID } from 'node:crypto';
import type { TraceStoreInterface } from '../services/trace-store.js';

export type PIIEntryPoint = 'nlu_guard' | 'vault_tokenize' | 'output_filter' | 'streaming_chunk';

export type PIIDegradedReason =
  | 'async_budget_exceeded'
  | 'recognizer_threw'
  | 'unknown_pack'
  | 'unsupported_tier';

export interface PIIDetectLatencyDimensions {
  entry_point: PIIEntryPoint;
  tier: string;
  pack?: string;
  recognizer?: string;
  ms: number;
}

export interface PIIDetectDegradedDimensions {
  entry_point: PIIEntryPoint;
  reason: PIIDegradedReason;
  recognizer?: string;
  pack?: string;
}

export function recordPIIDetectLatency(
  traceStore: TraceStoreInterface,
  sessionId: string,
  dims: PIIDetectLatencyDimensions,
): void {
  void traceStore.addEvent(sessionId, {
    id: randomUUID(),
    sessionId,
    type: 'pii.detect.latency_ms',
    timestamp: new Date(),
    data: { ...dims },
  });
}

export function recordPIIDetectDegraded(
  traceStore: TraceStoreInterface,
  sessionId: string,
  dims: PIIDetectDegradedDimensions,
): void {
  void traceStore.addEvent(sessionId, {
    id: randomUUID(),
    sessionId,
    type: 'pii.detect.degraded',
    timestamp: new Date(),
    data: { ...dims },
  });
}

/**
 * Helper: time a sync function and emit pii.detect.latency_ms. Returns
 * the function's return value unchanged.
 */
export function timePIIDetect<T>(
  traceStore: TraceStoreInterface | undefined,
  sessionId: string | undefined,
  dims: Omit<PIIDetectLatencyDimensions, 'ms'>,
  fn: () => T,
): T {
  if (!traceStore || !sessionId) return fn();
  const t0 = performance.now();
  try {
    return fn();
  } finally {
    const elapsed = performance.now() - t0;
    recordPIIDetectLatency(traceStore, sessionId, { ...dims, ms: elapsed });
  }
}
