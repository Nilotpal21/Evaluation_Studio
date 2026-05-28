/**
 * SpanContext — Immutable identity of a span within a trace.
 */
export interface SpanContext {
  /** 128-bit hex trace identifier (32 chars) */
  traceId: string;
  /** 64-bit hex span identifier (16 chars) */
  spanId: string;
  /** Parent span identifier (if this span has a parent) */
  parentSpanId?: string;
}
