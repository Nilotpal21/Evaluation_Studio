import { createLogger } from '@abl/compiler/platform/logger.js';
import type { PageContext } from '@agent-platform/arch-ai';
import { z } from 'zod';
import { getRuntimeUrl } from '@/config/runtime.server';
import { checkToolPermission, type ToolPermissionContext } from '../guards';
import type {
  TraceDiagnosisInputShape,
  ResolvedDiagnosisTimeRange,
  ResolvedTraceDiagnosisInput,
} from './trace-diagnosis-resolver';
import {
  normalizeTraceDiagnosisEnvironment,
  resolveTraceDiagnosisInput,
} from './trace-diagnosis-resolver';

const log = createLogger('arch-ai:trace-diagnosis');

const TRACE_DIAGNOSIS_FETCH_TIMEOUT_MS = 20_000;
const TRACE_DIAGNOSIS_DEFAULT_TRACE_LIMIT = 100;
const TRACE_DIAGNOSIS_SESSION_PAGE_SIZE = 200;
const TRACE_DIAGNOSIS_MAX_SESSION_SCAN = 1_000;

export const TraceDiagnosisInputSchema: z.ZodType<TraceDiagnosisInputShape> = z.object({
  action: z.enum(['discover', 'deep_dive', 'aggregate', 'compare', 'errors', 'explain']),
  query: z
    .string()
    .optional()
    .describe(
      'Original user phrasing. Include relative phrases like "last 24 hours", "two days", "my last session", or "recent traces" when present.',
    ),
  sessionId: z.string().optional().describe('Target session ID when known'),
  compareWithSessionId: z.string().optional().describe('Second session ID for compare queries'),
  compareWithTimeRange: z
    .string()
    .optional()
    .describe('Second time range for time-window comparisons, e.g. yesterday or last week'),
  compareFrom: z.string().optional().describe('Explicit ISO 8601 start for comparison window'),
  compareTo: z.string().optional().describe('Explicit ISO 8601 end for comparison window'),
  environment: z
    .string()
    .optional()
    .describe('Filter by environment, for example production, staging, or development'),
  compareWithEnvironment: z
    .string()
    .optional()
    .describe('Second environment for environment-vs-environment comparisons'),
  groupByEnvironment: z
    .boolean()
    .optional()
    .describe('When true, return a breakdown grouped by environment'),
  sessionRef: z
    .string()
    .optional()
    .describe('Relative session reference such as "current", "this session", "last", or "recent"'),
  agentName: z.string().optional().describe('Filter by agent name'),
  channel: z.string().optional().describe('Filter by channel'),
  status: z.string().optional().describe('Filter by session status'),
  disposition: z.string().optional().describe('Filter by session disposition'),
  mine: z
    .boolean()
    .optional()
    .describe('When true, scope discovery to the caller’s own sessions only'),
  timeRange: z
    .string()
    .optional()
    .describe('Relative time range such as "24h", "7d", "last 3 months", "today", or "yesterday"'),
  from: z.string().optional().describe('Explicit ISO 8601 start timestamp'),
  to: z.string().optional().describe('Explicit ISO 8601 end timestamp'),
  limit: z.number().optional().describe('Max sessions or events to return (default 20, max 100)'),
  traceTypes: z.array(z.string()).optional().describe('Trace event types to include'),
  spanId: z.string().optional().describe('Specific span or event identifier for explain queries'),
});

interface TraceDiagnosisEnv {
  pageContext?: PageContext | null;
}

interface DiagnosisSessionSummary {
  id: string;
  agentName: string;
  status: string;
  createdAt?: string;
  lastActivityAt?: string;
  channel?: string;
  disposition?: string | null;
  messageCount: number;
  traceEventCount: number;
  errorCount: number;
  tokenCount: number;
  estimatedCost: number;
  durationMs: number;
  environment?: string;
}

interface DiagnosisTraceEvent {
  id: string;
  eventType: string;
  timestamp: string;
  durationMs?: number;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
  hasError: boolean;
  data: Record<string, unknown>;
}

interface RuntimeFetchResult {
  ok: boolean;
  status: number;
  body: unknown | null;
  error?: { code: string; message: string };
}

interface ResolveSessionTargetResult {
  sessionId: string;
  source: 'explicit' | 'page_context' | 'last' | 'discovered_single' | 'compare_fallback';
  candidateSessions?: DiagnosisSessionSummary[];
}

interface TraceDiagnosisResult {
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface SessionListFetchSuccess {
  success: true;
  sessions: DiagnosisSessionSummary[];
  total: number;
}

type SessionListFetchResult =
  | SessionListFetchSuccess
  | {
      success: false;
      error: { code: string; message: string };
    };

interface DiagnosisSessionInventory {
  sessions: DiagnosisSessionSummary[];
  total: number;
  scannedSessions: number;
  truncated: boolean;
}

interface SessionAggregateSummary {
  sessionCount: number;
  activeCount: number;
  totalErrors: number;
  erroredSessionCount: number;
  errorRate: number;
  totalDurationMs: number;
  avgDurationMs: number;
  totalTokens: number;
  totalEstimatedCost: number;
  statusCounts: Record<string, number>;
  latestSessionId: string | null;
  latestActivityAt: string | null;
  environments: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function safeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizeSessionSummary(raw: unknown): DiagnosisSessionSummary | null {
  if (!isRecord(raw)) {
    return null;
  }

  const id = safeString(raw.id);
  const agentName = safeString(raw.agentName) ?? safeString(raw.agentId);
  const status = safeString(raw.status);
  if (!id || !agentName || !status) {
    return null;
  }

  return {
    id,
    agentName,
    status,
    createdAt: safeString(raw.createdAt),
    lastActivityAt: safeString(raw.lastActivityAt),
    channel: safeString(raw.channel),
    disposition: raw.disposition === null ? null : (safeString(raw.disposition) ?? null),
    messageCount: safeNumber(raw.messageCount),
    traceEventCount: safeNumber(raw.traceEventCount),
    errorCount: safeNumber(raw.errorCount),
    tokenCount: safeNumber(raw.tokenCount),
    estimatedCost: safeNumber(raw.estimatedCost),
    durationMs: safeNumber(raw.durationMs),
    environment: normalizeTraceDiagnosisEnvironment(safeString(raw.environment)),
  };
}

function normalizeTraceEvent(raw: unknown): DiagnosisTraceEvent | null {
  if (!isRecord(raw)) {
    return null;
  }

  const id = safeString(raw.id) ?? safeString(raw.event_id);
  const timestamp = safeString(raw.timestamp);
  const eventType = safeString(raw.event_type) ?? safeString(raw.type);
  if (!id || !timestamp || !eventType) {
    return null;
  }

  return {
    id,
    eventType,
    timestamp,
    durationMs: safeNumber(raw.duration_ms, safeNumber(raw.durationMs)),
    agentName: safeString(raw.agent_name) ?? safeString(raw.agentName),
    spanId: safeString(raw.span_id) ?? safeString(raw.spanId),
    parentSpanId: safeString(raw.parent_span_id) ?? safeString(raw.parentSpanId),
    hasError: raw.has_error === true || raw.has_error === 1,
    data: isRecord(raw.data) ? raw.data : {},
  };
}

function normalizeSessionDetail(raw: unknown): Record<string, unknown> | null {
  if (!isRecord(raw)) {
    return null;
  }

  return isRecord(raw.session) ? raw.session : null;
}

function buildRuntimeHeaders(ctx: ToolPermissionContext): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Tenant-Id': ctx.user.tenantId,
  };

  if (ctx.authToken) {
    headers.Authorization = `Bearer ${ctx.authToken}`;
  }

  return headers;
}

async function safeJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function extractRuntimeErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) {
    return fallback;
  }

  const error = body.error;
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  if (typeof body.message === 'string' && body.message.length > 0) {
    return body.message;
  }

  return fallback;
}

async function runtimeFetchJson(
  ctx: ToolPermissionContext,
  path: string,
  init?: RequestInit,
): Promise<RuntimeFetchResult> {
  const url = `${getRuntimeUrl()}${path}`;

  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        ...buildRuntimeHeaders(ctx),
        ...(init?.headers ? (init.headers as Record<string, string>) : {}),
      },
      signal: AbortSignal.timeout(TRACE_DIAGNOSIS_FETCH_TIMEOUT_MS),
    });
    const body = await safeJson(response);

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        body,
        error: {
          code: 'RUNTIME_ERROR',
          message: extractRuntimeErrorMessage(body, `Runtime returned HTTP ${response.status}`),
        },
      };
    }

    return {
      ok: true,
      status: response.status,
      body,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Runtime fetch failed for trace diagnosis', {
      path,
      projectId: ctx.projectId,
      error: message,
    });
    return {
      ok: false,
      status: 0,
      body: null,
      error: { code: 'RUNTIME_FETCH_ERROR', message },
    };
  }
}

function buildSessionListParams(
  resolved: ResolvedTraceDiagnosisInput,
  limit: number,
  offset = 0,
): string {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (offset > 0) {
    params.set('offset', String(offset));
  }
  if (resolved.status) {
    params.set('status', resolved.status);
  }
  if (resolved.channel) {
    params.set('channel', resolved.channel);
  }
  if (resolved.agentName) {
    params.set('agentName', resolved.agentName);
  }
  if (resolved.environment) {
    params.set('environment', resolved.environment);
  }
  if (resolved.disposition) {
    params.set('disposition', resolved.disposition);
  }
  if (resolved.mine) {
    params.set('mine', 'true');
  }
  if (resolved.timeRange?.from) {
    params.set('from', resolved.timeRange.from);
  }
  if (resolved.timeRange?.to) {
    params.set('to', resolved.timeRange.to);
  }
  return params.toString();
}

function defaultAggregateTimeRange(now = new Date()): ResolvedDiagnosisTimeRange {
  const from = new Date(now);
  from.setHours(from.getHours() - 24);
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    label: 'last 24 hours',
    source: 'relative',
  };
}

async function fetchSessionList(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
  limit = resolved.limit,
  offset = 0,
): Promise<SessionListFetchResult> {
  const query = buildSessionListParams(resolved, limit, offset);
  const response = await runtimeFetchJson(
    ctx,
    `/api/projects/${encodeURIComponent(ctx.projectId)}/sessions?${query}`,
  );

  if (!response.ok) {
    return {
      success: false,
      error: response.error ?? {
        code: 'SESSION_LIST_FAILED',
        message: 'Failed to fetch sessions from runtime',
      },
    };
  }

  if (!isRecord(response.body)) {
    return {
      success: false,
      error: { code: 'INVALID_RESPONSE', message: 'Runtime returned an invalid session list' },
    };
  }

  const sessions = safeArray(response.body.sessions)
    .map((session) => normalizeSessionSummary(session))
    .filter((session): session is DiagnosisSessionSummary => session !== null);

  return {
    success: true,
    sessions,
    total: safeNumber(response.body.total, sessions.length),
  };
}

async function fetchSessionInventory(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
  options?: { maxSessions?: number; pageSize?: number },
): Promise<
  | { success: true; inventory: DiagnosisSessionInventory }
  | { success: false; error: { code: string; message: string } }
> {
  const maxSessions = Math.max(1, options?.maxSessions ?? TRACE_DIAGNOSIS_MAX_SESSION_SCAN);
  const pageSize = Math.max(
    1,
    Math.min(
      options?.pageSize ?? TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
      TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
      maxSessions,
    ),
  );
  const sessions: DiagnosisSessionSummary[] = [];
  let total = 0;
  let offset = 0;

  while (sessions.length < maxSessions) {
    const remaining = maxSessions - sessions.length;
    const page = await fetchSessionList(ctx, resolved, Math.min(pageSize, remaining), offset);
    if (!page.success) {
      return page;
    }

    total = page.total;
    sessions.push(...page.sessions);

    if (page.sessions.length === 0) {
      break;
    }

    offset += page.sessions.length;
    if (offset >= page.total) {
      break;
    }
  }

  return {
    success: true,
    inventory: {
      sessions,
      total,
      scannedSessions: sessions.length,
      truncated: total > sessions.length,
    },
  };
}

function summarizeSessions(sessions: DiagnosisSessionSummary[]): SessionAggregateSummary {
  const statusCounts: Record<string, number> = {};
  let totalErrors = 0;
  let activeCount = 0;
  let erroredSessionCount = 0;
  let totalDurationMs = 0;
  let totalTokens = 0;
  let totalEstimatedCost = 0;
  let latestSessionId: string | null = sessions[0]?.id ?? null;
  let latestActivityAt: string | null =
    sessions[0]?.lastActivityAt ?? sessions[0]?.createdAt ?? null;
  let latestActivityMs = latestActivityAt ? Date.parse(latestActivityAt) : Number.NEGATIVE_INFINITY;
  const environments = new Set<string>();

  for (const session of sessions) {
    statusCounts[session.status] = (statusCounts[session.status] ?? 0) + 1;
    totalErrors += session.errorCount;
    totalDurationMs += session.durationMs;
    totalTokens += session.tokenCount;
    totalEstimatedCost += session.estimatedCost;
    if (session.status === 'active') {
      activeCount += 1;
    }
    if (session.errorCount > 0) {
      erroredSessionCount += 1;
    }

    environments.add(session.environment ?? 'unknown');

    const activityAt = session.lastActivityAt ?? session.createdAt;
    if (!activityAt) {
      continue;
    }

    const activityMs = Date.parse(activityAt);
    if (Number.isNaN(activityMs) || activityMs <= latestActivityMs) {
      continue;
    }

    latestActivityMs = activityMs;
    latestActivityAt = activityAt;
    latestSessionId = session.id;
  }

  return {
    sessionCount: sessions.length,
    activeCount,
    totalErrors,
    erroredSessionCount,
    errorRate: sessions.length > 0 ? erroredSessionCount / sessions.length : 0,
    totalDurationMs,
    avgDurationMs: sessions.length > 0 ? totalDurationMs / sessions.length : 0,
    totalTokens,
    totalEstimatedCost,
    statusCounts,
    latestSessionId,
    latestActivityAt,
    environments: Array.from(environments).sort(),
  };
}

function bucketSessionsByEnvironment(
  sessions: DiagnosisSessionSummary[],
): Map<string, DiagnosisSessionSummary[]> {
  const buckets = new Map<string, DiagnosisSessionSummary[]>();

  for (const session of sessions) {
    const environment = session.environment ?? 'unknown';
    const bucket = buckets.get(environment) ?? [];
    bucket.push(session);
    buckets.set(environment, bucket);
  }

  return buckets;
}

function buildEnvironmentBreakdown(
  sessions: DiagnosisSessionSummary[],
  sampleLimit: number,
): Array<{
  environment: string;
  summary: SessionAggregateSummary;
  sessions: DiagnosisSessionSummary[];
}> {
  const buckets = bucketSessionsByEnvironment(sessions);

  return Array.from(buckets.entries())
    .map(([environment, bucketSessions]) => ({
      environment,
      summary: summarizeSessions(bucketSessions),
      sessions: bucketSessions.slice(0, sampleLimit),
    }))
    .sort((left, right) => {
      if (right.summary.sessionCount !== left.summary.sessionCount) {
        return right.summary.sessionCount - left.summary.sessionCount;
      }
      return left.environment.localeCompare(right.environment);
    });
}

function buildEnvironmentComparison(params: {
  primaryEnvironment: string;
  secondaryEnvironment: string;
  primaryInventory: DiagnosisSessionInventory;
  secondaryInventory: DiagnosisSessionInventory;
  sampleLimit: number;
}) {
  const primarySummary = summarizeSessions(params.primaryInventory.sessions);
  const secondarySummary = summarizeSessions(params.secondaryInventory.sessions);

  return {
    primaryEnvironment: params.primaryEnvironment,
    secondaryEnvironment: params.secondaryEnvironment,
    primary: {
      summary: primarySummary,
      sessions: params.primaryInventory.sessions.slice(0, params.sampleLimit),
      matchedSessions: params.primaryInventory.total,
      scannedSessions: params.primaryInventory.scannedSessions,
      truncated: params.primaryInventory.truncated,
    },
    secondary: {
      summary: secondarySummary,
      sessions: params.secondaryInventory.sessions.slice(0, params.sampleLimit),
      matchedSessions: params.secondaryInventory.total,
      scannedSessions: params.secondaryInventory.scannedSessions,
      truncated: params.secondaryInventory.truncated,
    },
    delta: {
      sessionCount: primarySummary.sessionCount - secondarySummary.sessionCount,
      activeCount: primarySummary.activeCount - secondarySummary.activeCount,
      totalErrors: primarySummary.totalErrors - secondarySummary.totalErrors,
      erroredSessionCount:
        primarySummary.erroredSessionCount - secondarySummary.erroredSessionCount,
      errorRate: primarySummary.errorRate - secondarySummary.errorRate,
      avgDurationMs: primarySummary.avgDurationMs - secondarySummary.avgDurationMs,
      totalTokens: primarySummary.totalTokens - secondarySummary.totalTokens,
      totalEstimatedCost: primarySummary.totalEstimatedCost - secondarySummary.totalEstimatedCost,
    },
  };
}

function buildTimeRangeComparison(params: {
  primaryTimeRange: ResolvedDiagnosisTimeRange;
  secondaryTimeRange: ResolvedDiagnosisTimeRange;
  primaryInventory: DiagnosisSessionInventory;
  secondaryInventory: DiagnosisSessionInventory;
  sampleLimit: number;
}) {
  const primarySummary = summarizeSessions(params.primaryInventory.sessions);
  const secondarySummary = summarizeSessions(params.secondaryInventory.sessions);

  return {
    primaryTimeRange: params.primaryTimeRange,
    secondaryTimeRange: params.secondaryTimeRange,
    primary: {
      summary: primarySummary,
      sessions: params.primaryInventory.sessions.slice(0, params.sampleLimit),
      matchedSessions: params.primaryInventory.total,
      scannedSessions: params.primaryInventory.scannedSessions,
      truncated: params.primaryInventory.truncated,
    },
    secondary: {
      summary: secondarySummary,
      sessions: params.secondaryInventory.sessions.slice(0, params.sampleLimit),
      matchedSessions: params.secondaryInventory.total,
      scannedSessions: params.secondaryInventory.scannedSessions,
      truncated: params.secondaryInventory.truncated,
    },
    delta: {
      sessionCount: primarySummary.sessionCount - secondarySummary.sessionCount,
      activeCount: primarySummary.activeCount - secondarySummary.activeCount,
      totalErrors: primarySummary.totalErrors - secondarySummary.totalErrors,
      erroredSessionCount:
        primarySummary.erroredSessionCount - secondarySummary.erroredSessionCount,
      errorRate: primarySummary.errorRate - secondarySummary.errorRate,
      avgDurationMs: primarySummary.avgDurationMs - secondarySummary.avgDurationMs,
      totalTokens: primarySummary.totalTokens - secondarySummary.totalTokens,
      totalEstimatedCost: primarySummary.totalEstimatedCost - secondarySummary.totalEstimatedCost,
    },
  };
}

function shouldUseSessionListAggregation(resolved: ResolvedTraceDiagnosisInput): boolean {
  return Boolean(
    resolved.mine ||
    resolved.environment ||
    resolved.compareWithEnvironment ||
    resolved.compareTimeRange ||
    resolved.groupByEnvironment,
  );
}

function summarizeTraceEvents(traces: DiagnosisTraceEvent[]): Record<string, unknown> {
  const byType: Record<string, number> = {};
  const byAgent: Record<string, number> = {};
  let errorCount = 0;
  let latestError: DiagnosisTraceEvent | null = null;

  for (const trace of traces) {
    byType[trace.eventType] = (byType[trace.eventType] ?? 0) + 1;
    if (trace.agentName) {
      byAgent[trace.agentName] = (byAgent[trace.agentName] ?? 0) + 1;
    }
    if (trace.hasError) {
      errorCount += 1;
      latestError = trace;
    }
  }

  return {
    returnedCount: traces.length,
    errorCount,
    byType,
    byAgent,
    latestError,
  };
}

function buildFiltersApplied(
  resolved: ResolvedTraceDiagnosisInput,
  timeRange: ResolvedDiagnosisTimeRange | null,
): Record<string, unknown> {
  return {
    agentName: resolved.agentName ?? null,
    channel: resolved.channel ?? null,
    status: resolved.status ?? null,
    disposition: resolved.disposition ?? null,
    environment: resolved.environment ?? null,
    compareWithEnvironment: resolved.compareWithEnvironment ?? null,
    groupByEnvironment: resolved.groupByEnvironment ?? false,
    mine: resolved.mine ?? false,
    timeRange,
    compareTimeRange: resolved.compareTimeRange ?? null,
  };
}

function buildSessionInventoryPayload(
  inventory: DiagnosisSessionInventory,
  sampleLimit: number,
): {
  sessionSummary: SessionAggregateSummary;
  matchedSessions: number;
  scannedSessions: number;
  truncated: boolean;
  sessions: DiagnosisSessionSummary[];
} {
  return {
    sessionSummary: summarizeSessions(inventory.sessions),
    matchedSessions: inventory.total,
    scannedSessions: inventory.scannedSessions,
    truncated: inventory.truncated,
    sessions: inventory.sessions.slice(0, sampleLimit),
  };
}

async function resolvePrimarySession(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<
  | { success: true; data: ResolveSessionTargetResult }
  | {
      success: true;
      data: { requiresClarification: true; reason: string; candidates: DiagnosisSessionSummary[] };
    }
  | { success: false; error: { code: string; message: string } }
> {
  if (resolved.sessionId) {
    return {
      success: true,
      data: {
        sessionId: resolved.sessionId,
        source: 'explicit',
      },
    };
  }

  if (resolved.sessionSelector === 'current') {
    if (resolved.pageContextSessionId) {
      return {
        success: true,
        data: {
          sessionId: resolved.pageContextSessionId,
          source: 'page_context',
        },
      };
    }

    return {
      success: true,
      data: {
        requiresClarification: true,
        reason: 'CURRENT_SESSION_CONTEXT_REQUIRED',
        candidates: [],
      },
    };
  }

  const discoveryLimit = resolved.sessionSelector === 'recent' ? Math.max(resolved.limit, 5) : 5;
  const sessionList = await fetchSessionList(ctx, resolved, discoveryLimit);
  if (!sessionList.success) {
    return sessionList;
  }

  if (sessionList.sessions.length === 0) {
    return {
      success: false,
      error: { code: 'SESSION_NOT_FOUND', message: 'No matching sessions were found' },
    };
  }

  if (resolved.sessionSelector === 'last') {
    return {
      success: true,
      data: {
        sessionId: sessionList.sessions[0]!.id,
        source: 'last',
        candidateSessions: sessionList.sessions,
      },
    };
  }

  if (sessionList.sessions.length === 1) {
    return {
      success: true,
      data: {
        sessionId: sessionList.sessions[0]!.id,
        source: 'discovered_single',
        candidateSessions: sessionList.sessions,
      },
    };
  }

  return {
    success: true,
    data: {
      requiresClarification: true,
      reason: 'MULTIPLE_MATCHING_SESSIONS',
      candidates: sessionList.sessions.slice(0, 5),
    },
  };
}

async function loadDeepDive(
  ctx: ToolPermissionContext,
  sessionId: string,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const traceParams = new URLSearchParams();
  traceParams.set('limit', String(Math.max(resolved.limit, TRACE_DIAGNOSIS_DEFAULT_TRACE_LIMIT)));
  if (resolved.traceTypes.length > 0) {
    traceParams.set('types', resolved.traceTypes.join(','));
  }

  const [detailResult, traceResult, diagnosticResult] = await Promise.all([
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(sessionId)}?includeTraces=false`,
    ),
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/sessions/${encodeURIComponent(sessionId)}/traces?${traceParams.toString()}`,
    ),
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/diagnostics/sessions/${encodeURIComponent(sessionId)}?depth=standard`,
    ),
  ]);

  if (!detailResult.ok) {
    return {
      success: false,
      error:
        detailResult.error ??
        ({ code: 'SESSION_DETAIL_FAILED', message: 'Failed to fetch session detail' } as const),
    };
  }

  const detail = normalizeSessionDetail(detailResult.body);
  if (!detail) {
    return {
      success: false,
      error: { code: 'INVALID_RESPONSE', message: 'Runtime returned an invalid session detail' },
    };
  }

  const traceBody = isRecord(traceResult.body) ? traceResult.body : null;
  const traces = safeArray(traceBody?.traces)
    .map((trace) => normalizeTraceEvent(trace))
    .filter((trace): trace is DiagnosisTraceEvent => trace !== null);
  const diagnostics =
    diagnosticResult.ok && isRecord(diagnosticResult.body) && isRecord(diagnosticResult.body.data)
      ? diagnosticResult.body.data
      : null;

  return {
    success: true,
    data: {
      sessionId,
      session: detail,
      traces,
      traceTotal: traceBody ? safeNumber(traceBody.total, traces.length) : traces.length,
      traceMeta: traceBody?._meta ?? null,
      traceOverview: summarizeTraceEvents(traces),
      diagnostics,
    },
  };
}

async function runDiscover(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const sessionList = await fetchSessionList(ctx, resolved, resolved.limit);
  if (!sessionList.success) {
    return {
      success: false,
      error: sessionList.error,
    };
  }

  return {
    success: true,
    data: {
      action: 'discover',
      filtersApplied: buildFiltersApplied(resolved, resolved.timeRange ?? null),
      total: sessionList.total,
      sessions: sessionList.sessions,
      summary: summarizeSessions(sessionList.sessions),
      environmentBreakdown: resolved.groupByEnvironment
        ? buildEnvironmentBreakdown(sessionList.sessions, resolved.limit)
        : null,
    },
  };
}

async function runDeepDive(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const target = await resolvePrimarySession(ctx, resolved);
  if (!target.success) {
    return target;
  }

  if ('requiresClarification' in target.data) {
    return {
      success: true,
      data: {
        action: 'deep_dive',
        requiresClarification: true,
        reason: target.data.reason,
        candidates: target.data.candidates,
      },
    };
  }

  const deepDive = await loadDeepDive(ctx, target.data.sessionId, resolved);
  if (!deepDive.success) {
    return deepDive;
  }

  return {
    success: true,
    data: {
      action: 'deep_dive',
      resolution: {
        sessionId: target.data.sessionId,
        source: target.data.source,
      },
      ...(isRecord(deepDive.data) ? deepDive.data : {}),
    },
  };
}

async function runAggregate(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const timeRange = resolved.timeRange ?? defaultAggregateTimeRange();
  if (shouldUseSessionListAggregation(resolved)) {
    if (resolved.compareWithEnvironment) {
      if (!resolved.environment) {
        return {
          success: true,
          data: {
            action: 'aggregate',
            requiresClarification: true,
            reason: 'PRIMARY_ENVIRONMENT_REQUIRED',
          },
        };
      }

      const [primaryInventoryResult, secondaryInventoryResult] = await Promise.all([
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.environment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.compareWithEnvironment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
      ]);
      if (!primaryInventoryResult.success) {
        return {
          success: false,
          error: primaryInventoryResult.error,
        };
      }
      if (!secondaryInventoryResult.success) {
        return {
          success: false,
          error: secondaryInventoryResult.error,
        };
      }

      return {
        success: true,
        data: {
          action: 'aggregate',
          source: 'session_list_fallback',
          timeRange,
          filtersApplied: buildFiltersApplied(resolved, timeRange),
          environmentComparison: buildEnvironmentComparison({
            primaryEnvironment: resolved.environment,
            secondaryEnvironment: resolved.compareWithEnvironment,
            primaryInventory: primaryInventoryResult.inventory,
            secondaryInventory: secondaryInventoryResult.inventory,
            sampleLimit: resolved.limit,
          }),
        },
      };
    }

    const inventoryResult = await fetchSessionInventory(
      ctx,
      { ...resolved, timeRange },
      {
        maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
        pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
      },
    );
    if (!inventoryResult.success) {
      return {
        success: false,
        error: inventoryResult.error,
      };
    }

    const inventoryPayload = buildSessionInventoryPayload(
      inventoryResult.inventory,
      resolved.limit,
    );

    return {
      success: true,
      data: {
        action: 'aggregate',
        source: 'session_list_fallback',
        timeRange,
        filtersApplied: buildFiltersApplied(resolved, timeRange),
        ...inventoryPayload,
        totalDurationMs: inventoryPayload.sessionSummary.totalDurationMs,
        totalTokens: inventoryPayload.sessionSummary.totalTokens,
        totalEstimatedCost: inventoryPayload.sessionSummary.totalEstimatedCost,
        environmentBreakdown: resolved.groupByEnvironment
          ? buildEnvironmentBreakdown(inventoryResult.inventory.sessions, resolved.limit)
          : null,
      },
    };
  }

  const query = new URLSearchParams({
    from: timeRange.from,
    to: timeRange.to,
  });

  const [sessionMetrics, eventCounts, costBreakdown, agentMetrics] = await Promise.all([
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/session-metrics?${query.toString()}`,
    ),
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/event-counts?${query.toString()}`,
    ),
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/cost-breakdown?${query.toString()}`,
    ),
    resolved.agentName
      ? runtimeFetchJson(
          ctx,
          `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/agents/${encodeURIComponent(resolved.agentName)}?${query.toString()}`,
        )
      : Promise.resolve({ ok: true, status: 200, body: null } satisfies RuntimeFetchResult),
  ]);

  if (!sessionMetrics.ok) {
    return {
      success: false,
      error:
        sessionMetrics.status === 403
          ? {
              code: 'ANALYTICS_ACCESS_REQUIRED',
              message:
                'Project-wide aggregate diagnosis requires analytics access for this project.',
            }
          : (sessionMetrics.error ??
            ({ code: 'AGGREGATE_FAILED', message: 'Failed to fetch session metrics' } as const)),
    };
  }

  return {
    success: true,
    data: {
      action: 'aggregate',
      timeRange,
      filtersApplied: buildFiltersApplied(resolved, timeRange),
      sessionMetrics: isRecord(sessionMetrics.body) ? (sessionMetrics.body.data ?? null) : null,
      eventCounts: isRecord(eventCounts.body) ? (eventCounts.body.data ?? null) : null,
      costBreakdown: isRecord(costBreakdown.body) ? (costBreakdown.body.data ?? null) : null,
      agentMetrics:
        resolved.agentName && isRecord(agentMetrics.body) ? (agentMetrics.body.data ?? null) : null,
    },
  };
}

async function runErrors(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const timeRange = resolved.timeRange ?? defaultAggregateTimeRange();
  if (shouldUseSessionListAggregation(resolved)) {
    if (resolved.compareWithEnvironment) {
      if (!resolved.environment) {
        return {
          success: true,
          data: {
            action: 'errors',
            requiresClarification: true,
            reason: 'PRIMARY_ENVIRONMENT_REQUIRED',
          },
        };
      }

      const [primaryInventoryResult, secondaryInventoryResult] = await Promise.all([
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.environment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.compareWithEnvironment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
      ]);
      if (!primaryInventoryResult.success) {
        return {
          success: false,
          error: primaryInventoryResult.error,
        };
      }
      if (!secondaryInventoryResult.success) {
        return {
          success: false,
          error: secondaryInventoryResult.error,
        };
      }

      return {
        success: true,
        data: {
          action: 'errors',
          source: 'session_list_fallback',
          timeRange,
          filtersApplied: buildFiltersApplied(resolved, timeRange),
          environmentComparison: buildErrorEnvironmentComparison({
            primaryEnvironment: resolved.environment,
            secondaryEnvironment: resolved.compareWithEnvironment,
            primaryInventory: primaryInventoryResult.inventory,
            secondaryInventory: secondaryInventoryResult.inventory,
            sampleLimit: resolved.limit,
          }),
        },
      };
    }

    const inventoryResult = await fetchSessionInventory(
      ctx,
      { ...resolved, timeRange },
      {
        maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
        pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
      },
    );
    if (!inventoryResult.success) {
      return {
        success: false,
        error: inventoryResult.error,
      };
    }

    const inventoryPayload = buildSessionInventoryPayload(
      inventoryResult.inventory,
      resolved.limit,
    );
    const errorSummary = summarizeErroredSessions(
      inventoryResult.inventory.sessions,
      resolved.limit,
    );

    return {
      success: true,
      data: {
        action: 'errors',
        source: 'session_list_fallback',
        timeRange,
        filtersApplied: buildFiltersApplied(resolved, timeRange),
        ...inventoryPayload,
        totalErrors: errorSummary.totalErrors,
        erroredSessionCount: errorSummary.erroredSessionCount,
        sessionsWithErrors: errorSummary.sessionsWithErrors,
        summary: inventoryPayload.sessionSummary,
        errorSummary: {
          totalErrors: errorSummary.totalErrors,
          erroredSessionCount: errorSummary.erroredSessionCount,
          errorRate: inventoryPayload.sessionSummary.errorRate,
        },
        environmentBreakdown: resolved.groupByEnvironment
          ? buildErrorEnvironmentBreakdown(inventoryResult.inventory.sessions, resolved.limit)
          : null,
      },
    };
  }

  const eventsQuery = new URLSearchParams({
    from: timeRange.from,
    to: timeRange.to,
    hasError: 'true',
    limit: String(resolved.limit),
  });
  if (resolved.agentName) {
    eventsQuery.set('agentName', resolved.agentName);
  }

  const aggregateBody = {
    timeRange: {
      from: timeRange.from,
      to: timeRange.to,
    },
    groupBy: ['event_type', 'agent_name'],
    metrics: ['count'],
    filters: {
      hasError: true,
    },
  };

  const [eventsResult, aggregateResult] = await Promise.all([
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/events?${eventsQuery.toString()}`,
    ),
    runtimeFetchJson(
      ctx,
      `/api/projects/${encodeURIComponent(ctx.projectId)}/analytics/aggregate`,
      {
        method: 'POST',
        body: JSON.stringify(aggregateBody),
      },
    ),
  ]);

  if (!eventsResult.ok) {
    return {
      success: false,
      error:
        eventsResult.status === 403
          ? {
              code: 'ANALYTICS_ACCESS_REQUIRED',
              message: 'Project-wide error diagnosis requires analytics access for this project.',
            }
          : (eventsResult.error ??
            ({ code: 'ERROR_QUERY_FAILED', message: 'Failed to fetch error events' } as const)),
    };
  }

  const eventsBody = isRecord(eventsResult.body) ? eventsResult.body : {};
  const eventsData = isRecord(eventsBody.data) ? eventsBody.data : {};
  const events = safeArray(eventsData.events)
    .map((event) => normalizeTraceEvent(event))
    .filter((event): event is DiagnosisTraceEvent => event !== null);

  return {
    success: true,
    data: {
      action: 'errors',
      timeRange,
      filtersApplied: buildFiltersApplied(resolved, timeRange),
      totalErrors: safeNumber(eventsData.total, events.length),
      hasMore: eventsData.hasMore === true,
      recentErrors: events,
      breakdown:
        !resolved.agentName && aggregateResult.ok && isRecord(aggregateResult.body)
          ? (aggregateResult.body.data ?? null)
          : null,
    },
  };
}

async function runCompare(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const timeRange = resolved.timeRange ?? defaultAggregateTimeRange();
  const hasSessionScopedCompare = Boolean(
    resolved.sessionId || resolved.compareWithSessionId || resolved.sessionSelector,
  );

  if (resolved.compareTimeRange && !hasSessionScopedCompare && !resolved.compareWithEnvironment) {
    const [primaryInventoryResult, secondaryInventoryResult] = await Promise.all([
      fetchSessionInventory(
        ctx,
        {
          ...resolved,
          timeRange,
          compareTimeRange: undefined,
          groupByEnvironment: false,
        },
        {
          maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
          pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
        },
      ),
      fetchSessionInventory(
        ctx,
        {
          ...resolved,
          timeRange: resolved.compareTimeRange,
          compareTimeRange: undefined,
          groupByEnvironment: false,
        },
        {
          maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
          pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
        },
      ),
    ]);
    if (!primaryInventoryResult.success) {
      return {
        success: false,
        error: primaryInventoryResult.error,
      };
    }
    if (!secondaryInventoryResult.success) {
      return {
        success: false,
        error: secondaryInventoryResult.error,
      };
    }

    return {
      success: true,
      data: {
        action: 'compare',
        compareType: 'time_range',
        source: 'session_list_fallback',
        timeRange,
        compareTimeRange: resolved.compareTimeRange,
        filtersApplied: buildFiltersApplied(resolved, timeRange),
        timeRangeComparison: buildTimeRangeComparison({
          primaryTimeRange: timeRange,
          secondaryTimeRange: resolved.compareTimeRange,
          primaryInventory: primaryInventoryResult.inventory,
          secondaryInventory: secondaryInventoryResult.inventory,
          sampleLimit: resolved.limit,
        }),
      },
    };
  }

  if (resolved.compareWithEnvironment) {
    if (!resolved.environment) {
      return {
        success: true,
        data: {
          action: 'compare',
          requiresClarification: true,
          reason: 'PRIMARY_ENVIRONMENT_REQUIRED',
        },
      };
    }

    if (!hasSessionScopedCompare) {
      const [primaryInventoryResult, secondaryInventoryResult] = await Promise.all([
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.environment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
        fetchSessionInventory(
          ctx,
          {
            ...resolved,
            timeRange,
            environment: resolved.compareWithEnvironment,
            compareWithEnvironment: undefined,
            groupByEnvironment: false,
          },
          {
            maxSessions: TRACE_DIAGNOSIS_MAX_SESSION_SCAN,
            pageSize: TRACE_DIAGNOSIS_SESSION_PAGE_SIZE,
          },
        ),
      ]);
      if (!primaryInventoryResult.success) {
        return {
          success: false,
          error: primaryInventoryResult.error,
        };
      }
      if (!secondaryInventoryResult.success) {
        return {
          success: false,
          error: secondaryInventoryResult.error,
        };
      }

      return {
        success: true,
        data: {
          action: 'compare',
          compareType: 'environment',
          source: 'session_list_fallback',
          timeRange,
          filtersApplied: buildFiltersApplied(resolved, timeRange),
          environmentComparison: buildEnvironmentComparison({
            primaryEnvironment: resolved.environment,
            secondaryEnvironment: resolved.compareWithEnvironment,
            primaryInventory: primaryInventoryResult.inventory,
            secondaryInventory: secondaryInventoryResult.inventory,
            sampleLimit: resolved.limit,
          }),
        },
      };
    }

    const primaryResolved: ResolvedTraceDiagnosisInput = {
      ...resolved,
      timeRange,
      compareWithEnvironment: undefined,
    };
    const secondaryResolved: ResolvedTraceDiagnosisInput = {
      ...resolved,
      timeRange,
      environment: resolved.compareWithEnvironment,
      compareWithEnvironment: undefined,
      compareWithSessionId: undefined,
      ...(resolved.compareWithSessionId ? { sessionId: resolved.compareWithSessionId } : {}),
    };

    const firstTarget = await resolvePrimarySession(ctx, primaryResolved);
    if (!firstTarget.success) {
      return firstTarget;
    }
    if ('requiresClarification' in firstTarget.data) {
      return {
        success: true,
        data: {
          action: 'compare',
          requiresClarification: true,
          reason: firstTarget.data.reason,
          candidates: firstTarget.data.candidates,
        },
      };
    }

    const secondTarget = await resolvePrimarySession(ctx, secondaryResolved);
    if (!secondTarget.success) {
      return secondTarget;
    }
    if ('requiresClarification' in secondTarget.data) {
      return {
        success: true,
        data: {
          action: 'compare',
          requiresClarification: true,
          reason: secondTarget.data.reason,
          candidates: secondTarget.data.candidates,
        },
      };
    }

    const [primary, secondary] = await Promise.all([
      loadDeepDive(ctx, firstTarget.data.sessionId, primaryResolved),
      loadDeepDive(ctx, secondTarget.data.sessionId, secondaryResolved),
    ]);
    if (!primary.success) {
      return primary;
    }
    if (!secondary.success) {
      return secondary;
    }

    const primaryData = isRecord(primary.data) ? primary.data : {};
    const secondaryData = isRecord(secondary.data) ? secondary.data : {};
    const primarySession = isRecord(primaryData.session) ? primaryData.session : {};
    const secondarySession = isRecord(secondaryData.session) ? secondaryData.session : {};

    return {
      success: true,
      data: {
        action: 'compare',
        compareType: 'session',
        timeRange,
        filtersApplied: buildFiltersApplied(resolved, timeRange),
        primaryEnvironment: resolved.environment,
        secondaryEnvironment: resolved.compareWithEnvironment,
        primary: primaryData,
        secondary: secondaryData,
        summary: {
          sameAgent:
            safeString(primarySession.agentName) !== undefined &&
            primarySession.agentName === secondarySession.agentName,
          sameStatus:
            safeString(primarySession.status) !== undefined &&
            primarySession.status === secondarySession.status,
          durationDeltaMs:
            safeNumber(primarySession.durationMs) - safeNumber(secondarySession.durationMs),
          errorDelta:
            safeNumber(primarySession.errorCount) - safeNumber(secondarySession.errorCount),
          tokenDelta:
            safeNumber(primarySession.tokenCount) - safeNumber(secondarySession.tokenCount),
        },
      },
    };
  }

  const firstTarget = await resolvePrimarySession(ctx, resolved);
  if (!firstTarget.success) {
    return firstTarget;
  }
  if ('requiresClarification' in firstTarget.data) {
    return {
      success: true,
      data: {
        action: 'compare',
        requiresClarification: true,
        reason: firstTarget.data.reason,
        candidates: firstTarget.data.candidates,
      },
    };
  }

  const primarySessionId = firstTarget.data.sessionId;
  let compareSessionId = resolved.compareWithSessionId;
  if (!compareSessionId) {
    const fallbackDiscovery = await fetchSessionList(ctx, resolved, 2);
    if (!fallbackDiscovery.success) {
      return fallbackDiscovery;
    }
    compareSessionId = fallbackDiscovery.sessions.find(
      (session) => session.id !== primarySessionId,
    )?.id;
  }

  if (!compareSessionId) {
    return {
      success: true,
      data: {
        action: 'compare',
        requiresClarification: true,
        reason: 'SECOND_SESSION_REQUIRED',
        candidates: firstTarget.data.candidateSessions ?? [],
      },
    };
  }

  const [primary, secondary] = await Promise.all([
    loadDeepDive(ctx, primarySessionId, resolved),
    loadDeepDive(ctx, compareSessionId, resolved),
  ]);

  if (!primary.success) {
    return primary;
  }
  if (!secondary.success) {
    return secondary;
  }

  const primaryData = isRecord(primary.data) ? primary.data : {};
  const secondaryData = isRecord(secondary.data) ? secondary.data : {};
  const primarySession = isRecord(primaryData.session) ? primaryData.session : {};
  const secondarySession = isRecord(secondaryData.session) ? secondaryData.session : {};

  return {
    success: true,
    data: {
      action: 'compare',
      compareType: 'session',
      timeRange: resolved.timeRange ?? null,
      filtersApplied: buildFiltersApplied(resolved, resolved.timeRange ?? null),
      primary: primaryData,
      secondary: secondaryData,
      summary: {
        sameAgent:
          safeString(primarySession.agentName) !== undefined &&
          primarySession.agentName === secondarySession.agentName,
        sameStatus:
          safeString(primarySession.status) !== undefined &&
          primarySession.status === secondarySession.status,
        durationDeltaMs:
          safeNumber(primarySession.durationMs) - safeNumber(secondarySession.durationMs),
        errorDelta: safeNumber(primarySession.errorCount) - safeNumber(secondarySession.errorCount),
        tokenDelta: safeNumber(primarySession.tokenCount) - safeNumber(secondarySession.tokenCount),
      },
    },
  };
}

function summarizeErroredSessions(
  sessions: DiagnosisSessionSummary[],
  sampleLimit: number,
): {
  totalErrors: number;
  erroredSessionCount: number;
  sessionsWithErrors: DiagnosisSessionSummary[];
} {
  const sessionsWithErrors = sessions.filter((session) => session.errorCount > 0);

  return {
    totalErrors: sessionsWithErrors.reduce((sum, session) => sum + session.errorCount, 0),
    erroredSessionCount: sessionsWithErrors.length,
    sessionsWithErrors: sessionsWithErrors.slice(0, sampleLimit),
  };
}

function buildErrorEnvironmentBreakdown(
  sessions: DiagnosisSessionSummary[],
  sampleLimit: number,
): Array<{
  environment: string;
  summary: SessionAggregateSummary;
  totalErrors: number;
  erroredSessionCount: number;
  sessionsWithErrors: DiagnosisSessionSummary[];
}> {
  const buckets = bucketSessionsByEnvironment(sessions);

  return Array.from(buckets.entries())
    .map(([environment, bucketSessions]) => {
      const errorSummary = summarizeErroredSessions(bucketSessions, sampleLimit);
      return {
        environment,
        summary: summarizeSessions(bucketSessions),
        totalErrors: errorSummary.totalErrors,
        erroredSessionCount: errorSummary.erroredSessionCount,
        sessionsWithErrors: errorSummary.sessionsWithErrors,
      };
    })
    .sort((left, right) => {
      if (right.summary.sessionCount !== left.summary.sessionCount) {
        return right.summary.sessionCount - left.summary.sessionCount;
      }
      return left.environment.localeCompare(right.environment);
    });
}

function buildErrorEnvironmentComparison(params: {
  primaryEnvironment: string;
  secondaryEnvironment: string;
  primaryInventory: DiagnosisSessionInventory;
  secondaryInventory: DiagnosisSessionInventory;
  sampleLimit: number;
}) {
  const primarySummary = summarizeSessions(params.primaryInventory.sessions);
  const secondarySummary = summarizeSessions(params.secondaryInventory.sessions);
  const primaryErrors = summarizeErroredSessions(
    params.primaryInventory.sessions,
    params.sampleLimit,
  );
  const secondaryErrors = summarizeErroredSessions(
    params.secondaryInventory.sessions,
    params.sampleLimit,
  );

  return {
    primaryEnvironment: params.primaryEnvironment,
    secondaryEnvironment: params.secondaryEnvironment,
    primary: {
      summary: primarySummary,
      ...primaryErrors,
      matchedSessions: params.primaryInventory.total,
      scannedSessions: params.primaryInventory.scannedSessions,
      truncated: params.primaryInventory.truncated,
    },
    secondary: {
      summary: secondarySummary,
      ...secondaryErrors,
      matchedSessions: params.secondaryInventory.total,
      scannedSessions: params.secondaryInventory.scannedSessions,
      truncated: params.secondaryInventory.truncated,
    },
    delta: {
      totalErrors: primaryErrors.totalErrors - secondaryErrors.totalErrors,
      erroredSessionCount: primaryErrors.erroredSessionCount - secondaryErrors.erroredSessionCount,
      errorRate: primarySummary.errorRate - secondarySummary.errorRate,
      avgDurationMs: primarySummary.avgDurationMs - secondarySummary.avgDurationMs,
    },
  };
}

async function runExplain(
  ctx: ToolPermissionContext,
  resolved: ResolvedTraceDiagnosisInput,
): Promise<TraceDiagnosisResult> {
  const deepDive = await runDeepDive(ctx, resolved);
  if (!deepDive.success) {
    return deepDive;
  }

  const payload = isRecord(deepDive.data) ? deepDive.data : {};
  if (payload.requiresClarification === true) {
    return deepDive;
  }

  const traces = safeArray(payload.traces)
    .map((trace) => normalizeTraceEvent(trace))
    .filter((trace): trace is DiagnosisTraceEvent => trace !== null);

  const focusTrace =
    (resolved.spanId
      ? traces.find((trace) => trace.spanId === resolved.spanId || trace.id === resolved.spanId)
      : undefined) ??
    traces.find((trace) => trace.hasError) ??
    traces.at(-1) ??
    null;

  const relatedSpanEvents =
    focusTrace?.spanId && focusTrace.spanId.length > 0
      ? traces.filter((trace) => trace.spanId === focusTrace.spanId)
      : focusTrace
        ? [focusTrace]
        : [];

  return {
    success: true,
    data: {
      action: 'explain',
      ...payload,
      focusTrace,
      relatedSpanEvents,
    },
  };
}

export async function executeTraceDiagnosis(
  input: TraceDiagnosisInputShape,
  ctx: ToolPermissionContext,
  env?: TraceDiagnosisEnv,
): Promise<TraceDiagnosisResult> {
  const permission = await checkToolPermission('trace_diagnosis', input.action, ctx);
  if (!permission.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: permission.error ?? 'Permission denied' },
    };
  }

  const resolved = resolveTraceDiagnosisInput(input, env?.pageContext);

  switch (resolved.action) {
    case 'discover':
      return runDiscover(ctx, resolved);
    case 'deep_dive':
      return runDeepDive(ctx, resolved);
    case 'aggregate':
      return runAggregate(ctx, resolved);
    case 'errors':
      return runErrors(ctx, resolved);
    case 'compare':
      return runCompare(ctx, resolved);
    case 'explain':
      return runExplain(ctx, resolved);
    default:
      return {
        success: false,
        error: { code: 'INVALID_ACTION', message: `Unsupported action: ${resolved.action}` },
      };
  }
}
