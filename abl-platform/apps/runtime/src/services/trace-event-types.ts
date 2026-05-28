/**
 * Canonical event type mapping — trace types to platform event types.
 * Used by trace-emitter to emit platform events directly (no bridge).
 */
export {
  PLATFORM_TO_TRACE_ALIASES,
  PLATFORM_TO_TRACE_TYPE,
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
  RUNTIME_TRACE_UNMAPPED_DATA_KEY,
  TRACE_TO_PLATFORM_TYPE,
} from '@agent-platform/observatory';

/** Infer category from dotted event type (first segment) */
export function inferCategory(eventType: string): string {
  return eventType.split('.')[0];
}
