/**
 * Observability Context (AsyncLocalStorage)
 *
 * Propagates trace/tenant/session context through the entire async call chain
 * without parameter drilling. Used by:
 * - Pino mixin (auto-inject traceId, spanId, tenantId into every log line)
 * - OTEL bridge (correlate spans with application traces)
 * - Middleware (set context per HTTP request / WS message)
 * - STI tracePath HOF (read current traceId for execution recording)
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservabilityContext {
  traceId: string;
  spanId: string;
  tenantId?: string;
  sessionId?: string;
  userId?: string;
  correlationId?: string;
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage instance
// ---------------------------------------------------------------------------

const observabilityStorage = new AsyncLocalStorage<ObservabilityContext>();

/**
 * Run a function within an observability context.
 * All async operations within the callback will have access to the context.
 * Pino's mixin reads from this automatically on every log call.
 */
export function runWithObservabilityContext<T>(context: ObservabilityContext, fn: () => T): T {
  return observabilityStorage.run(context, fn);
}

/**
 * Get the current observability context from AsyncLocalStorage.
 * Returns undefined if not within an observability context.
 */
export function getObservabilityContext(): ObservabilityContext | undefined {
  return observabilityStorage.getStore();
}

/**
 * Get the current trace ID, or undefined if outside a traced context.
 */
export function getCurrentTraceId(): string | undefined {
  return observabilityStorage.getStore()?.traceId;
}

/**
 * Get the current span ID, or undefined if outside a traced context.
 */
export function getCurrentSpanId(): string | undefined {
  return observabilityStorage.getStore()?.spanId;
}
