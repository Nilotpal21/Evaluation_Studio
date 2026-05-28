/**
 * Tracing primitives barrel export.
 */

// Interfaces
export type { SpanContext } from './span-context.js';
export type { Span } from './span.js';
export type { Tracer } from './tracer.js';
export type { WritePipeline } from './write-pipeline.js';

// ID generation
export { generateTraceId, generateSpanId } from './id.js';

// W3C traceparent
export { parseTraceparent, formatTraceparent, type TraceparentFields } from './traceparent.js';

// Propagation
export { injectTrace, extractTrace } from './propagation.js';
