/**
 * useSessionDetail Hook
 *
 * Fetches full session data for the detail page.
 * Transforms trace events into a hierarchical tree for AgentExecutionTree.
 * Isolated from live chat session state.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { useObservatoryStore } from '../store/observatory-store';
import { useSessionStore } from '../store/session-store';
import { apiFetch } from '../lib/api-client';
import {
  replayTraceEventsIntoObservatory,
  hydrateSessionStoreFromDetail,
  augmentSessionMessagesWithTraceEvents,
} from '../utils/replay-trace-events';
import { normalizeEventType } from '../lib/event-types';
import { buildAgentTree } from '../lib/buildAgentTree';
import { normalizeTraceEventRecord } from '../utils/trace-event-adapter';
import type { TraceEvent, SessionMessage } from '../types';
import { AppError, ErrorCodes } from '@agent-platform/shared/errors';

// ── Tree node types ─────────────────────────────────────────────────────────

export type TreeNodeType =
  | 'user_input'
  | 'agent'
  | 'sub_agent'
  | 'llm_call'
  | 'tool_call'
  | 'attachment_process'
  | 'attachment_upload'
  | 'attachment_preprocess'
  | 'handoff'
  | 'delegate_action'
  | 'complete'
  | 'escalate'
  | 'decision'
  | 'flow_step'
  | 'flow_transition'
  | 'agent_response'
  | 'constraint_check'
  | 'guardrail_check'
  | 'gather_extraction'
  | 'correction'
  | 'error'
  // Voice pipeline events
  | 'voice_session_start'
  | 'voice_session_end'
  | 'voice_turn'
  | 'voice_stt'
  | 'voice_tts'
  | 'voice_realtime_tool_call'
  | 'voice_barge_in';

export interface TreeNode {
  id: string;
  type: TreeNodeType;
  label: string;
  /** Associated observatory span when this node maps to a real span */
  spanId?: string;
  /** Secondary label (e.g. model name, tool name) */
  detail?: string;
  /** Token counts for LLM calls */
  tokens?: { input: number; output: number };
  /** Latency in ms */
  latencyMs?: number;
  /** Timestamp of the event */
  timestamp?: string;
  /** The raw trace event or message backing this node */
  data?: Record<string, unknown>;
  children: TreeNode[];
}

// ── Session detail data shape ───────────────────────────────────────────────

export interface SessionDetailData {
  id: string;
  agentName: string;
  agent?: Record<string, unknown>;
  state?: Record<string, unknown>;
  messages: SessionMessage[];
  traceEvents: TraceEvent[];
  createdAt?: string;
  lastActivityAt?: string;
  /** DB aggregate fields — used when traces are expired/unavailable */
  tokenCount?: number;
  estimatedCost?: number;
  messageCount?: number;
  traceMeta?: TraceResponseMeta;
  traceLoadStatus?: TraceLoadStatus;
  traceLoadError?: string;
}

export type TraceLoadStatus = 'idle' | 'loading' | 'loaded' | 'failed';

export interface TraceReadDiagnostic {
  source: string;
  code: string;
  message: string;
}

export interface TraceResponseMeta {
  source?: string;
  event_count?: number;
  loaded_count?: number;
  available_count?: number;
  is_truncated?: boolean;
  source_chain?: string[];
  warnings?: TraceReadDiagnostic[];
  errors?: TraceReadDiagnostic[];
}

interface TraceFetchResult {
  events: TraceEvent[];
  meta?: TraceResponseMeta;
}

interface BackgroundTraceState extends TraceFetchResult {
  status: TraceLoadStatus;
  error?: string;
}

// ── Hook ────────────────────────────────────────────────────────────────────

async function fetchSessionDetail(url: string): Promise<SessionDetailData> {
  const response = await apiFetch(url, { cache: 'no-store' });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new AppError('Session response is not valid JSON', { ...ErrorCodes.INTERNAL_ERROR });
  }

  if (typeof data !== 'object' || data === null) {
    throw new AppError('Session response is not a valid object', { ...ErrorCodes.INTERNAL_ERROR });
  }

  const dataObj = data as Record<string, unknown>;

  // Runtime may return { success, session } OR just { session } depending on proxy
  const sessionData = (dataObj.session || dataObj) as Record<string, unknown>;
  if (!sessionData?.id) {
    const rawError = dataObj.error;
    const errorMessage =
      typeof rawError === 'string'
        ? rawError
        : ((rawError as Record<string, unknown> | undefined)?.message ?? 'Failed to load session');
    throw new AppError(String(errorMessage), { ...ErrorCodes.INTERNAL_ERROR });
  }

  interface RawSessionData {
    id: string;
    agentName?: string;
    agent?: string | Record<string, unknown>;
    state?: Record<string, unknown>;
    messages?: unknown[];
    traceEvents?: unknown[];
    createdAt?: string;
    lastActivityAt?: string;
    tokenCount?: number;
    estimatedCost?: number;
    messageCount?: number;
  }

  const s = sessionData as unknown as RawSessionData;
  // The detail endpoint returns `agent` as a string (e.g. "traveldesk/TravelDesk_Supervisor"),
  // not as an object. Extract the agent name from it.
  const resolvedAgentName: string =
    s.agentName ||
    (typeof s.agent === 'string'
      ? (s.agent.split('/').pop() ?? s.agent)
      : String((s.agent as Record<string, unknown> | undefined)?.name ?? '')) ||
    'Unknown';

  const rawMessages = Array.isArray(s.messages) ? s.messages.filter(isRecord) : [];
  const rawTraceEvents = Array.isArray(s.traceEvents) ? s.traceEvents.filter(isRecord) : [];
  const traceEvents = normalizeTraceEvents(rawTraceEvents, s.id);
  const agentObject =
    typeof s.agent === 'object' ? (s.agent as Record<string, unknown>) : undefined;

  return {
    id: s.id,
    agentName: resolvedAgentName,
    agent: agentObject,
    state: s.state,
    messages: rawMessages.map(
      (m) =>
        ({
          ...m,
          timestamp: m.timestamp ? new Date(m.timestamp as string) : new Date(),
        }) as unknown as SessionMessage,
    ),
    traceEvents,
    createdAt: s.createdAt,
    lastActivityAt: s.lastActivityAt,
    tokenCount: s.tokenCount,
    estimatedCost: s.estimatedCost,
    messageCount: s.messageCount,
    traceLoadStatus: traceEvents.length > 0 ? 'loaded' : 'idle',
  };
}

function normalizeTraceEvents(
  rawTraceEvents: Record<string, unknown>[],
  sessionId?: string,
): TraceEvent[] {
  return rawTraceEvents.map((event) =>
    normalizeTraceEventRecord(event, {
      fallbackSessionId: sessionId,
      fallbackTraceId: sessionId,
    }),
  );
}

async function fetchTraceEventsForSession(
  sessionId: string,
  projectId: string,
): Promise<TraceFetchResult> {
  const response = await apiFetch(
    `/api/runtime/sessions/${encodeURIComponent(sessionId)}/traces?projectId=${encodeURIComponent(projectId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Trace fetch failed with status ${response.status}`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Trace response is not valid JSON');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Trace response is not a valid object');
  }

  const dataObject = data as Record<string, unknown>;
  const meta =
    ((dataObject._meta as TraceResponseMeta | undefined) ||
      ((dataObject.data as Record<string, unknown> | undefined)?._meta as
        | TraceResponseMeta
        | undefined)) ??
    undefined;
  const rawTracesValue =
    dataObject.traces ?? (dataObject.data as Record<string, unknown> | undefined)?.traces;
  const rawTraces = Array.isArray(rawTracesValue) ? rawTracesValue.filter(isRecord) : [];

  return {
    events: normalizeTraceEvents(rawTraces, sessionId),
    meta,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function fetchAgentSpecForSession(
  sessionId: string,
  projectId: string,
): Promise<Record<string, unknown> | undefined> {
  const response = await apiFetch(
    `/api/runtime/sessions/${encodeURIComponent(sessionId)}/agent-spec?projectId=${encodeURIComponent(projectId)}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    throw new Error(`Agent fetch failed with status ${response.status}`);
  }

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Agent response is not valid JSON');
  }

  if (typeof data !== 'object' || data === null) {
    throw new Error('Agent response is not a valid object');
  }

  const dataObject = data as Record<string, unknown>;
  return (dataObject.agent || dataObject) as Record<string, unknown>;
}

function toSessionAgentDetails(session: SessionDetailData, agentObject?: Record<string, unknown>) {
  const currentAgent = useSessionStore.getState().agent;
  return {
    id: (agentObject?.id as string) || currentAgent?.id || session.id,
    name: (agentObject?.name as string) || currentAgent?.name || session.agentName || 'Unknown',
    filePath: (agentObject?.filePath as string) || currentAgent?.filePath || undefined,
    type: (agentObject?.type as 'agent' | 'supervisor') || currentAgent?.type || 'agent',
    mode: (agentObject?.mode as 'reasoning' | 'scripted') || currentAgent?.mode || 'reasoning',
    toolCount: (agentObject?.toolCount as number) || currentAgent?.toolCount || 0,
    gatherFieldCount:
      (agentObject?.gatherFieldCount as number) || currentAgent?.gatherFieldCount || 0,
    isSupervisor: (agentObject?.isSupervisor as boolean) || currentAgent?.isSupervisor || false,
    dsl: (agentObject?.dsl as string) || currentAgent?.dsl || '',
    ir: agentObject?.ir ?? currentAgent?.ir,
  };
}

function hasLoadedAgentSpec(agentObject?: Record<string, unknown>): boolean {
  if (!agentObject) {
    return false;
  }

  return (
    agentObject.dsl !== undefined ||
    agentObject.ir !== undefined ||
    agentObject.mode !== undefined ||
    agentObject.type !== undefined
  );
}

export function useSessionDetail(sessionId: string | null, projectId?: string | null) {
  const key =
    sessionId && projectId
      ? `/api/runtime/sessions/${sessionId}?projectId=${projectId}&includeTraces=false`
      : null;
  const debugPanelTab = useObservatoryStore((s) => s.debugPanelTab);
  const [backgroundTraceState, setBackgroundTraceState] = useState<BackgroundTraceState | null>(
    null,
  );
  const [backgroundAgent, setBackgroundAgent] = useState<Record<string, unknown> | undefined>(
    undefined,
  );
  const lastReplayedRef = useRef<string | null>(null);
  const traceFetchKeyRef = useRef<string | null>(null);

  const {
    data: session = null,
    error: swrError,
    isLoading,
    mutate,
  } = useSWR<SessionDetailData>(key, fetchSessionDetail, { revalidateOnFocus: false });

  // When projectId is absent the SWR key is null, so isLoading stays false.
  // Treat this as loading when we have a sessionId but no projectId yet.
  const loading = isLoading || (!!sessionId && !projectId);

  useEffect(() => {
    setBackgroundTraceState(null);
    setBackgroundAgent(undefined);
    lastReplayedRef.current = null;
    traceFetchKeyRef.current = null;
  }, [session?.id]);

  useEffect(() => {
    if (!session || !projectId || session.traceEvents.length > 0) return;

    const traceFetchKey = `${session.id}:${projectId}`;
    if (traceFetchKeyRef.current === traceFetchKey) return;
    traceFetchKeyRef.current = traceFetchKey;
    const activeSessionId = session.id;
    const activeProjectId = projectId;

    let cancelled = false;
    setBackgroundTraceState({ status: 'loading', events: [] });

    void (async () => {
      try {
        const traceResult = await fetchTraceEventsForSession(activeSessionId, activeProjectId);
        if (!cancelled) {
          setBackgroundTraceState({
            status: 'loaded',
            events: traceResult.events,
            meta: traceResult.meta,
          });
        }
      } catch (error) {
        if (!cancelled) {
          setBackgroundTraceState({
            status: 'failed',
            events: [],
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectId, session?.id, session?.traceEvents.length]);

  useEffect(() => {
    if (
      !session ||
      !projectId ||
      debugPanelTab !== 'ir' ||
      hasLoadedAgentSpec(session.agent) ||
      backgroundAgent
    ) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const agentDetails = await fetchAgentSpecForSession(session.id, projectId);
        if (!cancelled) {
          setBackgroundAgent(agentDetails);
        }
      } catch {
        // Leave IR tab in "no agent loaded" state if fetch fails.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [backgroundAgent, debugPanelTab, projectId, session]);

  const effectiveTraceEvents = useMemo(
    () => backgroundTraceState?.events ?? session?.traceEvents ?? [],
    [backgroundTraceState, session],
  );

  const traceMeta = useMemo(
    () => backgroundTraceState?.meta ?? session?.traceMeta,
    [backgroundTraceState, session],
  );

  const traceLoadStatus = backgroundTraceState?.status ?? session?.traceLoadStatus ?? 'idle';
  const traceLoadError = backgroundTraceState?.error ?? session?.traceLoadError;

  const effectiveAgent = useMemo(
    () => backgroundAgent ?? session?.agent,
    [backgroundAgent, session],
  );

  const augmentedMessages = useMemo(() => {
    if (!session) return [];
    return augmentSessionMessagesWithTraceEvents(session.messages, effectiveTraceEvents) as
      | SessionMessage[]
      | [];
  }, [session, effectiveTraceEvents]);

  const mergedSession = useMemo(
    () =>
      session
        ? {
            ...session,
            agent: effectiveAgent,
            traceEvents: effectiveTraceEvents,
            traceMeta,
            traceLoadStatus,
            traceLoadError,
            messages: augmentedMessages,
          }
        : null,
    [
      effectiveAgent,
      effectiveTraceEvents,
      session,
      augmentedMessages,
      traceLoadError,
      traceLoadStatus,
      traceMeta,
    ],
  );

  // Hydrate observatory + session stores whenever the selected session payload
  // materially changes, even if the session id stays the same (for example
  // reset, resume, or background trace/message enrichment).
  useEffect(() => {
    if (!mergedSession) return;

    hydrateSessionStoreFromDetail(mergedSession);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mergedSession]);

  useEffect(() => {
    if (!mergedSession || effectiveTraceEvents.length === 0) return;

    const lastTraceId = effectiveTraceEvents[effectiveTraceEvents.length - 1]?.id || 'none';
    const replayKey = `${mergedSession.id}:${effectiveTraceEvents.length}:${lastTraceId}`;
    if (lastReplayedRef.current === replayKey) return;

    replayTraceEventsIntoObservatory(effectiveTraceEvents, mergedSession.id);
    lastReplayedRef.current = replayKey;
  }, [effectiveTraceEvents, mergedSession]);

  useEffect(() => {
    if (!session || !effectiveAgent) return;
    useSessionStore.setState({
      agent: toSessionAgentDetails(session, effectiveAgent),
    });
  }, [effectiveAgent, session]);

  useEffect(
    () => () => {
      // Cleanup: fully clear all stores when leaving session detail
      // to prevent stale data bleeding into the next view.
      const obs = useObservatoryStore.getState();
      obs.clearEvents();
      obs.clearFlow();
      obs.resetMetrics();
      obs.clearLogs();
      obs.clearExecutionState();
      obs.clearSelection();
      useSessionStore.getState().clearSession();
    },
    [],
  );

  // Build the hierarchical tree from messages + trace events
  const tree = useMemo(
    () =>
      mergedSession
        ? buildAgentTree(mergedSession.messages, mergedSession.traceEvents, mergedSession.agentName)
        : [],
    [mergedSession],
  );

  // Compute aggregate metrics (prefer trace-derived, fallback to DB aggregates)
  const metrics = useMemo(() => {
    if (!mergedSession) return { totalTokens: 0, totalCost: 0, latencyMs: 0, llmCalls: 0 };
    const traceMetrics = computeMetrics(mergedSession.traceEvents);

    // If traces are empty but DB aggregates are available, use those
    if (mergedSession.traceEvents.length === 0) {
      if (mergedSession.tokenCount) traceMetrics.totalTokens = mergedSession.tokenCount;
      if (mergedSession.estimatedCost) traceMetrics.totalCost = mergedSession.estimatedCost;
      // Approximate latency from session timestamps
      if (mergedSession.createdAt && mergedSession.lastActivityAt) {
        const start = new Date(mergedSession.createdAt).getTime();
        const end = new Date(mergedSession.lastActivityAt).getTime();
        if (end > start) traceMetrics.latencyMs = end - start;
      }
    }
    return traceMetrics;
  }, [mergedSession]);

  const error = swrError ? String(swrError.message || swrError) : null;

  return { session: mergedSession, loading, error, refresh: () => mutate(), tree, metrics };
}

// ── Metrics ─────────────────────────────────────────────────────────────────

/** Extract token counts from trace event data, handling both TraceEmitter and TestTraceManager shapes */
function extractTokens(data: Record<string, unknown>): { input: number; output: number } {
  const tokenUsage = data.tokenUsage as Record<string, number> | undefined;
  return {
    input: (data.tokensIn as number) || tokenUsage?.input || 0,
    output: (data.tokensOut as number) || tokenUsage?.output || 0,
  };
}

function computeMetrics(traceEvents: TraceEvent[]) {
  let totalTokens = 0;
  let llmCalls = 0;

  for (const event of traceEvents) {
    if (normalizeEventType(event.type) === 'llm_call') {
      llmCalls++;
      const tokens = extractTokens(event.data || {});
      totalTokens += tokens.input + tokens.output;
    }
  }

  // Compute total session latency
  let latencyMs = 0;
  if (traceEvents.length >= 2) {
    const first = new Date(traceEvents[0].timestamp).getTime();
    const last = new Date(traceEvents[traceEvents.length - 1].timestamp).getTime();
    latencyMs = last - first;
  }

  // Rough cost estimate: $0.003 per 1K input, $0.015 per 1K output (GPT-4 ballpark)
  const COST_PER_TOKEN = 0.000005;
  const totalCost = totalTokens * COST_PER_TOKEN;

  return { totalTokens, totalCost, latencyMs, llmCalls };
}
