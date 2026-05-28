/**
 * Span and trace status types + error shape for Arch AI.
 *
 * Inlined from arch-observability-contracts so the engine has no observability
 * dependency. An external observability provider may consume these types
 * via re-export.
 */

export type SpanStatus = 'ok' | 'error' | 'canceled' | 'timeout';

export type TraceStatus = 'ok' | 'error' | 'canceled' | 'paused';

export interface SpanError {
  code: string;
  message: string;
  retryable?: boolean;
  cause?: string;
}
