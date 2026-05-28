/**
 * Trace Event Adapter
 *
 * Converts runtime/session TraceEvent records into Observatory
 * ExtendedTraceEvent records. Prefer canonical top-level fields first,
 * then fall back to mirrored payload fields for backward compatibility.
 */

import type { ExtendedTraceEvent, TraceEvent } from '../types';
import { attachTraceCausalFieldsToData, getTraceCausalFields } from './trace-causality';

export interface ToExtendedTraceEventOptions {
  fallbackSessionId?: string;
  fallbackTraceId?: string;
}

export function normalizeTraceEventRecord(
  event: Record<string, unknown>,
  options: ToExtendedTraceEventOptions = {},
): TraceEvent {
  const data = asRecord(event.data);
  const sessionId =
    pickString(
      event.sessionId,
      event.session_id,
      data.sessionId,
      data.session_id,
      options.fallbackSessionId,
    ) ?? '';
  const traceId = pickString(
    event.traceId,
    event.trace_id,
    data.traceId,
    data.trace_id,
    options.fallbackTraceId,
    sessionId,
  );
  const type =
    pickString(event.type, event.event_type, data.type, data.eventType, data._runtime_trace_type) ??
    'unknown';
  const timestampValue = event.timestamp ?? data.timestamp;
  const timestamp =
    timestampValue instanceof Date
      ? timestampValue
      : timestampValue
        ? new Date(String(timestampValue))
        : new Date();
  const id = pickString(event.id, data.id) ?? `trace-${type}-${timestamp.getTime()}`;

  const normalized = {
    ...event,
    id,
    type: type as TraceEvent['type'],
    timestamp,
    sessionId,
    traceId,
    spanId: pickString(event.spanId, event.span_id, data.spanId, data.span_id),
    parentSpanId: pickString(
      event.parentSpanId,
      event.parent_span_id,
      data.parentSpanId,
      data.parent_span_id,
    ),
    agentName: pickString(
      event.agentName,
      event.agent_name,
      data.agentName,
      data.agent_name,
      data.agent,
      data.sourceAgent,
      data.fromAgent,
      data.from,
    ),
    durationMs: pickNumber(event.durationMs, event.duration_ms, data.durationMs, data.duration_ms),
    data,
  } as TraceEvent;

  const causalFields = getTraceCausalFields(normalized);

  return {
    ...normalized,
    ...causalFields,
    data: attachTraceCausalFieldsToData(data, causalFields),
  };
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type TraceEventLike = Pick<TraceEvent, 'id' | 'type' | 'sessionId'> & {
  spanId?: string;
  parentSpanId?: string;
  data?: Record<string, unknown>;
};

function resolveVoiceTurnKey(data: Record<string, unknown>): string | undefined {
  const turnId = pickString(data.turnId, data.turn_id);
  if (turnId) {
    return turnId;
  }

  const turnNumber = pickNumber(data.turn, data.turnNumber, data.turn_number);
  if (turnNumber !== undefined) {
    return String(turnNumber);
  }

  return undefined;
}

export function deriveSyntheticSpanFields(
  event: TraceEventLike,
  options: ToExtendedTraceEventOptions = {},
): { spanId?: string; parentSpanId?: string } {
  const data = event.data ?? {};
  const sessionId =
    pickString(event.sessionId, data.sessionId, data.session_id, options.fallbackSessionId) ??
    'session-unknown';
  const voiceTurnKey = resolveVoiceTurnKey(data);

  switch (event.type) {
    case 'session_created':
    case 'session_start':
    case 'session_updated':
    case 'session_end':
    case 'session_ended':
      return {
        spanId: `session:${sessionId}`,
      };

    case 'voice_session_start':
    case 'voice_session_end':
      return {
        spanId: `voice-session:${sessionId}`,
        parentSpanId: `session:${sessionId}`,
      };

    case 'voice_turn':
    case 'voice_turn_start':
    case 'voice_turn_end': {
      const turnKey = voiceTurnKey ?? event.id;
      return {
        spanId: `voice-turn:${sessionId}:${turnKey}`,
        parentSpanId: `voice-session:${sessionId}`,
      };
    }

    case 'voice_stt':
    case 'voice_tts':
    case 'voice_llm':
    case 'voice_realtime_tool_call':
    case 'voice_barge_in':
    case 'voice_tts_quality':
    case 'voice_asr_quality':
    case 'voice_asr_cascade': {
      const turnKey = voiceTurnKey ?? event.id;
      return {
        spanId: `${event.type}:${sessionId}:${turnKey}`,
        parentSpanId: voiceTurnKey
          ? `voice-turn:${sessionId}:${voiceTurnKey}`
          : `voice-session:${sessionId}`,
      };
    }

    default:
      return {};
  }
}

export function toExtendedTraceEvent(
  event: TraceEvent,
  options: ToExtendedTraceEventOptions = {},
): ExtendedTraceEvent {
  const rawEvent = event as unknown as Record<string, unknown>;
  const baseData = { ...(event.data ?? {}) };

  const sessionId =
    pickString(
      event.sessionId,
      rawEvent.session_id,
      baseData.sessionId,
      baseData.session_id,
      options.fallbackSessionId,
    ) ?? 'session-unknown';

  const traceId =
    pickString(
      event.traceId,
      rawEvent.trace_id,
      baseData.traceId,
      baseData.trace_id,
      options.fallbackTraceId,
      sessionId,
    ) ?? `trace-${event.id}`;

  const agentName =
    pickString(
      event.agentName,
      rawEvent.agent_name,
      baseData.agentName,
      baseData.agent_name,
      baseData.agent,
      baseData.sourceAgent,
      baseData.fromAgent,
      baseData.from,
    ) ?? 'unknown';

  const syntheticSpan = deriveSyntheticSpanFields(event, { fallbackSessionId: sessionId });
  const spanId = pickString(
    event.spanId,
    rawEvent.span_id,
    baseData.spanId,
    baseData.span_id,
    syntheticSpan.spanId,
  );
  const parentSpanId = pickString(
    event.parentSpanId,
    rawEvent.parent_span_id,
    baseData.parentSpanId,
    baseData.parent_span_id,
    syntheticSpan.parentSpanId,
  );
  const stepName = pickString(
    rawEvent.stepName,
    rawEvent.step_name,
    baseData.stepName,
    baseData.step_name,
  );
  const durationMs = pickNumber(
    event.durationMs,
    rawEvent.duration_ms,
    baseData.durationMs,
    baseData.duration_ms,
    baseData.latencyMs,
    baseData.latency_ms,
  );
  const causalFields = getTraceCausalFields(event);
  const data = attachTraceCausalFieldsToData(baseData, causalFields);

  return {
    id: event.id,
    type: event.type,
    timestamp: new Date(event.timestamp),
    traceId,
    spanId: spanId ?? `span-${event.id}`,
    parentSpanId,
    sessionId,
    agentName,
    stepName,
    durationMs,
    ...causalFields,
    data,
  };
}
