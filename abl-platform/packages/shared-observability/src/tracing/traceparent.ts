/**
 * W3C Trace Context traceparent header utilities.
 * Format: {version}-{traceId}-{parentId}-{traceFlags}
 *
 * Stricter than the private function in observability middleware:
 * - Validates version is "00"
 * - Validates hex characters
 * - Rejects all-zero traceId/spanId
 */

const TRACEPARENT_RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);

export interface TraceparentFields {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

/**
 * Parse a W3C traceparent header string.
 * Returns null if the header is missing or malformed.
 */
export function parseTraceparent(header: string | undefined): TraceparentFields | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header);
  if (!match) return null;

  const [, traceId, spanId, traceFlags] = match;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;

  return { traceId: traceId!, spanId: spanId!, traceFlags: traceFlags! };
}

/**
 * Format a traceparent header from trace/span IDs.
 * Uses version "00" and trace-flags "01" (sampled) by default.
 */
export function formatTraceparent(
  traceId: string,
  spanId: string,
  traceFlags: string = '01',
): string {
  return `00-${traceId}-${spanId}-${traceFlags}`;
}
