/**
 * Shared EventStore emit logic — used by both trace-emitter and write-pipeline
 * to construct and emit PlatformEvent payloads to ClickHouse via EventStore.
 *
 * Eliminates code duplication where both paths independently constructed
 * EventStore payloads with divergent logic (e.g. write-pipeline lacked
 * TRACE_TO_PLATFORM_TYPE mapping and PII scrubbing).
 */

import type { EventStoreServices } from '@abl/eventstore';
import { scrubSecrets } from '@abl/compiler';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
  RUNTIME_TRACE_UNMAPPED_DATA_KEY,
  TRACE_TO_PLATFORM_TYPE,
  inferCategory,
} from '../trace-event-types.js';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('emit-to-eventstore');

export interface EventStoreEmitOptions {
  eventStore: EventStoreServices;
  event: {
    id: string;
    type: string;
    sessionId?: string;
    traceId?: string;
    tenantId: string;
    projectId?: string;
    deploymentId?: string;
    agentName?: string;
    environment?: string;
    timestamp: Date;
    durationMs?: number;
    spanId?: string;
    parentSpanId?: string;
    turnId?: string;
    executionId?: string;
    parentExecutionId?: string;
    agentRunId?: string;
    decisionId?: string;
    parentDecisionId?: string;
    causeEventId?: string;
    phase?: string;
    reasonCode?: string;
    data: Record<string, unknown>;
  };
  /** Session purpose/source tag for analytics filtering. Defaults to production in ClickHouse. */
  knownSource?: 'production' | 'eval' | 'synthetic';
  /** When true, scrub PII from data before emitting */
  scrubPII?: boolean;
  /** Redact PII function (from trace-emitter closure) */
  redactPIIFn?: (s: string) => string;
  /** Custom dimensions record */
  dimensionRecord?: Record<string, string>;
}

export function resolvePlatformEventType(traceType: string): {
  platformType: string;
  isGenericRuntimeTrace: boolean;
} {
  const mappedType = TRACE_TO_PLATFORM_TYPE[traceType];
  if (mappedType) {
    return { platformType: mappedType, isGenericRuntimeTrace: false };
  }

  return {
    platformType: RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
    isGenericRuntimeTrace: true,
  };
}

/**
 * Emit a trace event to EventStore (fire-and-forget, non-fatal).
 *
 * Handles:
 * - Secret scrubbing (always)
 * - PII redaction (when scrubPII + redactPIIFn provided)
 * - Trace type → platform type mapping (TRACE_TO_PLATFORM_TYPE)
 * - Error detection and error field population
 * - Custom dimension attachment
 */
export function emitToEventStore(options: EventStoreEmitOptions): void {
  const { eventStore, event, knownSource, scrubPII, redactPIIFn, dimensionRecord } = options;

  try {
    const rawData = event.data || {};
    const scrubbedData = scrubSecrets(rawData);
    const analyticsData = (
      scrubPII && redactPIIFn ? JSON.parse(redactPIIFn(JSON.stringify(scrubbedData))) : scrubbedData
    ) as Record<string, unknown>;

    const hasError = Boolean(
      rawData.error ||
      rawData.errorType ||
      rawData.errorMessage ||
      rawData.error_message ||
      rawData.errorCode ||
      rawData.error_code,
    );
    const resolvedType = resolvePlatformEventType(event.type);
    let platformType = resolvedType.platformType;
    if (event.type === 'llm_call' && hasError) platformType = 'llm.call.failed';
    if (event.type === 'tool_call' && hasError) platformType = 'tool.call.failed';
    const causalMetadata = buildCausalMetadata(event);
    const analyticsDataWithCausality = causalMetadata
      ? attachCausalMetadataToData(analyticsData, causalMetadata)
      : analyticsData;
    const eventData = resolvedType.isGenericRuntimeTrace
      ? {
          ...analyticsDataWithCausality,
          [RUNTIME_TRACE_TYPE_DATA_KEY]: event.type,
          [RUNTIME_TRACE_UNMAPPED_DATA_KEY]: true,
        }
      : analyticsDataWithCausality;

    eventStore.emitter.emit({
      event_id: event.id || '',
      event_type: platformType,
      category: inferCategory(platformType),
      tenant_id: event.tenantId,
      project_id: event.projectId ?? '',
      session_id: event.sessionId ?? '',
      trace_id: event.traceId || event.sessionId || '',
      deployment_id: event.deploymentId || '',
      known_source: knownSource ?? 'production',
      environment:
        event.environment || (typeof rawData.environment === 'string' ? rawData.environment : ''),
      agent_name: event.agentName,
      timestamp: event.timestamp ?? new Date(),
      duration_ms: event.durationMs,
      has_error: hasError,
      ...(hasError && {
        error_message: rawData.error
          ? String(rawData.error)
          : rawData.message
            ? String(rawData.message)
            : rawData.errorMessage
              ? String(rawData.errorMessage)
              : rawData.error_message
                ? String(rawData.error_message)
                : undefined,
        error_type:
          (rawData.errorType as string) ||
          (rawData.errorCode as string) ||
          (rawData.error_code as string) ||
          undefined,
      }),
      channel: (rawData.channel as string) || undefined,
      actor_id: (rawData.actorId as string) || undefined,
      actor_type: (rawData.actorType as 'user' | 'contact' | 'system' | 'agent') || undefined,
      data: eventData,
      span_id: event.spanId,
      parent_span_id: event.parentSpanId,
      turn_id: event.turnId,
      execution_id: event.executionId,
      parent_execution_id: event.parentExecutionId,
      agent_run_id: event.agentRunId,
      decision_id: event.decisionId,
      parent_decision_id: event.parentDecisionId,
      cause_event_id: event.causeEventId,
      phase: event.phase,
      reason_code: event.reasonCode,
      metadata: {
        ...(dimensionRecord ? { custom_dimensions: dimensionRecord } : {}),
        ...(causalMetadata ? { causal: causalMetadata } : {}),
        ...(resolvedType.isGenericRuntimeTrace
          ? {
              runtime_trace_type: event.type,
              runtime_trace_unmapped: true,
            }
          : {}),
      },
    });
  } catch (err) {
    log.warn('EventStore write failed', {
      sessionId: event.sessionId,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function buildCausalMetadata(
  event: EventStoreEmitOptions['event'],
): Record<string, string> | undefined {
  const causalFields = {
    turnId: event.turnId,
    executionId: event.executionId,
    parentExecutionId: event.parentExecutionId,
    agentRunId: event.agentRunId,
    decisionId: event.decisionId,
    parentDecisionId: event.parentDecisionId,
    causeEventId: event.causeEventId,
    phase: event.phase,
    reasonCode: event.reasonCode,
  };
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(causalFields)) {
    if (typeof value === 'string' && value.length > 0) {
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function attachCausalMetadataToData(
  data: Record<string, unknown>,
  causalMetadata: Record<string, string>,
): Record<string, unknown> {
  const existingCausal =
    data.causal && typeof data.causal === 'object' && !Array.isArray(data.causal)
      ? (data.causal as Record<string, unknown>)
      : {};
  const nextData: Record<string, unknown> = {
    ...data,
    causal: {
      ...existingCausal,
      ...causalMetadata,
    },
  };

  for (const [key, value] of Object.entries(causalMetadata)) {
    if (nextData[key] === undefined) {
      nextData[key] = value;
    }
  }

  return nextData;
}
