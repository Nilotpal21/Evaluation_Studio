export interface TraceCausalFields {
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase?: string;
  reasonCode?: string;
}

export interface TraceCausalityEventLike {
  id: string;
  type?: string;
  event_type?: string;
  timestamp?: Date | string;
  agentName?: string;
  agent_name?: string;
  spanId?: string;
  span_id?: string;
  parentSpanId?: string;
  parent_span_id?: string;
  data?: Record<string, unknown>;
  turnId?: string;
  turn_id?: string;
  executionId?: string;
  execution_id?: string;
  parentExecutionId?: string;
  parent_execution_id?: string;
  agentRunId?: string;
  agent_run_id?: string;
  decisionId?: string;
  decision_id?: string;
  parentDecisionId?: string;
  parent_decision_id?: string;
  causeEventId?: string;
  cause_event_id?: string;
  phase?: string;
  reasonCode?: string;
  reason_code?: string;
}

export interface TraceCausalityRow<TEvent extends TraceCausalityEventLike> {
  index: number;
  event: TEvent;
  id: string;
  type: string;
  label: string;
  timestamp?: Date | string;
  agentName?: string;
  causal: TraceCausalFields;
  hasCausality: boolean;
  causeEvent?: TEvent;
  causeLabel?: string;
  causeDetail?: string;
  causeMissing: boolean;
}

export interface TraceCausalitySummary<TEvent extends TraceCausalityEventLike> {
  rows: TraceCausalityRow<TEvent>[];
  causalRows: TraceCausalityRow<TEvent>[];
  phaseCounts: Array<{ phase: string; count: number }>;
  agentRunCount: number;
  decisionCount: number;
  linkedCauseCount: number;
  resolvedCauseCount: number;
  missingCauseCount: number;
  traceHealthLabel: string;
  traceHealthDetail: string;
}

const CAUSAL_FIELD_KEYS = [
  'turnId',
  'executionId',
  'parentExecutionId',
  'agentRunId',
  'decisionId',
  'parentDecisionId',
  'causeEventId',
  'phase',
  'reasonCode',
] as const satisfies readonly (keyof TraceCausalFields)[];

type CausalFieldKey = (typeof CAUSAL_FIELD_KEYS)[number];

const SNAKE_CASE_KEY: Record<CausalFieldKey, string> = {
  turnId: 'turn_id',
  executionId: 'execution_id',
  parentExecutionId: 'parent_execution_id',
  agentRunId: 'agent_run_id',
  decisionId: 'decision_id',
  parentDecisionId: 'parent_decision_id',
  causeEventId: 'cause_event_id',
  phase: 'phase',
  reasonCode: 'reason_code',
};

export function getTraceCausalFields(event: TraceCausalityEventLike): TraceCausalFields {
  const data = event.data ?? {};
  const causal = asRecord(data.causal);

  return {
    turnId: readCausalField(event, data, causal, 'turnId'),
    executionId: readCausalField(event, data, causal, 'executionId'),
    parentExecutionId: readCausalField(event, data, causal, 'parentExecutionId'),
    agentRunId: readCausalField(event, data, causal, 'agentRunId'),
    decisionId: readCausalField(event, data, causal, 'decisionId'),
    parentDecisionId: readCausalField(event, data, causal, 'parentDecisionId'),
    causeEventId: readCausalField(event, data, causal, 'causeEventId'),
    phase: readCausalField(event, data, causal, 'phase'),
    reasonCode: readCausalField(event, data, causal, 'reasonCode'),
  };
}

export function attachTraceCausalFieldsToData(
  data: Record<string, unknown>,
  fields: TraceCausalFields,
): Record<string, unknown> {
  const definedFields = toDefinedRecord(fields);
  if (Object.keys(definedFields).length === 0) {
    return data;
  }

  const existingCausal = asRecord(data.causal);
  const nextData: Record<string, unknown> = {
    ...data,
    causal: {
      ...existingCausal,
      ...definedFields,
    },
  };

  for (const [key, value] of Object.entries(definedFields)) {
    if (nextData[key] === undefined) {
      nextData[key] = value;
    }
  }

  return nextData;
}

export function hasTraceCausality(fields: TraceCausalFields): boolean {
  return CAUSAL_FIELD_KEYS.some((key) => Boolean(fields[key]));
}

export function buildTraceCausalitySummary<TEvent extends TraceCausalityEventLike>(
  events: TEvent[],
): TraceCausalitySummary<TEvent> {
  const eventByReference = new Map<string, TEvent>();

  for (const event of events) {
    eventByReference.set(event.id, event);
    const spanId = getTraceSpanId(event);
    if (spanId) {
      eventByReference.set(spanId, event);
    }
  }

  const phaseCounts = new Map<string, number>();
  const agentRunIds = new Set<string>();
  const decisionIds = new Set<string>();

  const rows = events.map((event, index) => {
    const causal = getTraceCausalFields(event);
    const hasCausality = hasTraceCausality(causal);
    const causeEvent = causal.causeEventId ? eventByReference.get(causal.causeEventId) : undefined;
    const type = getTraceEventType(event);
    const agentName = getTraceAgentName(event);

    if (causal.phase) {
      phaseCounts.set(causal.phase, (phaseCounts.get(causal.phase) ?? 0) + 1);
    }
    if (causal.agentRunId) {
      agentRunIds.add(causal.agentRunId);
    }
    if (causal.decisionId) {
      decisionIds.add(causal.decisionId);
    }

    return {
      index,
      event,
      id: event.id,
      type,
      label: getTraceEventLabel(type, agentName),
      timestamp: event.timestamp,
      agentName,
      causal,
      hasCausality,
      causeEvent,
      causeLabel: causeEvent
        ? getTraceEventLabel(getTraceEventType(causeEvent), getTraceAgentName(causeEvent))
        : undefined,
      causeDetail: causeEvent
        ? `${getTraceEventType(causeEvent)} ${formatShortTraceId(causeEvent.id)}`
        : undefined,
      causeMissing: Boolean(causal.causeEventId && !causeEvent),
    };
  });

  const linkedCauseCount = rows.filter((row) => Boolean(row.causal.causeEventId)).length;
  const resolvedCauseCount = rows.filter((row) =>
    Boolean(row.causal.causeEventId && row.causeEvent),
  ).length;
  const missingCauseCount = rows.filter((row) => row.causeMissing).length;
  const traceHealthLabel =
    missingCauseCount === 0
      ? 'All loaded links resolved'
      : `${missingCauseCount} link${missingCauseCount === 1 ? '' : 's'} not loaded`;
  const traceHealthDetail =
    missingCauseCount === 0
      ? 'Every referenced cause event is present in this loaded trace view.'
      : 'Some events reference a cause id that is outside this loaded trace view, from older trace data, or stored under a different id shape.';

  return {
    rows,
    causalRows: rows.filter((row) => row.hasCausality),
    phaseCounts: Array.from(phaseCounts.entries())
      .map(([phase, count]) => ({ phase, count }))
      .sort((a, b) => b.count - a.count || a.phase.localeCompare(b.phase)),
    agentRunCount: agentRunIds.size,
    decisionCount: decisionIds.size,
    linkedCauseCount,
    resolvedCauseCount,
    missingCauseCount,
    traceHealthLabel,
    traceHealthDetail,
  };
}

export function getTraceEventType(event: TraceCausalityEventLike): string {
  return (
    pickString(
      event.type,
      event.event_type,
      event.data?.eventType,
      event.data?._runtime_trace_type,
    ) ?? 'unknown'
  );
}

export function getTraceEventLabel(type: string, agentName?: string): string {
  switch (type) {
    case 'user_message':
    case 'message.user.received':
      return 'User message';
    case 'agent_response':
    case 'message.agent.sent':
      return agentName ? `Agent response from ${agentName}` : 'Agent response';
    case 'agent_enter':
      return agentName ? `Agent entered ${agentName}` : 'Agent entered';
    case 'agent_exit':
      return agentName ? `Agent exited ${agentName}` : 'Agent exited';
    case 'llm_call':
    case 'llm.call.completed':
      return 'LLM call';
    case 'decision':
    case 'completion_check':
    case 'handoff_condition_check':
    case 'engine_decision':
      return 'Decision';
    case 'tool_call':
    case 'tool_call_start':
    case 'tool_result':
      return 'Tool call';
    case 'guardrail_check':
    case 'guardrail_warning':
      return 'Guardrail check';
    case 'status_update':
      return 'Status update';
    case 'error':
      return 'Runtime error';
    default:
      return humanizeTraceCode(type);
  }
}

export function getTraceAgentName(event: TraceCausalityEventLike): string | undefined {
  return pickString(
    event.agentName,
    event.agent_name,
    event.data?.agentName,
    event.data?.agent_name,
    event.data?.agent,
    event.data?.fromAgent,
    event.data?.from,
  );
}

export function getTraceSpanId(event: TraceCausalityEventLike): string | undefined {
  return pickString(event.spanId, event.span_id, event.data?.spanId, event.data?.span_id);
}

export function formatShortTraceId(value: string | undefined, prefixLength = 8): string {
  if (!value) {
    return '';
  }
  return value.length > prefixLength ? `${value.slice(0, prefixLength)}...` : value;
}

export function humanizeTraceCode(value: string | undefined): string {
  if (!value) {
    return '-';
  }
  return value
    .replace(/[_:.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readCausalField(
  event: TraceCausalityEventLike,
  data: Record<string, unknown>,
  causal: Record<string, unknown>,
  key: CausalFieldKey,
): string | undefined {
  const snakeKey = SNAKE_CASE_KEY[key];
  const eventRecord = event as unknown as Record<string, unknown>;
  return pickString(
    eventRecord[key],
    eventRecord[snakeKey],
    causal[key],
    causal[snakeKey],
    data[key],
    data[snakeKey],
  );
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) {
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

function toDefinedRecord(fields: TraceCausalFields): Record<string, string> {
  const record: Record<string, string> = {};
  for (const key of CAUSAL_FIELD_KEYS) {
    const value = fields[key];
    if (value) {
      record[key] = value;
    }
  }
  return record;
}
