import { createHash } from 'crypto';
import type { TraceEvent as TraceStoreEvent } from '../trace-store.js';
import {
  RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE,
  RUNTIME_TRACE_TYPE_DATA_KEY,
} from '../trace-event-types.js';

export interface ClickHouseSessionEventRow {
  event_id: string;
  event_type: string;
  category: string;
  span_id: string;
  parent_span_id: string;
  turn_id?: string;
  execution_id?: string;
  parent_execution_id?: string;
  agent_run_id?: string;
  decision_id?: string;
  parent_decision_id?: string;
  cause_event_id?: string;
  phase?: string;
  reason_code?: string;
  agent_name: string;
  timestamp: string;
  duration_ms: number;
  has_error: number;
  data: string | Record<string, unknown>;
  _enc: string;
}

export interface ClickHouseSessionTraceMappingOptions {
  rows: ClickHouseSessionEventRow[];
  sessionId: string;
  parseClickHouseTimestamp: (timestamp: string) => Date;
  typeMap: Readonly<Record<string, string>>;
}

const RESPONSE_SEMANTIC_DEDUPE_WINDOW_MS = 2000;

function normalizeOptionalString(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringifyRowData(data: string | Record<string, unknown>): string {
  if (typeof data === 'string') {
    return data;
  }

  try {
    return JSON.stringify(data ?? {});
  } catch {
    return '{}';
  }
}

function parseRowData(data: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof data !== 'string') {
    return data ?? {};
  }

  try {
    const parsed = JSON.parse(data);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function readCausalString(data: Record<string, unknown>, key: string): string | undefined {
  const causal = data.causal;
  if (causal && typeof causal === 'object' && !Array.isArray(causal)) {
    const nestedValue = (causal as Record<string, unknown>)[key];
    if (typeof nestedValue === 'string' && nestedValue.length > 0) {
      return nestedValue;
    }
  }

  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNestedRecord(
  data: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = data[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readAgentResponseText(data: Record<string, unknown>): string | undefined {
  const candidates = [
    data.content,
    data.response,
    data.message,
    data.agent_response,
    readNestedRecord(data, 'payload')?.content,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim().replace(/\s+/g, ' ');
    }
  }

  return undefined;
}

function isSemanticallyDuplicateAgentResponse(
  left: TraceStoreEvent,
  right: TraceStoreEvent,
): boolean {
  if (left.type !== 'agent_response' || right.type !== 'agent_response') {
    return false;
  }

  if ((left.agentName ?? '') !== (right.agentName ?? '')) {
    return false;
  }

  const leftText = readAgentResponseText(left.data);
  const rightText = readAgentResponseText(right.data);
  if (!leftText || !rightText || leftText !== rightText) {
    return false;
  }

  if (left.turnId && right.turnId) {
    return left.turnId === right.turnId;
  }

  return (
    Math.abs(left.timestamp.getTime() - right.timestamp.getTime()) <=
    RESPONSE_SEMANTIC_DEDUPE_WINDOW_MS
  );
}

function prefersAgentResponseEvent(candidate: TraceStoreEvent, current: TraceStoreEvent): boolean {
  const candidateSource = candidate.data.source;
  const currentSource = current.data.source;
  if (typeof candidateSource === 'string' && typeof currentSource !== 'string') {
    return true;
  }

  if (typeof candidateSource !== 'string' && typeof currentSource === 'string') {
    return false;
  }

  return candidate.id.localeCompare(current.id) < 0;
}

function buildAgentResponseDedupeKey(event: TraceStoreEvent): string | undefined {
  if (event.type !== 'agent_response') {
    return undefined;
  }

  const text = readAgentResponseText(event.data);
  if (!text) {
    return undefined;
  }

  return JSON.stringify([event.agentName ?? '', text]);
}

export function dedupeTraceEventsBySemanticResponse(events: TraceStoreEvent[]): TraceStoreEvent[] {
  const deduped: TraceStoreEvent[] = [];
  const agentResponseIndexes = new Map<string, number[]>();

  for (const event of events) {
    const dedupeKey = buildAgentResponseDedupeKey(event);
    const candidateIndexes = dedupeKey ? (agentResponseIndexes.get(dedupeKey) ?? []) : [];
    const duplicateIndex =
      candidateIndexes.find((index) =>
        isSemanticallyDuplicateAgentResponse(deduped[index]!, event),
      ) ?? -1;

    if (duplicateIndex === -1) {
      deduped.push(event);
      if (dedupeKey) {
        agentResponseIndexes.set(dedupeKey, [...candidateIndexes, deduped.length - 1]);
      }
      continue;
    }

    const existing = deduped[duplicateIndex]!;
    if (prefersAgentResponseEvent(event, existing)) {
      deduped[duplicateIndex] = event;
    }
  }

  return deduped;
}

function buildFallbackFingerprint(row: ClickHouseSessionEventRow): string {
  return JSON.stringify({
    eventType: row.event_type,
    category: row.category,
    spanId: normalizeOptionalString(row.span_id),
    parentSpanId: normalizeOptionalString(row.parent_span_id),
    turnId: normalizeOptionalString(row.turn_id),
    executionId: normalizeOptionalString(row.execution_id),
    parentExecutionId: normalizeOptionalString(row.parent_execution_id),
    agentRunId: normalizeOptionalString(row.agent_run_id),
    decisionId: normalizeOptionalString(row.decision_id),
    parentDecisionId: normalizeOptionalString(row.parent_decision_id),
    causeEventId: normalizeOptionalString(row.cause_event_id),
    phase: normalizeOptionalString(row.phase),
    reasonCode: normalizeOptionalString(row.reason_code),
    agentName: normalizeOptionalString(row.agent_name),
    timestamp: row.timestamp,
    durationMs: row.duration_ms ?? 0,
    hasError: row.has_error ?? 0,
    data: stringifyRowData(row.data),
  });
}

export function buildClickHouseSessionEventDedupKey(row: ClickHouseSessionEventRow): string {
  const eventId = normalizeOptionalString(row.event_id);
  if (eventId) {
    return `event:${eventId}`;
  }

  return `fallback:${buildFallbackFingerprint(row)}`;
}

function buildClickHouseSessionEventId(row: ClickHouseSessionEventRow, sessionId: string): string {
  const eventId = normalizeOptionalString(row.event_id);
  if (eventId) {
    return eventId;
  }

  const digest = createHash('sha1')
    .update(`${sessionId}:${buildFallbackFingerprint(row)}`)
    .digest('hex')
    .slice(0, 20);

  return `ch-${digest}`;
}

export function dedupeClickHouseSessionEventRows(
  rows: ClickHouseSessionEventRow[],
): ClickHouseSessionEventRow[] {
  const seen = new Set<string>();

  return rows.filter((row) => {
    const dedupeKey = buildClickHouseSessionEventDedupKey(row);
    if (seen.has(dedupeKey)) {
      return false;
    }

    seen.add(dedupeKey);
    return true;
  });
}

export function mapClickHouseSessionEventRowsToTraceEvents(
  options: ClickHouseSessionTraceMappingOptions,
): TraceStoreEvent[] {
  const dedupedRows = dedupeClickHouseSessionEventRows(options.rows);

  const events = dedupedRows.map((row) => {
    const data = parseRowData(row.data);
    const runtimeTraceType =
      row.event_type === RUNTIME_ATOMIC_PLATFORM_EVENT_TYPE &&
      typeof data[RUNTIME_TRACE_TYPE_DATA_KEY] === 'string'
        ? (data[RUNTIME_TRACE_TYPE_DATA_KEY] as string)
        : undefined;

    return {
      id: buildClickHouseSessionEventId(row, options.sessionId),
      sessionId: options.sessionId,
      type: runtimeTraceType || options.typeMap[row.event_type] || row.event_type,
      timestamp: options.parseClickHouseTimestamp(row.timestamp),
      data,
      agentName: row.agent_name || undefined,
      spanId: row.span_id || undefined,
      parentSpanId: row.parent_span_id || undefined,
      turnId: row.turn_id || readCausalString(data, 'turnId'),
      executionId: row.execution_id || readCausalString(data, 'executionId'),
      parentExecutionId: row.parent_execution_id || readCausalString(data, 'parentExecutionId'),
      agentRunId: row.agent_run_id || readCausalString(data, 'agentRunId'),
      decisionId: row.decision_id || readCausalString(data, 'decisionId'),
      parentDecisionId: row.parent_decision_id || readCausalString(data, 'parentDecisionId'),
      causeEventId: row.cause_event_id || readCausalString(data, 'causeEventId'),
      phase: row.phase || readCausalString(data, 'phase'),
      reasonCode: row.reason_code || readCausalString(data, 'reasonCode'),
      durationMs: row.duration_ms || undefined,
      has_error: Boolean(row.has_error),
    };
  }) as TraceStoreEvent[];

  return dedupeTraceEventsBySemanticResponse(events);
}
