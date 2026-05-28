import crypto from 'crypto';

/** Generate a UUID v4 using Node.js native crypto (no npm dependency) */
export function generateId(): string {
  return crypto.randomUUID();
}

/** Generate a prefixed ID: `prefix_<uuid>` */
export function prefixedId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

// Convenience generators for common entity types
export const ids = {
  session: () => prefixedId('sess'),
  trace: () => prefixedId('tr'),
  span: () => prefixedId('sp'),
  job: () => prefixedId('job'),
  pod: () => prefixedId('pod'),
} as const;

/**
 * OpenTelemetry-compatible IDs (hex, not UUID)
 * Keep these separate — OTel has strict format requirements
 */
export function otelTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function otelSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
