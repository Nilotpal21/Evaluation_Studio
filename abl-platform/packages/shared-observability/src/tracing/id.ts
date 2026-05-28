/**
 * Trace/Span ID generation using cryptographically random hex strings.
 */
import { randomBytes } from 'crypto';

/** Generate a 128-bit (32 hex char) trace ID. */
export function generateTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** Generate a 64-bit (16 hex char) span ID. */
export function generateSpanId(): string {
  return randomBytes(8).toString('hex');
}
