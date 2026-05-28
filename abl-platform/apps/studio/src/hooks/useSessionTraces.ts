/**
 * useSessionTraces Hook
 *
 * Fetches trace events for a specific session via the Studio proxy.
 * SWR hook following useAnalytics.ts patterns.
 *
 * Normalizes field names from the runtime API (camelCase: type, agentName, spanId)
 * to snake_case (event_type, agent_name, span_id) used by the UI components.
 */

import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';

export interface SessionTrace {
  id: string;
  event_type: string;
  timestamp: string;
  duration_ms?: number;
  agent_name?: string;
  span_id?: string;
  parent_span_id?: string;
  turnId?: string;
  executionId?: string;
  parentExecutionId?: string;
  agentRunId?: string;
  decisionId?: string;
  parentDecisionId?: string;
  causeEventId?: string;
  phase?: string;
  reasonCode?: string;
  has_error?: boolean;
  data: Record<string, unknown>;
}

/** Raw trace shape from runtime API (may use camelCase or snake_case) */
export interface RawSessionTrace {
  id: string;
  // Runtime TraceStore uses camelCase
  type?: string;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  durationMs?: number;
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
  // ClickHouse fallback uses snake_case
  event_type?: string;
  agent_name?: string;
  span_id?: string;
  parent_span_id?: string;
  duration_ms?: number;
  has_error?: boolean;
  timestamp: string;
  data: Record<string, unknown>;
}

interface SessionTracesResponse {
  success: boolean;
  data?: {
    traces: RawSessionTrace[];
    total: number;
    _meta?: TraceResponseMeta;
  };
  traces?: RawSessionTrace[];
  total?: number;
  _meta?: TraceResponseMeta;
}

export interface TraceResponseMeta {
  source?: string;
  event_count?: number;
  loaded_count?: number;
  available_count?: number;
  is_truncated?: boolean;
  source_chain?: string[];
  warnings?: Array<{ source: string; code: string; message: string }>;
  errors?: Array<{ source: string; code: string; message: string }>;
}

export function normalizeSessionTrace(raw: RawSessionTrace): SessionTrace {
  return {
    id: raw.id,
    event_type: raw.event_type || raw.type || 'unknown',
    timestamp: raw.timestamp,
    duration_ms: raw.duration_ms ?? raw.durationMs,
    agent_name: raw.agent_name || raw.agentName,
    span_id: raw.span_id || raw.spanId,
    parent_span_id: raw.parent_span_id || raw.parentSpanId,
    turnId: raw.turnId || raw.turn_id,
    executionId: raw.executionId || raw.execution_id,
    parentExecutionId: raw.parentExecutionId || raw.parent_execution_id,
    agentRunId: raw.agentRunId || raw.agent_run_id,
    decisionId: raw.decisionId || raw.decision_id,
    parentDecisionId: raw.parentDecisionId || raw.parent_decision_id,
    causeEventId: raw.causeEventId || raw.cause_event_id,
    phase: raw.phase,
    reasonCode: raw.reasonCode || raw.reason_code,
    has_error: raw.has_error ?? false,
    data: raw.data || {},
  };
}

export function useSessionTraces(
  sessionId: string | null,
  projectId: string | null,
  options?: { types?: string[]; limit?: number },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.types?.length) params.set('types', options.types.join(','));

  const qs = params.toString();
  const key =
    isAuthenticated && sessionId && projectId
      ? `/api/runtime/sessions/${encodeURIComponent(sessionId)}/traces?${qs}`
      : null;

  const { data, error, isLoading, mutate } = useSWR<SessionTracesResponse>(key, {
    refreshInterval: 15_000,
    keepPreviousData: true,
  });

  // Handle both response shapes and normalize field names
  const rawTraces: RawSessionTrace[] = data?.data?.traces ?? data?.traces ?? [];
  const traces: SessionTrace[] = rawTraces.map(normalizeSessionTrace);
  const total: number = data?.data?.total ?? data?.total ?? traces.length;
  const meta = data?.data?._meta ?? data?._meta ?? null;

  return {
    traces,
    total,
    meta,
    isLoading,
    error: error ? String(error) : null,
    refresh: () => mutate(),
  };
}
