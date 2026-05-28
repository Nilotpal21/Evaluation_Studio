import { scrubTraceEvent } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import { getTraceStore, type TraceEvent } from '../../trace-store.js';
import type { RuntimeSession } from '../../execution/types.js';
import { getEventStore } from '../../eventstore-singleton.js';
import { emitToEventStore } from '../../trace/emit-to-eventstore.js';
import { deriveRuntimeTracePhase } from '../../trace/causal-envelope.js';

const log = createLogger('voice-trace-scrubbing');
type MessagePersistenceQueueModule = typeof import('../../message-persistence-queue.js');
let messagePersistenceQueuePromise: Promise<MessagePersistenceQueueModule> | undefined;

function loadMessagePersistenceQueue(): Promise<MessagePersistenceQueueModule> {
  messagePersistenceQueuePromise ??= import('../../message-persistence-queue.js').catch((error) => {
    messagePersistenceQueuePromise = undefined;
    throw error;
  });
  return messagePersistenceQueuePromise;
}

type VoicePIIRecognizerRegistry = NonNullable<RuntimeSession['piiRecognizerRegistry']>;

export interface AddScrubbedVoiceTraceEventOptions {
  persistToEventStore?: boolean;
  incrementTraceEventCount?: boolean;
  dbSessionId?: string;
  tenantId?: string;
  projectId?: string;
  deploymentId?: string;
  knownSource?: 'production' | 'eval' | 'synthetic';
}

function applyProjectPIIRedaction(value: unknown, registry: VoicePIIRecognizerRegistry): unknown {
  if (typeof value === 'string') {
    const detections = registry
      .detectAll(value)
      .sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
    const filteredDetections: typeof detections = [];
    let lastEnd = -1;
    for (const detection of detections) {
      if (detection.start >= lastEnd) {
        filteredDetections.push(detection);
        lastEnd = detection.end;
      }
    }

    let redacted = value;
    for (const detection of filteredDetections.reverse()) {
      redacted =
        redacted.slice(0, detection.start) + detection.value + redacted.slice(detection.end);
    }
    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyProjectPIIRedaction(item, registry));
  }

  if (value && typeof value === 'object') {
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      redacted[key] = applyProjectPIIRedaction(item, registry);
    }
    return redacted;
  }

  return value;
}

function scrubVoiceTraceData(
  data: Record<string, unknown>,
  session: Pick<RuntimeSession, 'id' | 'piiRecognizerRegistry'> | undefined,
  eventType: string,
): Record<string, unknown> {
  let builtInScrubbed: Record<string, unknown>;

  try {
    builtInScrubbed = scrubTraceEvent(data);
  } catch (err) {
    log.error('Voice trace built-in scrubbing failed; dropping trace data payload', {
      sessionId: session?.id,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    return { scrubbed: true, scrubError: 'voice_trace_scrub_failed' };
  }

  if (!session?.piiRecognizerRegistry) {
    log.warn('Voice trace PII registry unavailable; falling back to built-in scrubbers', {
      sessionId: session?.id,
      eventType,
    });
    return builtInScrubbed;
  }

  try {
    return applyProjectPIIRedaction(builtInScrubbed, session.piiRecognizerRegistry) as Record<
      string,
      unknown
    >;
  } catch (err) {
    log.warn('Voice trace project PII scrubbing failed; returning built-in scrubbed payload', {
      sessionId: session.id,
      eventType,
      error: err instanceof Error ? err.message : String(err),
    });
    return builtInScrubbed;
  }
}

export function scrubVoiceTraceEvent<T extends TraceEvent>(
  event: T,
  session?: Pick<RuntimeSession, 'id' | 'piiRecognizerRegistry'>,
): T {
  return {
    ...event,
    data: scrubVoiceTraceData(event.data, session, event.type),
  };
}

export function addScrubbedVoiceTraceEvent<T extends TraceEvent>(
  sessionId: string,
  event: T,
  session?: Pick<RuntimeSession, 'id' | 'piiRecognizerRegistry'>,
  options: AddScrubbedVoiceTraceEventOptions = {},
): T {
  const scrubbedEvent = scrubVoiceTraceEvent(event, session);
  getTraceStore().addEvent(sessionId, scrubbedEvent);
  incrementVoiceTraceCount(options, scrubbedEvent);
  persistScrubbedVoiceTraceEvent(scrubbedEvent, options);
  return scrubbedEvent;
}

function incrementVoiceTraceCount(
  options: AddScrubbedVoiceTraceEventOptions,
  event: TraceEvent,
): void {
  if (!options.incrementTraceEventCount || !options.dbSessionId || !options.tenantId) {
    return;
  }

  const { dbSessionId, tenantId } = options;

  loadMessagePersistenceQueue()
    .then(({ persistTurnMetrics }) =>
      persistTurnMetrics({
        dbSessionId,
        tenantId,
        tokensIn: 0,
        tokensOut: 0,
        cost: 0,
        traceEventCount: 1,
        errorCount: 0,
        handoffCount: 0,
      }),
    )
    .catch((err) => {
      log.warn('Voice trace count increment failed', {
        sessionId: event.sessionId,
        eventType: event.type,
        dbSessionId: options.dbSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
}

function persistScrubbedVoiceTraceEvent(
  event: TraceEvent,
  options: AddScrubbedVoiceTraceEventOptions,
): void {
  if (!options.persistToEventStore || !options.tenantId) {
    return;
  }

  try {
    const eventStore = getEventStore();
    if (!eventStore) {
      return;
    }

    const causalFields = resolveVoiceTraceCausalFields(event);
    emitToEventStore({
      eventStore,
      event: {
        id: event.id,
        type: event.type,
        sessionId: event.sessionId,
        tenantId: options.tenantId,
        projectId: options.projectId,
        deploymentId: options.deploymentId,
        agentName: event.agentName,
        timestamp: event.timestamp,
        durationMs: event.durationMs,
        spanId: event.spanId,
        parentSpanId: event.parentSpanId,
        ...causalFields,
        data: event.data,
      },
      knownSource: options.knownSource,
    });
  } catch (err) {
    log.warn('Voice trace EventStore emit failed', {
      sessionId: event.sessionId,
      eventType: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function resolveVoiceTraceCausalFields(event: TraceEvent): {
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase?: string;
  reasonCode?: string;
} {
  return {
    turnId: readCausalString(event, 'turnId'),
    executionId: readCausalString(event, 'executionId'),
    parentExecutionId: readCausalString(event, 'parentExecutionId'),
    agentRunId: readCausalString(event, 'agentRunId'),
    decisionId: readCausalString(event, 'decisionId'),
    parentDecisionId: readCausalString(event, 'parentDecisionId'),
    causeEventId: readCausalString(event, 'causeEventId'),
    phase: readCausalString(event, 'phase') ?? deriveRuntimeTracePhase(event.type),
    reasonCode: readCausalString(event, 'reasonCode') ?? event.type,
  };
}

function readCausalString(event: TraceEvent, fieldName: keyof TraceEvent): string | undefined {
  const directValue = event[fieldName];
  if (typeof directValue === 'string' && directValue.length > 0) {
    return directValue;
  }

  const dataValue = event.data[fieldName];
  if (typeof dataValue === 'string' && dataValue.length > 0) {
    return dataValue;
  }

  const causal = event.data.causal;
  if (causal && typeof causal === 'object' && !Array.isArray(causal)) {
    const causalValue = (causal as Record<string, unknown>)[fieldName];
    if (typeof causalValue === 'string' && causalValue.length > 0) {
      return causalValue;
    }
  }

  return undefined;
}
