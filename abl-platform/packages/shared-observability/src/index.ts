/**
 * @agent-platform/shared-observability
 *
 * Observability primitives for Agent Platform:
 * - Distributed locks (Redis-based coordination across pods)
 * - Request ID middleware (AsyncLocalStorage propagation)
 * - Observability middleware (tracing context per HTTP request)
 * - Future home for shared tracing, metrics, and logging utilities
 */

// Middleware
export {
  requestIdMiddleware,
  getCurrentRequestId,
  createObservabilityMiddleware,
  type ObservabilityContext,
  type ObservabilityMiddlewareConfig,
  type RequestIdMiddlewareOptions,
} from './middleware/index.js';

// Distributed Lock
export { DistributedLockManager, type Lock, type LockOptions } from './distributed-lock.js';

// Logger
export {
  createLogger,
  setLogLevel,
  setLogHandler,
  redactSensitive,
  redactString,
  type Logger,
  type LogLevel,
  type LogEntry,
} from './logger.js';

// Observability Context (AsyncLocalStorage)
export {
  type ObservabilityContext as ObsContext,
  runWithObservabilityContext,
  getObservabilityContext,
  getCurrentTraceId,
  getCurrentSpanId,
} from './context.js';
