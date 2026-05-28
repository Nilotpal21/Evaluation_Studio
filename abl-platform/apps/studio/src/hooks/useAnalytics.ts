/**
 * useAnalytics Hooks
 *
 * SWR hooks for the analytics API endpoints.
 * All data fetched via the Studio proxy at /api/runtime/analytics.
 */

import useSWR from 'swr';
import { useAuthStore } from '../store/auth-store';
import { apiFetch } from '../lib/api-client';
import type { SessionListItem } from '../types';

// =============================================================================
// TYPES
// =============================================================================

const ANALYTICS_TENANT_USAGE_PATH = '/api/analytics/tenant-usage';

export interface TimeRange {
  from: string; // ISO 8601
  to: string;
}

export interface EventCountItem {
  key: string;
  count: number;
  errorCount: number;
}

export interface EventCountsResponse {
  success: boolean;
  data: { counts: EventCountItem[] };
}

export interface SessionMetricsResponse {
  success: boolean;
  data: {
    totalSessions: number;
    completedSessions: number;
    completionRate: number;
    avgDurationMs: number;
    avgCost: number;
  };
}

export interface CostBreakdownItem {
  model: string;
  provider: string;
  callCount: number;
  totalTokens: number;
  totalCost: number;
}

export interface CostBreakdownResponse {
  success: boolean;
  data: CostBreakdownItem[];
}

export interface AggregateResponse {
  success: boolean;
  data: { buckets: Record<string, unknown>[] };
}

export interface EventsResponse {
  success: boolean;
  data: {
    events: Record<string, unknown>[];
    total: number;
    hasMore: boolean;
  };
}

export interface AnalyticsSessionListItem extends SessionListItem {
  channelType?: string;
  inputTokens?: number;
  outputTokens?: number;
  source?: 'clickhouse';
}

export interface AnalyticsSessionsResponse {
  success: boolean;
  data: {
    sessions: AnalyticsSessionListItem[];
    total: number;
    limit: number;
    offset: number;
  };
}

export interface AnalyticsGenerationItem {
  id: string;
  model: string;
  name: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  latencyMs: number;
  cost: number;
  timestamp: string;
  sessionId: string;
}

export interface AnalyticsGenerationsResponse {
  success: boolean;
  data: {
    generations: AnalyticsGenerationItem[];
    total: number;
    limit: number;
    offset: number;
  };
}

export interface AnalyticsFlushStatusResponse {
  success: boolean;
  data: {
    liveSessionCount: number;
    visibleLiveSessionCount: number;
    unflushedLiveSessionCount: number;
    pendingSessionIds: string[];
    lastCheckedAt: string;
  };
}

// =============================================================================
// HELPERS
// =============================================================================

function buildQueryString(
  projectId: string,
  endpoint: string,
  timeRange: TimeRange,
  extra?: Record<string, string>,
): string {
  const params = new URLSearchParams({
    projectId,
    endpoint,
    from: timeRange.from,
    to: timeRange.to,
  });
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v) params.set(k, v);
    }
  }
  return `/api/runtime/analytics?${params.toString()}`;
}

// =============================================================================
// HOOKS
// =============================================================================

const SWR_OPTIONS = {
  refreshInterval: 30_000,
  keepPreviousData: true,
};

export function useEventCounts(projectId: string | null, timeRange: TimeRange) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'event-counts', timeRange) : null;

  const { data, error, isLoading } = useSWR<EventCountsResponse>(key, SWR_OPTIONS);

  return {
    counts: data?.data?.counts ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useSessionMetrics(projectId: string | null, timeRange: TimeRange) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'session-metrics', timeRange) : null;

  const { data, error, isLoading } = useSWR<SessionMetricsResponse>(key, SWR_OPTIONS);

  return {
    metrics: data?.data ?? null,
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useCostBreakdown(projectId: string | null, timeRange: TimeRange) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'cost-breakdown', timeRange) : null;

  const { data, error, isLoading } = useSWR<CostBreakdownResponse>(key, SWR_OPTIONS);

  return {
    breakdown: data?.data ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useAnalyticsEvents(
  projectId: string | null,
  timeRange: TimeRange,
  options?: { hasError?: boolean; category?: string; limit?: number },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const extra: Record<string, string> = {};
  if (options?.hasError) extra.hasError = 'true';
  if (options?.category) extra.category = options.category;
  if (options?.limit) extra.limit = String(options.limit);

  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'events', timeRange, extra) : null;

  const { data, error, isLoading } = useSWR<EventsResponse>(key, SWR_OPTIONS);

  return {
    events: data?.data?.events ?? [],
    total: data?.data?.total ?? 0,
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useAnalyticsSessions(
  projectId: string | null,
  timeRange: TimeRange,
  options?: { limit?: number; offset?: number; knownSource?: string },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const extra: Record<string, string> = {};
  if (options?.limit) extra.limit = String(options.limit);
  if (options?.offset) extra.offset = String(options.offset);
  if (options?.knownSource) extra.knownSource = options.knownSource;

  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'sessions', timeRange, extra) : null;

  const { data, error, isLoading } = useSWR<AnalyticsSessionsResponse>(key, SWR_OPTIONS);

  return {
    sessions: data?.data?.sessions ?? [],
    total: data?.data?.total ?? 0,
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useAnalyticsGenerations(
  projectId: string | null,
  timeRange: TimeRange,
  options?: { sessionId?: string; limit?: number; offset?: number },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const extra: Record<string, string> = {};
  if (options?.sessionId) extra.sessionId = options.sessionId;
  if (options?.limit) extra.limit = String(options.limit);
  if (options?.offset) extra.offset = String(options.offset);

  const key =
    isAuthenticated && projectId
      ? buildQueryString(projectId, 'generations', timeRange, extra)
      : null;

  const { data, error, isLoading } = useSWR<AnalyticsGenerationsResponse>(key, SWR_OPTIONS);

  return {
    generations: data?.data?.generations ?? [],
    total: data?.data?.total ?? 0,
    isLoading,
    error: error ? String(error) : null,
  };
}

export function useAnalyticsFlushStatus(projectId: string | null) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const key =
    isAuthenticated && projectId
      ? `/api/runtime/analytics?${new URLSearchParams({
          projectId,
          endpoint: 'flush-status',
        }).toString()}`
      : null;

  const { data, error, isLoading } = useSWR<AnalyticsFlushStatusResponse>(key, {
    ...SWR_OPTIONS,
    refreshInterval: 15_000,
  });

  return {
    liveSessionCount: data?.data?.liveSessionCount ?? 0,
    visibleLiveSessionCount: data?.data?.visibleLiveSessionCount ?? 0,
    unflushedLiveSessionCount: data?.data?.unflushedLiveSessionCount ?? 0,
    pendingSessionIds: data?.data?.pendingSessionIds ?? [],
    lastCheckedAt: data?.data?.lastCheckedAt ?? null,
    isLoading,
    error: error ? String(error) : null,
  };
}

// =============================================================================
// AGGREGATE METRICS HOOK (uses GET /metrics endpoint)
// =============================================================================

/**
 * SWR hook for aggregate metrics — replaces the old fetchAggregate POST.
 * Uses the runtime's GET /metrics endpoint with query params.
 */
export function useAggregateMetrics(
  projectId: string | null,
  timeRange: TimeRange,
  options: {
    groupBy: string[];
    metrics: string[];
    category?: string;
  },
) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const extra: Record<string, string> = {};
  if (options.groupBy.length > 0) extra.groupBy = options.groupBy.join(',');
  if (options.metrics.length > 0) extra.metrics = options.metrics.join(',');
  if (options.category) extra.category = options.category;

  const key =
    isAuthenticated && projectId ? buildQueryString(projectId, 'metrics', timeRange, extra) : null;

  const { data, error, isLoading } = useSWR<AggregateResponse>(key, SWR_OPTIONS);

  return {
    buckets: data?.data?.buckets ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

// =============================================================================
// TENANT USAGE HOOK (same data source as admin BillingPage — llm_metrics table)
// =============================================================================

interface TenantUsageSummary {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  avgLatencyMs: number;
}

interface TenantUsageBreakdown {
  modelId: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

interface TenantUsageResponse {
  success: boolean;
  summary: TenantUsageSummary;
  breakdown: TenantUsageBreakdown[];
  daily: { date: string; requests: number; totalTokens: number; estimatedCost: number }[];
  projects: { projectId: string; requests: number; totalTokens: number; estimatedCost: number }[];
}

/**
 * SWR hook for Studio analytics tenant usage metrics.
 *
 * This remains on the analytics-only tenant usage path and is intentionally
 * separate from the published billing report plane used by billing dashboards.
 */
export function useTenantUsageAnalytics(projectId: string | null, timeRange: TimeRange) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  const key =
    isAuthenticated && projectId
      ? (() => {
          const params = new URLSearchParams();
          params.set('startDate', timeRange.from);
          params.set('endDate', timeRange.to);
          params.set('projectId', projectId);
          return `${ANALYTICS_TENANT_USAGE_PATH}?${params.toString()}`;
        })()
      : null;

  const { data, error, isLoading } = useSWR<TenantUsageResponse>(key, SWR_OPTIONS);

  // Map to CostBreakdownItem format for compatibility with LLMPerformanceTab
  const breakdown: CostBreakdownItem[] = (data?.breakdown ?? []).map((b) => ({
    model: b.modelId,
    provider: b.provider,
    callCount: b.requests,
    totalTokens: b.totalTokens,
    totalCost: b.estimatedCost,
  }));

  return {
    summary: data?.summary ?? null,
    breakdown,
    daily: data?.daily ?? [],
    isLoading,
    error: error ? String(error) : null,
  };
}

export const useTenantUsage = useTenantUsageAnalytics;

// =============================================================================
// NON-HOOK FETCHERS (kept for backward compat, prefer useAggregateMetrics)
// =============================================================================

export async function fetchAggregate(
  projectId: string,
  body: {
    timeRange: { from: string; to: string };
    groupBy: string[];
    metrics: string[];
    filters?: Record<string, unknown>;
  },
): Promise<AggregateResponse> {
  const params = new URLSearchParams({ projectId, endpoint: 'aggregate' });
  const res = await apiFetch(`/api/runtime/analytics?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}
