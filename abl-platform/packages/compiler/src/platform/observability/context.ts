/**
 * Observability Context — Re-export from @agent-platform/shared-observability
 *
 * The canonical implementation lives in shared-observability.
 * This re-export maintains the compiler barrel for backward compatibility.
 */

export {
  type ObservabilityContext,
  runWithObservabilityContext,
  getObservabilityContext,
  getCurrentTraceId,
  getCurrentSpanId,
} from '@agent-platform/shared-observability/context';
