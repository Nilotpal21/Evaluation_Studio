/**
 * Trace context propagation for cross-boundary communication.
 * Serializes/deserializes SpanContext into carrier objects (BullMQ jobs, HTTP headers, etc.).
 */
import type { SpanContext } from './span-context.js';

const TRACE_ID_KEY = '__traceId';
const SPAN_ID_KEY = '__spanId';
const PARENT_SPAN_ID_KEY = '__parentSpanId';

/**
 * Inject span context into a carrier object (e.g., BullMQ job payload).
 */
export function injectTrace(carrier: Record<string, unknown>, context: SpanContext): void {
  carrier[TRACE_ID_KEY] = context.traceId;
  carrier[SPAN_ID_KEY] = context.spanId;
  if (context.parentSpanId) {
    carrier[PARENT_SPAN_ID_KEY] = context.parentSpanId;
  }
}

/**
 * Extract span context from a carrier object.
 * Returns null if the carrier does not contain valid trace context.
 */
export function extractTrace(carrier: Record<string, unknown>): SpanContext | null {
  const traceId = carrier[TRACE_ID_KEY];
  const spanId = carrier[SPAN_ID_KEY];

  if (typeof traceId !== 'string' || typeof spanId !== 'string') {
    return null;
  }

  const parentSpanId = carrier[PARENT_SPAN_ID_KEY];
  return {
    traceId,
    spanId,
    ...(typeof parentSpanId === 'string' ? { parentSpanId } : {}),
  };
}
