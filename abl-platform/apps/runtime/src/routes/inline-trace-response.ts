import type { TraceEventWithId } from '../types/index.js';

export type InlineTraceEvent = TraceEventWithId | { type: string; data: Record<string, unknown> };
export type PublicInlineTraceEvent = { type: string; data: Record<string, unknown> };

const INTERNAL_INLINE_TRACE_KEYS = new Set(['tenantId', 'tenant_id', 'projectId', 'project_id']);

export function stripInternalInlineTraceFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripInternalInlineTraceFields(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !INTERNAL_INLINE_TRACE_KEYS.has(key))
      .map(([key, nestedValue]) => [key, stripInternalInlineTraceFields(nestedValue)]),
  );
}

export function toPublicInlineTraceEvent(event: InlineTraceEvent): PublicInlineTraceEvent {
  return {
    type: event.type,
    data: stripInternalInlineTraceFields(event.data ?? {}) as Record<string, unknown>,
  };
}
