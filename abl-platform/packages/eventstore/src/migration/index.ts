/**
 * Migration bridges - dual-write existing data to eventstore.
 *
 * Enable via config flag, validate correctness, migrate dashboards, then optionally
 * stop legacy writes.
 */

export {
  mapLLMMetricsToPlatformEvent,
  emitLLMMetricsAsAnalytics,
  type LLMMetricsRow,
} from './llm-metrics-bridge.js';

export {
  emitTraceEventAsAnalytics,
  type TraceEventInput,
  type TraceTypeMappingOptions,
} from './trace-bridge.js';
